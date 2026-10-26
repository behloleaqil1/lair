/**
 * The classifier: rules over a cause and the history the store keeps. Each
 * rule that decides also says why (its evidence lines). In order:
 *
 * 1. infra: an infrastructure pattern (connection timeout, container start,
 *    OOM, runner died, network, disk) in the cause's text or "Caused by"
 *    chain; a step killed (exit 137/143) or timed out with nothing more
 *    specific; or a timeout while the machine was overloaded.
 * 2. flaky: every failing test of the cause passed at the same commit within
 *    the flaky window, or (off the default branch) is quarantined.
 * 3. pre-existing: the default branch has an open incident with this cause
 *    and the base commit includes its red commit, or the same tests (or the
 *    same cause) failed in the base commit's own recent gate run. Never
 *    without a base result.
 * 4. code: everything else, with which changed files it is near; low
 *    confidence when there is no base result to compare with.
 */
import type { ClassifiedCause, FailureCause, TriageClass, Verdict } from "../../shared/triage-types.js";
import type { CompiledPattern, TriageSettings } from "./config.js";
import { basename, clip, dirname, stem } from "./text.js";

/**
 * What the base commit's own gate run showed: the newest gate run of the same
 * pipeline at exactly the base commit, no older than triage.base_max_age_hours.
 * Without one there are no base facts, and nothing is called pre-existing.
 */
export interface BaseFacts {
  recordId: string;
  sha: string;
  status: "passed" | "failed" | "error";
  at: string;
  failedKeys: Set<string>;
  signatures: Set<string>;
}

export interface IncidentFacts {
  id: string;
  redSha: string;
  keys: Set<string>;
  signatures: Set<string>;
}

export interface ClassifyContext {
  sha: string;
  defaultBranch: boolean;
  changedFiles: string[];
  /** Why changed files are unknown, when they are */
  changedNote?: string;
  base?: BaseFacts;
  /** Why there are no base facts, when there are none */
  baseNote?: string;
  /** The default branch's open incident, when the base commit includes its red commit */
  incident?: IncidentFacts;
  /** Tests (by key) that passed at this commit within the flaky window */
  passedAtSha: Map<string, { recordId: string; at: string }>;
  quarantined: Set<string>;
  loadPerCore?: number;
}

const SEVERITY: Record<TriageClass, number> = { code: 4, infra: 3, flaky: 2, "pre-existing": 1 };

