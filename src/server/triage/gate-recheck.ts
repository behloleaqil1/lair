/**
 * Re-checks for a project whose gates run in its own gate system
 * (docs/configuration.md, "Re-checks for an existing gate system").
 *
 * Triage classifies each failed result; this decides whether the gate system
 * runs it again, and runs `triage.recheck.command` (an argv, no shell, with a
 * timeout), which only enqueues the run there:
 *
 * - infra (the container runtime was down, a run was killed, a machine
 *   dropped): `kinds.infra`, by default `same` (the same pipeline at the same
 *   commit);
 * - timeout: a test that failed with a timeout ("TimeoutException ... timed
 *   out after", "test timed out", ...), or triage's timeout-under-load rule
 *   when the result carried the machine's load: `kinds.timeout`, by default
 *   `failed_tests` (only the failed tests, on a quiet machine);
 * - flaky: `kinds.flaky`, by default `failed_tests`;
 * - any other code failure is real: it is never re-checked, and neither is a
 *   result that has one.
 *
 * The re-check's result comes back through the normal signed submit with
 * `recheckId` set to the original result's id. It passes: the failure is
 * resolved as infra or flaky, and the tests that timed out join the
 * flaky-test list. It fails the same way: one decision escalates it, and its
 * code causes go back to the author as a real failure. It fails differently:
 * a new failure, triaged on its own and re-checked from the same budget.
 *
 * Budget and safety: at most max_per_result re-checks per original result (a
 * chain of re-checks shares it); none sooner than cooldown_seconds after the
 * failure arrived; none while one for the same commit and pipeline is
 * pending; a queued one expires after expire_hours and is reported, never
 * retried; a command that fails or times out is reported, never retried.
 * Every placeholder value is validated, and one that is not valid refuses the
 * re-check.
 *
 * Restarts: every re-check is a store row. A waiting one runs on the next
 * tick; one whose command was running when the server stopped is kept as
 * queued (the command may have enqueued it) until its result or its expiry,
 * and its command never runs again.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { GateResult } from "../../shared/policy-types.js";
import type {
  ActionKind,
  ActionStatus,
  ClassifiedCause,
  FailureCause,
  GateRecheck,
  GateRecheckCause,
  GateRecheckKind,
  TestRef,
  TriageRecord,
  Verdict,
} from "../../shared/triage-types.js";
import type { CommandOutput, CommandRunner } from "../watchdog/probes.js";
import type { DecisionRequest } from "./adapters.js";
import { overallClass } from "./classifier.js";
import { FULL_SHA, type TriageSettings } from "./config.js";
import type { GateRecheckPlaceholder, GateRecheckSettings } from "./gate-recheck-config.js";
import { ANSWERABLE, type GateRecheckStore, type NewGateRecheck } from "./gate-recheck-store.js";
import type { GateEvidence } from "./parsers/index.js";
import type { Section } from "./service.js";
import { isAssertion } from "./signatures.js";
import type { TriageStore } from "./store.js";
import { clip } from "./text.js";

const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PIPELINE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:,=+-]{0,199}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A test id the command gets: letters, digits and . _ $ # : / - (a JUnit method's trailing "()" is dropped) */
export const SAFE_TEST = /^[A-Za-z0-9_$][A-Za-z0-9_.$#:/-]{0,299}$/;
/** A test that failed with a timeout (JUnit 4 and 5, Awaitility, jest, mocha, vitest) */
const TEST_TIMEOUT =
  /\b(?:TimeoutException|TestTimedOutException|ConditionTimeoutException)\b|\btimed out after\b|\btest timed out\b|\bexceeded timeout of\b|\btimeout of \d+ ?ms exceeded/i;
const OUTPUT_TAIL = 2000;

/** What a cause is for a re-check: one of the re-checked kinds, real (never re-checked) or ignored (pre-existing). */
export type CauseKind = GateRecheckCause | "real" | "ignore";

export interface GatePlan {
  /** What the failure waits for (its resolution); null when no re-check applies */
  text: string | null;
  /** Its code causes (test timeouts) go to the author only once the re-check is answered */
  holdRoute: boolean;
}

/** A result that answers a re-check, with the failure it re-checks. */
export interface GateLink {
  recheck: GateRecheck;
  origin: TriageRecord;
}

/**
 * link: it answers this re-check; plain: it names a re-check that can't take it (answered, refused, another run, another
 * commit): it is triaged as a plain gate result, with the note, and not re-checked.
 */
export type GateLinkResult = { kind: "link"; link: GateLink } | { kind: "plain"; note: string };

/** What the triage service lends this: its store, its queue and the actions of the other classes. */
export interface GateRecheckHost {
  project: string;
  config: ProjectConfig;
  settings: TriageSettings;
  store: TriageStore;
  runner: CommandRunner;
  now(): number;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  commit<T>(fn: (s: Section) => T): T;
  action(
    target: { recordId?: string },
    kind: ActionKind,
    status: ActionStatus,
    detail: string,
    argv?: string[],
    output?: string,
    actor?: string,
  ): void;
  raiseDecision(target: { recordId?: string }, s: Section, request: DecisionRequest): void;
  routeToAuthor(record: TriageRecord, causes: ClassifiedCause[], s: Section, why: string): void;
  flakyOccurrence(key: string, record: TriageRecord, why: string, s: Section): void;
}

/** The timeout signal: a test (or a context failure) whose error is a timeout. Bounded: each line is clipped first. */
export function isTestTimeout(cause: FailureCause): boolean {
  if (cause.tests.length === 0 || (cause.kind !== "test" && cause.kind !== "context")) return false;
  // An assertion that times out waiting for a condition is the test's own verdict ("expected ... within 30 s")
  if (isAssertion(cause)) return false;
  const head = cause.type ? `${cause.type}: ${cause.message}` : cause.message;
  return [head, cause.rootCause, ...cause.causedBy.slice(0, 5)].some((line) => TEST_TIMEOUT.test(clip(line, 500)));
}

/** A timeout of the environment by the classifier's own rules (under load, or a timeout signature). */
function infraTimeout(verdict: Verdict): boolean {
  return verdict.class === "infra" && (verdict.rule === "timeout-under-load" || verdict.rule.startsWith("timeout-signature:"));
}

/** The re-check kind of a classified cause. */
export function causeKindOf(c: ClassifiedCause): CauseKind {
  if (c.verdict.class === "infra") return infraTimeout(c.verdict) ? "timeout" : "infra";
  if (c.verdict.class === "flaky") return "flaky";
  if (c.verdict.class === "pre-existing") return "ignore";
  return isTestTimeout(c.cause) ? "timeout" : "real";
}

/** A test's id for {tests}: TestRef.id without a JUnit method's trailing "()". */
export function recheckTestId(test: TestRef): string {
  return test.id.replace(/\(\)$/, "");
}

type Vars = Record<Exclude<GateRecheckPlaceholder, "tests">, string> & { tests: string[] };

const CHECKS: Record<Exclude<GateRecheckPlaceholder, "tests">, RegExp> = {
  sha: FULL_SHA,
  pipeline: PIPELINE,
  branch: BRANCH,
  result_id: GATE_ID,
  reason: REASON,
  kind: /^(?:same|failed_tests)$/,
  project: PROJECT,
};

/**
 * Fill triage.recheck.command. Every placeholder the template uses is
 * validated first; {tests} as a whole argument becomes one argument per test,
 * inside a longer one the tests are joined with ",". A value that would start
 * an argument with "-" is refused.
 */
export function buildRecheckArgv(template: string[], vars: Vars, maxTests: number): { argv: string[] } | { error: string } {
  const used = new Set<string>();
  for (const arg of template) for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) used.add(match[1]);
  for (const name of used) {
    if (name === "tests") {
      if (vars.tests.length > maxTests) return { error: `{tests}: ${vars.tests.length} tests is more than max_tests (${maxTests})` };
      const bad = vars.tests.find((t) => !SAFE_TEST.test(t));
      if (bad !== undefined) return { error: `{tests}: ${JSON.stringify(clip(bad, 80))} is not a safe test id` };
      continue;
    }
    if (!(name in CHECKS)) return { error: `the placeholder {${name}} is not allowed` };
    const key = name as keyof typeof CHECKS;
    if (!CHECKS[key].test(vars[key])) return { error: `{${name}}: ${JSON.stringify(clip(vars[key], 80))} is not valid` };
  }
  const argv: string[] = [];
  for (const arg of template) {
    if (arg === "{tests}") {
      argv.push(...vars.tests);
      continue;
    }
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) =>
      name === "tests" ? vars.tests.join(",") : vars[name as keyof typeof CHECKS],
    );
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `an argument would start with "-": ${JSON.stringify(clip(filled, 80))}` };
    }
    argv.push(filled);
  }
  return { argv };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueTests(tests: TestRef[]): TestRef[] {
  const seen = new Set<string>();
  const out: TestRef[] = [];
  for (const t of tests) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }
  return out;
}