/** The most severe class among causes: code > infra > flaky > pre-existing. */
export function overallClass(causes: ClassifiedCause[]): TriageClass | undefined {
  let best: TriageClass | undefined;
  for (const c of causes) {
    if (!best || SEVERITY[c.verdict.class] > SEVERITY[best]) best = c.verdict.class;
  }
  return best;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The text an infra pattern is matched against, line by line, with where each line came from. */
function causeLines(cause: FailureCause): { where: string; text: string }[] {
  const head = cause.type ? `${cause.type}: ${cause.message}` : cause.message;
  return [
    { where: "error", text: head },
    ...cause.causedBy.map((text) => ({ where: "Caused by", text })),
    ...cause.evidence.map((text) => ({ where: "log", text })),
  ];
}

function matchInfra(cause: FailureCause, patterns: CompiledPattern[]): Verdict | null {
  const lines = causeLines(cause);
  for (const pattern of patterns) {
    const hits = lines.filter((l) => pattern.regex.test(l.text));
    if (hits.length === 0) continue;
    const evidence = [
      ...hits.slice(0, 3).map((h) => `${h.where}: ${clip(h.text, 200)} (matches infra pattern ${pattern.id})`),
    ];
    if (cause.kind === "context") {
      evidence.push(`one context failure for ${cause.testCount} test(s): the tests never ran, so this is not the change`);
    }
    return {
      class: "infra",
      rule: `infra-pattern:${pattern.id}`,
      confidence: "high",
      evidence,
      infraKind: pattern.kind,
    };
  }
  return null;
}

function matchExit(cause: FailureCause, ctx: ClassifyContext, settings: TriageSettings): Verdict | null {
  if (cause.parser === "runner") {
    return {
      class: "infra",
      rule: "runner-error",
      confidence: "high",
      evidence: [cause.message, ...cause.evidence.slice(0, 3)],
      infraKind: "runner",
    };
  }
  if (cause.kind === "step" && (cause.type === "exit 137" || cause.type === "exit 143")) {
    return {
      class: "infra",
      rule: `killed:${cause.type}`,
      confidence: "high",
      evidence: [`${cause.step ?? "step"} was killed (${cause.type}: SIGKILL or SIGTERM, usually out of memory or the runner)`],
      infraKind: cause.type === "exit 137" ? "oom" : "runner",
    };
  }
  if (cause.kind === "step" && cause.type === "timeout") {
    return {
      class: "infra",
      rule: "step-timeout",
      confidence: "low",
      evidence: [`${cause.step ?? "step"} timed out with no test failure in its output`],
      infraKind: "runner",
    };
  }
  const load = ctx.loadPerCore;
  if (load !== undefined && load >= settings.overloadPerCore) {
    const timeout = causeLines(cause).find((l) => /time(d)? ?out|deadline exceeded/i.test(l.text));
    if (timeout) {
      return {
        class: "infra",
        rule: "timeout-under-load",
        confidence: "low",
        evidence: [
          `${timeout.where}: ${clip(timeout.text, 200)}`,
          `load per core was ${load.toFixed(2)} (overload_per_core: ${settings.overloadPerCore})`,
        ],
        infraKind: "load",
      };
    }
  }
  return null;
}

function matchFlaky(cause: FailureCause, ctx: ClassifyContext): Verdict | null {
  if (cause.tests.length === 0) return null;
  // On the default branch a quarantined test that fails is a failure until it passes at the same commit
  if (!ctx.defaultBranch && cause.tests.every((t) => ctx.quarantined.has(t.key))) {
    return {
      class: "flaky",
      rule: "quarantined",
      confidence: "high",
      evidence: cause.tests.slice(0, 5).map((t) => `${t.key} is quarantined as flaky: it runs but does not block`),
    };
  }
  if (cause.tests.every((t) => ctx.passedAtSha.has(t.key))) {
    return {
      class: "flaky",
      rule: "passed-at-same-sha",
      confidence: "high",
      evidence: cause.tests.slice(0, 5).map((t) => {
        const pass = ctx.passedAtSha.get(t.key)!;
        return `${t.key} passed at ${short(ctx.sha)} in result ${short(pass.recordId)} (${pass.at})`;
      }),
    };
  }
  return null;
}

function matchPreExisting(cause: FailureCause, ctx: ClassifyContext): Verdict | null {
  const incident = ctx.incident;
  if (incident) {
    const sameTests = cause.tests.length > 0 && cause.tests.every((t) => incident.keys.has(t.key));
    if (sameTests || incident.signatures.has(cause.signature)) {
      return {
        class: "pre-existing",
        rule: "open-incident",
        confidence: "high",
        evidence: [
          `the default branch is red with the same ${sameTests ? "tests" : "cause"} since ${short(incident.redSha)} (incident ${short(incident.id)})`,
        ],
      };
    }
  }
  if (ctx.defaultBranch) return null;
  const base = ctx.base;
  if (!base || base.status === "passed") return null;
  const sameSignature = base.signatures.has(cause.signature);
  const sameTests = cause.tests.length > 0 && cause.tests.every((t) => base.failedKeys.has(t.key));
  if (!sameSignature && !sameTests) return null;
  const where = `the base commit ${short(base.sha)}`;
  const evidence = sameTests
    ? cause.tests.slice(0, 5).map((t) => `${t.key} also failed on ${where}, result ${short(base.recordId)} (${base.at})`)
    : [`the same cause (${clip(cause.rootCause, 160)}) failed on ${where}, result ${short(base.recordId)} (${base.at})`];
  return { class: "pre-existing", rule: sameTests ? "failed-on-base" : "same-cause-on-base", confidence: "high", evidence };
}

/** Changed files near a cause: the same file, a test of the changed file, or the same directory. */
export function nearFiles(cause: FailureCause, changedFiles: string[]): string[] {
  const files = [
    ...cause.tests.flatMap((t) => (t.file ? [t.file] : [])),
    ...cause.locations.map((l) => l.file),
  ];
  const suites = cause.tests.map((t) => t.suite.split(/[.#/]/).filter(Boolean).pop() ?? t.suite);
  const near: string[] = [];
  for (const changed of changedFiles) {
    const changedStem = stem(changed);
    const hit =
      files.some(
        (f) =>
          changed === f ||
          changed.endsWith(`/${f}`) ||
          f.endsWith(`/${changed}`) ||
          (changedStem.length > 0 && stem(f) === changedStem) ||
          (f.includes("/") &&
            (dirname(changed) === dirname(f) || dirname(changed).endsWith(`/${dirname(f)}`))),
      ) ||
      (changedStem.length > 0 && suites.some((s) => stem(s) === changedStem)) ||
      (cause.kind === "build" && cause.evidence.some((e) => e.includes(basename(changed))));
    if (hit) near.push(changed);
  }
  return near;
}

function codeVerdict(cause: FailureCause, ctx: ClassifyContext): Verdict {
  const near = nearFiles(cause, ctx.changedFiles);
  const evidence: string[] = [];
  if (near.length > 0) {
    evidence.push(`near the change: ${near.slice(0, 5).join(", ")}${near.length > 5 ? ` (+${near.length - 5} more)` : ""}`);
  } else if (ctx.changedFiles.length > 0) {
    evidence.push(`no changed file is near it (${ctx.changedFiles.length} file(s) changed)`);
  } else {
    evidence.push(ctx.changedNote ?? "the changed files are unknown");
  }
  if (ctx.defaultBranch) {
    evidence.push(`a new failure on the default branch at ${short(ctx.sha)}`);
  } else if (ctx.base) {
    evidence.push(
      ctx.base.status === "passed"
        ? `the base commit passed at ${short(ctx.base.sha)} (result ${short(ctx.base.recordId)})`
        : `it did not fail on the base commit ${short(ctx.base.sha)}`,
    );
  } else {
    evidence.push(ctx.baseNote ?? "no recent gate run of the base commit to compare with");
  }
  evidence.push(clip(cause.type ? `${cause.type}: ${cause.message}` : cause.message, 200));
  return {
    class: "code",
    rule: near.length > 0 ? "near-change" : "new-failure",
    // Without the base's own run there is nothing to compare with: low, never pre-existing
    confidence: ctx.base !== undefined || ctx.defaultBranch ? "high" : "low",
    evidence,
  };
}

export function classifyCause(cause: FailureCause, ctx: ClassifyContext, settings: TriageSettings): Verdict {
  return (
    matchInfra(cause, settings.infraPatterns) ??
    matchExit(cause, ctx, settings) ??
    matchFlaky(cause, ctx) ??
    matchPreExisting(cause, ctx) ??
    codeVerdict(cause, ctx)
  );
}