function describe(c: ClassifiedCause): string {
  const cause = c.cause;
  const what = cause.tests.length > 0 ? `${cause.tests[0].key}${cause.testCount > 1 ? ` (+${cause.testCount - 1} more)` : ""}` : (cause.step ?? cause.kind);
  return `${what}: ${clip(cause.type ? `${cause.type}: ${cause.message}` : cause.message, 160)}`;
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/** {reason}: "<kind>:<rule>" per re-checked cause, comma-separated, at most 200 safe characters. */
function reasonOf(used: { c: ClassifiedCause; kind: GateRecheckCause }[]): string {
  const items = unique(
    used.map((x) =>
      `${x.kind}:${x.kind === "timeout" && x.c.verdict.class === "code" ? "test-timeout" : x.c.verdict.rule}`.replace(/[^A-Za-z0-9._:,=+-]/g, "-"),
    ),
  );
  let reason = "";
  for (const item of items) {
    const next = reason ? `${reason},${item}` : item;
    if (next.length > 200) break;
    reason = next;
  }
  return REASON.test(reason) ? reason : "recheck";
}

/** Run the command with its timeout, and a second bound (the signal) for a runner that ignores it. */
async function bounded(runner: CommandRunner, argv: string[], timeoutMs: number): Promise<CommandOutput | null> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve(null);
    }, timeoutMs + 1000);
    timer.unref();
  });
  try {
    const run = runner
      .run(argv, { timeoutMs, signal: abort.signal })
      .catch((e: unknown): CommandOutput => ({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

export class GateRechecks {
  /** Re-checks this process has queued a run for (a waiting one is queued once) */
  private scheduled = new Set<string>();
  /** Re-checks whose command this process is running: a "running" one not here is a stopped server's */
  private running = new Set<string>();

  constructor(private host: GateRecheckHost) {}

  private get cfg(): GateRecheckSettings {
    return this.host.settings.gateRecheck;
  }

  private get rows(): GateRecheckStore {
    return this.host.store.gateRechecks;
  }

  private iso(ms = this.host.now()): string {
    return new Date(ms).toISOString();
  }

  /** Why the command does not run (observe mode, read_only), or null. triage.mode does not decide this. */
  blocked(): string | null {
    if (this.cfg.mode !== "act") return `triage.recheck.mode is ${this.cfg.mode}`;
    if (this.host.config.read_only === true) return "the project is read_only";
    return null;
  }

  status(): { mode: "off" | "observe" | "act"; blocked: string | null; pending: number } {
    return {
      mode: this.cfg.mode,
      blocked: this.cfg.mode === "off" ? null : this.blocked(),
      pending: this.rows.countPending(this.host.project),
    };
  }

  // ============ A RESULT THAT ANSWERS A RE-CHECK ============

  /**
   * The re-check a result answers, when its recheckId is the id of a result
   * triage re-checks (not a Lair re-check's id). Null: not a gate re-check's
   * answer (the caller goes on as before). A signed result that names a
   * re-check which can't take it is still a true result: it is kept as a
   * plain gate result, with a note saying why it answers nothing.
   */
  link(ref: string | undefined, resultId: string, sha: string): GateLinkResult | null {
    if (!ref) return null;
    const { store, project } = this.host;
    if (store.getRecheck(ref)) return null;
    const recordId = this.rows.recordIdByGate(project, ref);
    const origin = recordId ? store.getRecord(recordId) : null;
    if (!recordId || !origin) return null;
    // A failure triage never planned a gate re-check for: not this module's (the caller answers 404 as before)
    const latest = this.rows.latestFor(recordId);
    if (!latest) return null;
    const recheck = this.rows.latestFor(recordId, ANSWERABLE);
    const name = clip(ref, 80);
    const plain = (why: string): GateLinkResult => ({
      kind: "plain",
      note: `names triage's re-check of ${name} (recheckId), but ${why}: triaged as a plain gate result, and not re-checked`,
    });
    if (!recheck) return plain(`that re-check is ${latest.status}, not waiting for a result`);
    if (recheck.sha !== sha) return plain(`that re-check is for ${recheck.sha}, not ${sha}`);
    if (recheck.runId && recheck.runId !== resultId) return plain(`that re-check was queued as ${recheck.runId}: only that result answers it`);
    return { kind: "link", link: { recheck, origin } };
  }

  /** Decide on a re-check's result (in the ingest's section, after the result is recorded and flaky tests reclassified). */
  answer(link: GateLink, answerId: string, result: GateResult, evidence: GateEvidence, classified: ClassifiedCause[], s: Section): void {
    const { host } = this;
    const { store } = host;
    const r = link.recheck;
    const origin = store.getRecord(link.origin.id);
    if (!origin) return;
    const answerGate = result.id;
    const listed = new Set(evidence.passed.map((t) => t.key));
    const target = { recordId: origin.id };
    if (result.status === "passed") {
      const unproven = this.unproven(r, origin, result, listed);
      if (!unproven) {
        this.passed(r, origin, answerId, answerGate, listed, s);
        return;
      }
      this.rows.update(r.id, { status: "unproven", answerId, completedAt: this.iso(), detail: `${r.detail}; unproven: ${unproven}` });
      store.updateRecord(answerId, { blocking: false, resolution: `answers triage's re-check of ${origin.gateId}: unproven (${unproven})` });
      host.action(target, "recheck", "failed", `re-check ${r.attempt} (${answerGate}) answered "passed" but ${unproven}: not resolved, and not re-checked again`);
      s.events.push({ type: "triage.recheck_resolved", data: { recheck: this.rows.get(r.id), outcome: "unproven", answerId } });
      this.settled(r, `re-check ${r.attempt} unproven: ${unproven}`, s);
      return;
    }
    if (this.sameWay(r, classified)) {
      this.rows.update(r.id, { status: "failed_again", answerId, completedAt: this.iso(), detail: `${r.detail}; failed the same way (${answerGate})` });
      // A timeout that comes back on a quiet machine is not load: real (infra stays infra: the environment)
      let real = 0;
      for (const c of origin.causes) {
        if (!r.signatures.includes(c.cause.signature) || causeKindOf(c) !== "timeout") continue;
        store.updateCauseVerdict(c.id, {
          class: "code",
          rule: "failed-on-recheck",
          confidence: "high",
          evidence: [
            `failed again the same way on triage's re-check at the same commit (result ${answerGate}): a real failure`,
            ...c.verdict.evidence.slice(0, 3).map((e) => `was ${c.verdict.class}: ${e}`),
          ],
        });
        store.setTestClass(origin.id, c.cause.tests.map((t) => t.key), "code");
        real++;
      }
      const updated = store.getRecord(origin.id)!;
      store.updateRecord(origin.id, {
        verdict: overallClass(updated.causes) ?? null,
        blocking: true,
        resolution: `re-check ${answerGate} failed the same way: escalated${real > 0 ? " as a real failure" : ""}`,
      });
      // The same network failure twice at one commit (connection refused, unable to connect: a port or a host the
      // change may have moved) is as likely the change as the environment: the author hears of it, and real is advised
      const network = updated.causes.filter(
        (c) => r.signatures.includes(c.cause.signature) && c.verdict.class === "infra" && c.verdict.infraKind === "network",
      );
      host.action(target, "recheck", "failed", `re-check ${r.attempt} (${r.kind}) failed the same way (result ${answerGate}): escalated`);
      this.escalate(r.rootId, origin, `failed the same way on triage's re-check (result ${answerGate})`, s, network.length > 0);
      // Its code causes (and a network failure) go back to the author now (the re-check's own result is not routed again)
      const toAuthor = [...updated.causes.filter((c) => c.verdict.class === "code"), ...network];
      if (toAuthor.length > 0 && host.settings.actions.code === "route") {
        host.routeToAuthor(
          updated,
          toAuthor,
          s,
          `it failed the same way on triage's re-check (result ${answerGate})${network.length > 0 ? "; the same network failure twice at one commit may be the change" : ""}`,
        );
      }
      s.events.push({ type: "triage.recheck_escalated", data: { recheck: this.rows.get(r.id), answerId } });
      return;
    }
    const first = classified.find((c) => c.verdict.class !== "pre-existing") ?? classified[0];
    const what = first ? describe(first) : "no cause found";
    this.rows.update(r.id, {
      status: "failed_differently",
      answerId,
      completedAt: this.iso(),
      detail: `${r.detail}; failed differently (${answerGate}): ${what}`,
    });
    store.updateRecord(origin.id, { resolution: `re-check ${answerGate} failed differently: triaged as a new failure` });
    host.action(target, "recheck", "recorded", `re-check ${r.attempt} (${r.kind}) failed differently (result ${answerGate}: ${what}): triaged as a new failure`);
    s.events.push({ type: "triage.recheck_resolved", data: { recheck: this.rows.get(r.id), outcome: "failed_differently", answerId } });
  }

  /** Why a "passed" answer does not show the re-check passing, or null when it does. */
  private unproven(r: GateRecheck, origin: TriageRecord, result: GateResult, listed: Set<string>): string | null {
    if (r.kind === "failed_tests") {
      const missing = r.keys.filter((k) => !listed.has(k));
      if (r.keys.length === 0 || missing.length > 0) {
        return `${missing.length} of the ${r.keys.length} re-checked test(s) are not listed as passed (send the JUnit reports with the result)`;
      }
      return null;
    }
    if (result.steps.length === 0) return "the result lists no steps";
    const notPassed = origin.failedSteps.filter((name) => result.steps.some((st) => st.name === name && st.status !== "passed"));
    return notPassed.length > 0 ? `step(s) ${notPassed.join(", ")} did not pass` : null;
  }

  /** The same signature again, or (a timeout or flaky re-check) one of the re-checked tests failing again but on infrastructure. */
  private sameWay(r: GateRecheck, classified: ClassifiedCause[]): boolean {
    const byTest = r.causes.includes("timeout") || r.causes.includes("flaky");
    return classified.some(
      (c) =>
        c.verdict.class !== "pre-existing" &&
        (r.signatures.includes(c.cause.signature) ||
          (byTest && c.verdict.class !== "infra" && c.cause.tests.some((t) => r.keys.includes(t.key)))),
    );
  }

  /** Resolve the failure: infra stays infra (the environment); a test that timed out and passed quietly is flaky. */
  private passed(r: GateRecheck, origin: TriageRecord, answerId: string, answerGate: string, listed: Set<string>, s: Section): void {
    const { host } = this;
    const { store } = host;
    const flaky: string[] = [];
    for (const c of origin.causes) {
      if (!r.signatures.includes(c.cause.signature)) continue;
      const keys = c.cause.tests.map((t) => t.key);
      if (c.verdict.class === "flaky") {
        // Flaky already (it may have become so just now, its tests listed as passed): counted when it did
        flaky.push(...keys);
        continue;
      }
      // Infra stays infra (the environment); a code failure or a timeout of the environment that passes quietly is flaky
      if (c.verdict.class !== "code" && !infraTimeout(c.verdict)) continue;
      const verdict: Verdict = {
        class: "flaky",
        rule: "passed-on-recheck",
        confidence: "high",
        evidence: [
          `failed in result ${short(origin.id)}, then passed on triage's re-check (${r.kind}) at the same commit ${short(origin.sha)} (result ${answerGate})`,
          ...c.verdict.evidence.slice(0, 2).map((e) => `was ${c.verdict.class}: ${e}`),
        ],
      };
      store.updateCauseVerdict(c.id, verdict);
      store.setTestClass(origin.id, keys, "flaky");
      for (const key of keys) host.flakyOccurrence(key, origin, verdict.evidence[0], s);
      flaky.push(...keys);
    }
    const updated = store.getRecord(origin.id)!;
    const blocking = updated.causes.some((c) => c.verdict.class === "code");
    const label = r.causes.includes("infra") ? "infrastructure" : r.causes.includes("timeout") ? "a timeout under load" : "flaky";
    const flakyKeys = unique(flaky);
    const passedTests = r.kind === "failed_tests" ? r.keys.filter((k) => listed.has(k)) : r.keys;
    store.updateRecord(origin.id, {
      verdict: overallClass(updated.causes) ?? null,
      blocking,
      resolution: `re-check ${answerGate} passed at the same commit: it was ${label}${
        flakyKeys.length > 0 ? `; flaky: ${flakyKeys.slice(0, 5).join(", ")}${flakyKeys.length > 5 ? ", ..." : ""}` : ""
      }`,
    });
    host.action({ recordId: origin.id }, "unblock", "done", `re-check ${r.attempt} (${r.kind}) passed at ${short(r.sha)} (result ${answerGate}): ${label}`);
    this.rows.update(r.id, { status: "passed", answerId, completedAt: this.iso(), passedTests, detail: `${r.detail}; passed (${answerGate})` });
    store.updateRecord(answerId, { blocking: false, resolution: `answers triage's re-check of ${origin.gateId}: passed` });
    s.events.push({ type: "triage.recheck_resolved", data: { recheck: this.rows.get(r.id), outcome: "passed", answerId, flaky: flakyKeys } });
  }

  // ============ A FAILURE: RE-CHECK IT? ============

  /**
   * For a failed result (a gate run, or a re-check's result that failed
   * differently): plan a re-check, record why not, or null when
   * triage.recheck.mode is off.
   */
  plan(
    record: TriageRecord,
    classified: ClassifiedCause[],
    link: GateLink | null,
    loadPerCore: number | undefined,
    s: Section,
    /** It named a re-check that could not take it (GateLinkResult plain): recorded, never re-checked itself */
    plain?: string,
  ): GatePlan | null {
    const cfg = this.cfg;
    if (cfg.mode === "off" || !cfg.command) return null;
    const { host } = this;
    const target = { recordId: record.id };
    if (plain) return { text: "not re-checked: it named a re-check that was not waiting for it", holdRoute: false };
    const rootId = link?.recheck.rootId ?? record.id;
    const chain = this.rows.forRoot(rootId);
    // Escalated: the failure it re-checked went back to its author, so this result is not routed again
    if (link && chain.some((r) => r.status === "failed_again")) {
      return { text: "it failed the same way on a re-check: escalated", holdRoute: true };
    }
    const kinds = classified.map((c) => ({ c, kind: causeKindOf(c) }));
    const eligible = kinds.filter(
      (x): x is { c: ClassifiedCause; kind: GateRecheckCause } => x.kind === "infra" || x.kind === "timeout" || x.kind === "flaky",
    );
    if (eligible.length === 0) return { text: null, holdRoute: false };
    const real = kinds.find((x) => x.kind === "real");
    if (real) {
      host.action(target, "recheck", "skipped", `not re-checked: it has a real failure (${describe(real.c)})`);
      return { text: "not re-checked: it has a real failure", holdRoute: false };
    }
    const used = eligible.filter((x) => cfg.kinds[x.kind] !== "none");
    if (used.length === 0) {
      const names = unique(eligible.map((x) => x.kind)).join(", ");
      host.action(target, "recheck", "skipped", `not re-checked: triage.recheck.kinds is none for ${names}`);
      return { text: `not re-checked (kinds: none for ${names})`, holdRoute: false };
    }

    let kind: GateRecheckKind = used.some((x) => cfg.kinds[x.kind] === "same") ? "same" : "failed_tests";
    const tests = uniqueTests(used.flatMap((x) => x.c.cause.tests));
    const attempts = chain.filter((r) => r.status !== "refused").length;
    const now = host.now();
    const base: NewGateRecheck = {
      project: host.project,
      recordId: record.id,
      rootId,
      gateId: record.gateId,
      sha: record.sha,
      pipelineId: record.pipelineId,
      branch: record.branch,
      causes: unique(used.map((x) => x.kind)),
      kind,
      reason: reasonOf(used),
      tests: [],
      keys: tests.map((t) => t.key),
      signatures: used.map((x) => x.c.cause.signature),
      attempt: attempts + 1,
      status: "refused",
      detail: "",
      holdRoute: false,
    };
    let fallback: string | null = null;
    if (kind === "failed_tests") {
      const problem = this.testsProblem(used, tests);
      if (problem && !used.some((x) => x.kind === "infra")) return this.refuse(base, problem, now);
      if (problem) {
        kind = "same";
        fallback = problem;
      }
    }
    base.kind = kind;
    base.tests = kind === "failed_tests" ? tests.map(recheckTestId) : [];

    if (attempts >= cfg.maxPerResult) {
      const refused = this.refuse(base, `${attempts} re-check(s) already (max_per_result ${cfg.maxPerResult})`, now);
      this.escalate(rootId, record, `still fails after ${attempts} re-check(s)`, s);
      return { ...refused, text: `${refused.text}; asked the human` };
    }
    const pending = this.rows.pendingAt(host.project, record.sha, record.pipelineId).filter((r) => r.recordId !== record.id);
    if (pending.length > 0) {
      return this.refuse(base, `re-check ${short(pending[0].id)} of ${pending[0].gateId} (the same commit and pipeline) is pending`, now);
    }
    const built = buildRecheckArgv(
      cfg.command,
      {
        project: host.project,
        sha: record.sha,
        pipeline: record.pipelineId,
        branch: record.branch,
        result_id: record.gateId,
        reason: base.reason,
        kind,
        tests: base.tests,
      },
      cfg.maxTests,
    );
    if ("error" in built) return this.refuse(base, `refused: ${built.error}`, now);

    const blocked = this.blocked();
    const what =
      kind === "same"
        ? `${record.pipelineId || "its pipeline"} at ${short(record.sha)}`
        : `${base.tests.length} failed test(s) at ${short(record.sha)}: ${base.tests.slice(0, 3).join(", ")}${base.tests.length > 3 ? ", ..." : ""}`;
    const hints = [
      ...(fallback ? [`same, not failed_tests: ${fallback}`] : []),
      ...(loadPerCore !== undefined && base.causes.includes("timeout") ? [`load per core ${loadPerCore.toFixed(2)}`] : []),
    ];
    const detail = `${kind} (${base.reason}): ${what}${hints.length > 0 ? `; ${hints.join("; ")}` : ""}`;
    const holdRoute = blocked === null && used.some((x) => x.c.verdict.class === "code");
    const row = this.rows.create(
      { ...base, status: blocked ? "would" : "waiting", detail, argv: built.argv, holdRoute },
      now,
      now + cfg.cooldownSeconds * 1000,
    );
    const n = `${row.attempt}/${cfg.maxPerResult}`;
    if (blocked) {
      host.action(target, "recheck", "planned", `would re-check ${n}, ${detail} (not run: ${blocked})`, built.argv);
      s.events.push({ type: "triage.recheck_would", data: { recheck: row } });
      return { text: `would re-check (${kind})`, holdRoute: false };
    }
    host.action(
      target,
      "recheck",
      "waiting",
      `re-check ${n}, ${detail}${cfg.cooldownSeconds > 0 ? `, after a ${cfg.cooldownSeconds} s cool-down` : ""}`,
      built.argv,
    );
    // pump() runs it, in this same section (pumpSync), once its cool-down is over and max_pending has room
    return { text: `re-check ${n} (${kind}) in the gate system`, holdRoute };
  }

  /**
   * Queue an environment recovery re-check through the gate system (M2).
   * These don't count against max_per_result (M4: separate from normal infra re-checks).
   */
  queueEnvironmentRecovery(record: TriageRecord, steps: string[], tests: TestRef[], patternId: string, s: Section): void {
    const { host } = this;
    const cfg = this.cfg;
    const now = host.now();
    const blocked = this.blocked();

    const kind: GateRecheckKind = tests.length > 0 ? "failed_tests" : "same";
    const testIds = tests.map(recheckTestId);
    const reason = `environment:${patternId}`;

    const base: NewGateRecheck = {
      project: host.project,
      recordId: record.id,
      rootId: record.id,
      gateId: record.gateId,
      sha: record.sha,
      pipelineId: record.pipelineId,
      branch: record.branch,
      causes: ["infra"],
      kind,
      reason,
      tests: testIds,
      keys: tests.map((t) => t.key),
      signatures: record.causes.map((c) => c.cause.signature),
      attempt: 1, // First attempt after environment recovery
      status: "refused",
      detail: "",
      holdRoute: false,
    };

    // Build the command
    const built = buildRecheckArgv(
      cfg.command,
      {
        project: host.project,
        sha: record.sha,
        pipeline: record.pipelineId,
        branch: record.branch,
        result_id: record.gateId,
        reason,
        kind,
        tests: testIds,
      },
      cfg.maxTests,
    );

    if ("error" in built) {
      host.action({ recordId: record.id }, "recheck", "skipped", `environment recovery re-check refused: ${built.error}`);
      return;
    }

    const what = kind === "same"
      ? `${record.pipelineId || "its pipeline"} at ${short(record.sha)}`
      : `${testIds.length} test(s) at ${short(record.sha)}`;
    const detail = `environment recovery (${patternId}): ${what}`;

    const row = this.rows.create(
      { ...base, status: blocked ? "would" : "waiting", detail, argv: built.argv, holdRoute: false },
      now,
      now, // No cool-down for environment recovery
    );

    if (blocked) {
      host.action({ recordId: record.id }, "recheck", "planned", `would re-check after environment recovery: ${detail} (not run: ${blocked})`, built.argv);
      s.events.push({ type: "triage.recheck_would", data: { recheck: row } });
    } else {
      host.action({ recordId: record.id }, "recheck", "waiting", `re-check after environment recovery: ${detail}`, built.argv);
    }
  }

  /** Why the failed tests can't be the re-check's selection, or null. */
  private testsProblem(used: { c: ClassifiedCause }[], tests: TestRef[]): string | null {
    if (used.some((x) => x.c.cause.tests.length === 0)) return "a cause names no failed test";
    if (used.some((x) => x.c.cause.testCount > x.c.cause.tests.length)) return "more tests failed than the report names";
    if (tests.length > this.cfg.maxTests) return `${tests.length} failed tests is more than max_tests (${this.cfg.maxTests})`;
    const bad = tests.map(recheckTestId).find((id) => !SAFE_TEST.test(id));
    return bad === undefined ? null : `the test id ${JSON.stringify(clip(bad, 80))} has characters a re-check does not pass`;
  }

  private refuse(base: NewGateRecheck, why: string, now: number): GatePlan {
    this.rows.create({ ...base, status: "refused", detail: `not re-checked: ${why}` }, now, now);
    this.host.action({ recordId: base.recordId }, "recheck", "skipped", `not re-checked: ${why}`);
    return { text: `not re-checked: ${why}`, holdRoute: false };
  }

  /**
   * One decision per chain (the store's claim dedupes it): the owner answers real or fix-environment, rerun, or
   * ignore. `network`: the same network failure twice at one commit, so real is advised (and offered first).
   */
  private escalate(rootId: string, failure: TriageRecord, why: string, s: Section, network = false): void {
    const { host } = this;
    const cfg = this.cfg;
    const chain = this.rows.forRoot(rootId).filter((r) => r.status !== "refused");
    const left = cfg.maxPerResult - chain.length;
    const root = host.store.getRecord(rootId) ?? failure;
    const infra = chain.some((r) => r.causes.includes("infra"));
    const real = {
      id: "real",
      label: "Treat it as a real failure",
      effect: "reversible" as const,
      consequences: network
        ? "It stays blocking, and the author checks the change (a host, a port, a connection setting)"
        : "It stays blocking, and the author fixes it",
    };
    const environment = {
      id: "fix-environment",
      label: "Fix the environment",
      consequences: "Nothing more runs; run the gate again once it is fixed",
      effect: "reversible" as const,
    };
    const first = network ? [real, environment] : infra ? [environment] : [real];
    host.raiseDecision({ recordId: failure.id }, s, {
      project: host.project,
      subject: `recheck:${rootId}`,
      kind: "escalation",
      question: `Gate ${root.gateId} at ${short(root.sha)} on ${root.branch} ${why}.`,
      context: [
        ...failure.causes
          .filter((c) => c.verdict.class !== "pre-existing")
          .slice(0, 4)
          .flatMap((c) => [describe(c), ...c.verdict.evidence.slice(0, 1)]),
        `Re-checks: ${chain.map((r) => `#${r.attempt} ${r.kind} ${r.status}`).join("; ") || "none"}.`,
      ],
      options: [
        ...first,
        ...(left > 0
          ? [{ id: "rerun", label: "Re-check once more", consequences: `One more re-check (${left} left of max_per_result ${cfg.maxPerResult})`, effect: "reversible" as const }]
          : []),
        { id: "ignore", label: "Ignore", consequences: "Nothing more runs", effect: "reversible" as const },
      ],
      recommended: first[0].id,
      structure: {
        class: "triage.gate_failure",
        evidence: {
          code: network ? "infra_download" : infra ? "infra_other" : "same_failure_again",
          facts: { gate: root.gateId, sha: root.sha, recheck_count: chain.length, same_commit: true, network },
          cause_cleared: false,
          linked_issue: null,
        },
      },
      why: network
        ? "The same network failure twice at the same commit is as likely the change (a host, a port, a setting) as the machine."
        : "Lair re-checks a failure that looks like infrastructure or load; one that fails the same way again, or keeps failing, is not that.",
    });
  }

  /** The owner's answer to an escalation: "rerun" asks for one more re-check, within max_per_result. */
  followDecision(rootId: string, optionId: string, actor: string | undefined, s: Section): void {
    const { host } = this;
    const chain = this.rows.forRoot(rootId).filter((r) => r.status !== "refused");
    const last = chain[chain.length - 1];
    const target = { recordId: last?.recordId ?? rootId };
    if (optionId !== "rerun" || !last || !last.argv) {
      host.action(target, "decision", "done", `answered "${optionId}"`, undefined, undefined, actor);
      return;
    }
    if (chain.length >= this.cfg.maxPerResult) {
      host.action(target, "recheck", "skipped", `the owner asked for one more re-check, but max_per_result (${this.cfg.maxPerResult}) is reached`, undefined, undefined, actor);
      return;
    }
    const blocked = this.blocked();
    const now = host.now();
    const row = this.rows.create(
      {
        project: last.project,
        recordId: last.recordId,
        rootId,
        gateId: last.gateId,
        sha: last.sha,
        pipelineId: last.pipelineId,
        branch: last.branch,
        causes: last.causes,
        kind: last.kind,
        reason: last.reason,
        tests: last.tests,
        keys: last.keys,
        signatures: last.signatures,
        attempt: chain.length + 1,
        status: blocked ? "would" : "waiting",
        detail: `${last.kind} (${last.reason}): asked by the owner`,
        argv: last.argv,
        holdRoute: false,
      },
      now,
      now,
    );
    host.action(target, "recheck", blocked ? "planned" : "waiting", `one more re-check, asked by the owner${blocked ? ` (not run: ${blocked})` : ""}`, last.argv, undefined, actor);
    if (blocked) s.events.push({ type: "triage.recheck_would", data: { recheck: row } });
    else this.schedule(row.id, s);
  }

  // ============ RUNNING THE COMMAND ============

  /** In every decision section (pumpSync): interrupted commands, expiry, and the waiting re-checks that are due. */
  pump(s: Section): void {
    const { host } = this;
    const project = host.project;
    const now = host.now();
    for (const r of this.rows.withStatus(project, ["running"])) {
      if (this.running.has(r.id)) continue;
      const at = this.rows.times(r.id)?.startedMs ?? now;
      this.rows.update(r.id, {
        status: "queued",
        queuedAt: this.iso(at),
        queuedMs: at,
        detail: `${r.detail}; its command was running when the server stopped: it may have queued the re-check, so it is not run again`,
      });
      host.action(
        { recordId: r.recordId },
        "recheck",
        "recorded",
        `re-check ${r.attempt}: its command was interrupted by a restart; kept as queued until its result or its expiry (not run again)`,
      );
    }
    const expireMs = this.cfg.expireHours * 3_600_000;
    for (const r of this.rows.withStatus(project, ["queued"])) {
      const queuedMs = this.rows.times(r.id)?.queuedMs ?? now;
      if (now - queuedMs < expireMs) continue;
      const why = `no result within ${this.cfg.expireHours} h`;
      this.rows.update(r.id, { status: "expired", completedAt: this.iso(now), detail: `${r.detail}; expired: ${why}` });
      host.action({ recordId: r.recordId }, "recheck", "failed", `re-check ${r.attempt} expired: ${why}; not retried`);
      s.events.push({ type: "triage.recheck_resolved", data: { recheck: this.rows.get(r.id), outcome: "expired" } });
      this.settled(r, `re-check ${r.attempt} expired (${why})`, s);
    }
    const waiting = this.rows.withStatus(project, ["waiting"]);
    if (waiting.length === 0) return;
    const blocked = this.blocked();
    // max_pending: re-checks running or queued in the gate system, and the ones this process is about to run
    let taken = this.inGateSystem() + waiting.filter((r) => this.scheduled.has(r.id)).length;
    const full = `waiting: max_pending (${this.cfg.maxPending}) re-checks are running or queued in the gate system`;
    for (const r of waiting) {
      if (blocked) {
        this.rows.update(r.id, { status: "would", detail: `${r.detail} (not run: ${blocked})` });
        host.action({ recordId: r.recordId }, "recheck", "planned", `would re-check ${r.attempt} (not run: ${blocked})`, r.argv);
        s.events.push({ type: "triage.recheck_would", data: { recheck: this.rows.get(r.id) } });
        continue;
      }
      if (this.scheduled.has(r.id) || (this.rows.times(r.id)?.notBeforeMs ?? now) > now) continue;
      if (taken >= this.cfg.maxPending) {
        if (!r.detail.endsWith(full)) this.rows.update(r.id, { detail: `${r.detail}; ${full}` });
        continue;
      }
      taken++;
      this.schedule(r.id, s);
    }
  }

  /** Re-checks the gate system holds now: their command running, or queued there. */
  private inGateSystem(): number {
    return this.rows.withStatus(this.host.project, ["running", "queued"]).length;
  }

  private schedule(id: string, s: Section): void {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    s.jobs.push(() => this.run(id));
  }

  /** Outside the serial queue (an outbox job): claim the re-check, run its command, record what it said. */
  private async run(id: string): Promise<void> {
    const { host } = this;
    try {
      const go = await host.serial(async () =>
        host.commit(() => {
          const r = this.rows.get(id);
          const times = this.rows.times(id);
          if (!r || !times || !r.argv || r.status !== "waiting" || this.blocked() || times.notBeforeMs > host.now()) return null;
          if (this.inGateSystem() >= this.cfg.maxPending) return null;
          this.rows.update(id, { status: "running", startedMs: host.now() });
          this.running.add(id);
          return r;
        }),
      );
      if (!go?.argv) return;
      const out = await bounded(host.runner, go.argv, this.cfg.timeoutSeconds * 1000);
      await host.serial(async () => host.commit((s) => this.ran(go, out, s)));
    } finally {
      this.running.delete(id);
      this.scheduled.delete(id);
    }
  }

  /** What the command said. Its result may already have answered the re-check while it ran. */
  private ran(r: GateRecheck, out: CommandOutput | null, s: Section): void {
    const { host } = this;
    const current = this.rows.get(r.id);
    if (!current) return;
    const answered = current.status !== "running";
    const target = { recordId: r.recordId };
    const program = r.argv?.[0] ?? "the command";
    const output = out ? tail(`${out.stdout}${out.stderr ? `\n${out.stderr}` : ""}`.trim()) : undefined;
    const n = `${r.attempt}/${this.cfg.maxPerResult}`;
    if (out && out.code === 0) {
      const first = out.stdout
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      const runId = first !== undefined && GATE_ID.test(first) ? first : undefined;
      this.rows.update(r.id, {
        ...(answered ? {} : { status: "queued" as const, queuedAt: this.iso(), queuedMs: host.now() }),
        detail: `${current.detail}; queued${runId ? ` as ${runId}` : ""}`,
        output,
        runId,
      });
      host.action(target, "recheck", "done", `re-check ${n} queued: ${program} exited 0${runId ? ` (its result: ${runId})` : ""}`, r.argv, output);
      s.events.push({ type: "triage.recheck_queued", data: { recheck: this.rows.get(r.id) } });
      return;
    }
    const why = !out
      ? `${program} gave no answer within ${this.cfg.timeoutSeconds + 1} s`
      : out.code === -1
        ? `${program} did not finish: killed at the ${this.cfg.timeoutSeconds} s timeout, or it could not start`
        : `${program} exited ${out.code}`;
    if (!answered) {
      this.rows.update(r.id, { status: "not_queued", completedAt: this.iso(), detail: `${current.detail}; not queued: ${why}`, output });
    }
    host.action(target, "recheck", "failed", `re-check ${n} not queued: ${why}; not retried`, r.argv, output);
    s.events.push({ type: "triage.recheck_resolved", data: { recheck: this.rows.get(r.id), outcome: "not_queued" } });
    if (!answered) this.settled(r, `re-check ${r.attempt} could not be queued (${why})`, s);
  }

  /** A re-check that will not answer: say so on the failure, and send its held code causes to the author. */
  private settled(r: GateRecheck, why: string, s: Section): void {
    const { store, settings } = this.host;
    const origin = store.getRecord(r.recordId);
    if (!origin) return;
    store.updateRecord(origin.id, { resolution: why });
    if (!r.holdRoute || settings.actions.code !== "route") return;
    const code = origin.causes.filter((c) => c.verdict.class === "code");
    if (code.length > 0) this.host.routeToAuthor(origin, code, s, why);
  }
}
