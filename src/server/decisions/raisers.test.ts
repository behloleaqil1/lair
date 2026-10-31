/**
 * Every module that raises a decision gives it a class, evidence and an
 * effect on each option (docs/design/decision-policies.md §4, rollout 1).
 *
 * The first test reads the sources in src/server and checks each raise call
 * on its own: one that passes an object and lacks a class, evidence or
 * effects fails, whatever the other calls in its file do, and so does a file
 * that raises and is not listed. The decisions each real module builds are
 * checked at run time too: testing/raise-guard.ts (a setup file) fails any test,
 * outside the inbox's own, in which a module raised through the real inbox
 * without them or with a structure the schema refused. The rest run the
 * adapters between a module's request and the inbox, and the builders that
 * need no setup, through the inbox's own schema check.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { toRaiseInput } from "../agents/decisions.js";
import { InboxDecisions } from "../triage/adapters.js";
import { inboxDecisionSink } from "../review/ports.js";
import { noticeFor } from "../supervisor/notices.js";
import { HoldDecisions } from "./holds.js";
import { toDecisionInput } from "./request-bridge.js";
import { KNOWN_DECISION_CLASSES } from "./structure.js";
import { decisionFor } from "../watchdog/escalation.js";
import { DETECTOR_IDS, type Breach } from "../watchdog/types.js";
import type { WatchdogContext } from "../watchdog/view.js";
import { parseRaiseInput } from "./validate.js";
import type { CheckResult } from "../../shared/supervisor-types.js";
import type { DecisionProducer, RaiseDecisionInput } from "./types.js";

const SERVER = join(__dirname, "..");

/** Files that raise decisions, with the classes each one sets. */
const RAISERS: Record<string, string[]> = {
  "agents/service.ts": ["agents.gave_up", "agents.cannot_start", "agents.provider_limit", "agents.budget"],
  "agents/fill.ts": ["agents.gave_up", "agents.cannot_start"],
  "decisions/holds.ts": [".hold"],
  "gates/pipeline-service.ts": ["pipelines.budget"],
  "planner/service.ts": ["planner.tamper", "planner.unblock", "planner.attempts", "planner.failing", "planner.proposal"],
  "review/agent-assigner.ts": ["review.config", "review.stuck"],
  "review/service.ts": ["review.merge_failed", "review.human_review", "review.emails"],
  "supervisor/chat.ts": ["supervisor.digest"],
  "supervisor/notices.ts": ["supervisor.check_failing"],
  "tracker/service.ts": ["tracker.token_scopes"],
  "triage/gate-recheck.ts": ["triage.gate_failure"],
  "triage/service.ts": ["triage.gate_failure", "triage.revert"],
  "watchdog/escalation.ts": ["watchdog."],
};

/** Raise calls: the inbox, a module's own wrapper, or a request handed to a decision hook. */
const RAISE_CALL = /\b(?:inbox|producer|decisions|this|host)\.(?:raise|raiseDecision)\(|\bneedsDecision\(|\.raise\(\s*\{/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * The raise calls of a source: the text of the arguments of each call
 * (`.raise(`, `.raiseDecision(`, `needsDecision(`), found by balancing the parentheses.
 */
function raiseCalls(text: string): string[] {
  const out: string[] = [];
  const opener = /\.(?:raise|raiseDecision)\(|\bneedsDecision\(/g;
  for (let m = opener.exec(text); m; m = opener.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

describe("the modules that raise decisions", () => {
  // The inbox itself, its adapters and the plumbing that only pass a request on
  const PLUMBING = new Set([
    "decisions/service.ts",
    "decisions/request-bridge.ts",
    "decisions/routes.ts",
    "gates/decision-hook.ts",
    "agents/decisions.ts",
    "agents/manager.ts",
    "review/ports.ts",
    "triage/adapters.ts",
  ]);

  it("a new raiser must be listed here", () => {
    const found = sources(SERVER)
      .map((path) => relative(SERVER, path))
      .filter((file) => !PLUMBING.has(file))
      .filter((file) => RAISE_CALL.test(readFileSync(join(SERVER, file), "utf8")))
      .sort();
    expect(found).toEqual(Object.keys(RAISERS).sort());
  });

  it("each raise call that builds its decision sets a class, evidence and an effect, one by one", () => {
    let checked = 0;
    for (const file of Object.keys(RAISERS)) {
      const text = readFileSync(join(SERVER, file), "utf8");
      for (const args of raiseCalls(text)) {
        // A call that passes a request on by name is checked where it is built; a spread passes one on
        if (!args.includes("{") || /\.\.\.(?:rest|input|request)\b/.test(args)) continue;
        checked++;
        const line = text.slice(0, text.indexOf(args)).split("\n").length;
        const site = `${file}:${line}`;
        expect(args, `${site} sets a class`).toMatch(/\bclass: |\bstructure: \{|\bstructure,/);
        expect(args, `${site} sets evidence`).toMatch(/\bevidence\b/);
        expect(args, `${site} sets an effect on its options`).toMatch(/\beffects?\b|\boptions,/);
      }
    }
    // Sites are found, not skipped: a change of shape that finds none fails here
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("every class of the policy table is set by a raiser, with a code of its own", () => {
    const text = Object.keys(RAISERS)
      .map((file) => readFileSync(join(SERVER, file), "utf8"))
      .join("\n");
    for (const [id, { policy, codes }] of Object.entries(KNOWN_DECISION_CLASSES)) {
      expect(codes.length, `${policy} has codes`).toBeGreaterThan(0);
      // The watchdog builds `watchdog.<detector>` from the detector id (checked below)
      if (!id.startsWith("watchdog.")) expect(text, `${policy} ${id} is set by a raiser`).toContain(id);
    }
  });
});

describe("the watchdog's decision for each detector", () => {
  const ctx = { project: "demo", config: {}, settings: { actions: {} } } as unknown as WatchdogContext;
  const breach = (detector: Breach["detector"]): Breach =>
    ({
      id: `b-${detector}`,
      project: "demo",
      detector,
      key: detector,
      summary: `Breach of ${detector}`,
      evidence: ["one line"],
      vars: { ready: "3", queued: "1", running: "0", last_start: "2026-03-02T11:00:00.000Z", claim_age_min: "42", process_found: "false" },
      status: "open",
      detectedAt: "2026-03-02T11:00:00.000Z",
      lastSeenAt: "2026-03-02T11:30:00.000Z",
    }) as unknown as Breach;

  it("passes the schema, with a class, evidence and an effect on every option", () => {
    for (const detector of DETECTOR_IDS) {
      const input = decisionFor(ctx, breach(detector), "escalated");
      expect(input.class, detector).toBe(`watchdog.${detector}`);
      accepted(input);
    }
  });

  it("idle capacity (C3) carries the counts and the last start", () => {
    const input = decisionFor(ctx, breach("idle_capacity"), "escalated");
    expect(input.class).toBe("watchdog.idle_capacity");
    expect(input.evidence?.facts).toMatchObject({ ready_count: 3, queued_count: 1, running_count: 0, last_start: "2026-03-02T11:00:00.000Z" });
  });

  it("an orphan claim (C4) carries the claim's age and whether a process was found", () => {
    const input = decisionFor(ctx, breach("orphan_claim"), "escalated");
    expect(input.class).toBe("watchdog.orphan_claim");
    expect(input.evidence?.code).toBe("claim_orphan");
    expect(input.evidence?.facts).toMatchObject({
      claim_age_min: 42,
      process_found: false,
      release_exit_code: null,
      release_refusal: "not_run",
    });
  });
});

const structure = {
  class: "agents.provider_limit",
  evidence: {
    code: "provider_rate_limit",
    facts: { agent: "agent-a", profiles_failing: 2 },
    cause_cleared: false,
    linked_issue: null,
  },
};

function accepted(input: RaiseDecisionInput): void {
  const parsed = parseRaiseInput(input, Date.parse("2026-03-02T12:00:00.000Z"));
  expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  if (parsed.ok) {
    expect(parsed.value.class).toBe(input.class);
    expect(parsed.value.evidence).toEqual(input.evidence);
    expect(parsed.value.options.every((o) => o.effect !== undefined)).toBe(true);
  }
}

describe("the adapters pass the structure to the inbox", () => {
  it("agents decisions", () => {
    const input = toRaiseInput({
      project: "demo",
      kind: "escalation",
      question: "Every profile is rate limited",
      context: "Both answered with a rate limit.",
      options: [
        { id: "wait", label: "Wait", consequences: "Waits.", effect: "reversible" },
        { id: "stop", label: "Stop", consequences: "Frees the task.", effect: "frees_task" },
      ],
      recommended: "wait",
      reversible: true,
      requestedBy: "agents",
      key: "exhausted:c1",
      structure,
    });
    accepted(input);
  });

  it("requests in the pipelines' and review's shape: one effect per option, in order", () => {
    const input = toDecisionInput({
      key: "k",
      project: "demo",
      kind: "spend",
      question: "Allow more runner minutes?",
      context: "The budget is used.",
      options: ["Keep the budget", "Raise the budget"],
      recommended: "Keep the budget",
      why: "Spending needs approval.",
      reversible: true,
      onTimeout: "wait",
      requestedBy: "pipelines",
      structure: {
        class: "pipelines.budget",
        evidence: { code: "budget_exceeded", facts: { month: "2026-03" }, cause_cleared: false, linked_issue: null },
        effects: ["reversible", "outward"],
      },
    });
    expect(input.options.map((o) => o.effect)).toEqual(["reversible", "outward"]);
    accepted(input);
  });

  it("review's sink", async () => {
    const raised: RaiseDecisionInput[] = [];
    const sink = inboxDecisionSink({
      raise: async (input) => {
        raised.push(input);
        return { decision: { id: "d1" } as never, created: true };
      },
      find: () => null,
      withdraw: async () => ({}) as never,
    });
    await sink.raise({
      project: "demo",
      question: "Automatic merge failed",
      context: "Refused.",
      options: ["Merge it from the page", "Leave it"],
      recommended: "Leave it",
      why: "Not retried at the same head.",
      kind: "other",
      reversible: true,
      requestedBy: "review",
      links: [],
      key: "k",
      structure: {
        class: "review.merge_failed",
        evidence: { code: "merge_error", facts: { pr: 7 }, cause_cleared: false, linked_issue: null },
        effects: ["outward", "reversible"],
      },
    });
    expect(raised).toHaveLength(1);
    accepted(raised[0]);
  });

  it("triage's decisions", async () => {
    const raised: RaiseDecisionInput[] = [];
    const inbox = {
      raise: async (input: RaiseDecisionInput) => {
        raised.push(input);
        return { decision: { id: "d1" } as never, created: true };
      },
    } as unknown as DecisionProducer;
    await new InboxDecisions(inbox).raise({
      project: "demo",
      subject: "infra:r1",
      kind: "escalation",
      question: "A gate still fails with an infrastructure error",
      context: ["Re-checked twice."],
      options: [
        { id: "fix-environment", label: "Fix the environment", consequences: "Nothing runs.", effect: "reversible" },
        { id: "ignore", label: "Ignore", consequences: "The failure stays.", effect: "reversible" },
      ],
      recommended: "fix-environment",
      why: "Re-checks are limited.",
      structure: {
        class: "triage.gate_failure",
        evidence: { code: "infra_other", facts: { recheck_count: 2 }, cause_cleared: false, linked_issue: null },
      },
    });
    accepted(raised[0]);
  });
});

describe("builders that need no setup", () => {
  it("the notice for a failing check", () => {
    const result: CheckResult = {
      id: "event_loop_lag" as CheckResult["id"],
      scope: "server",
      title: "Event loop lag",
      status: "failing",
      values: { lag_ms: 480, label: "slow", ok: false },
      thresholds: { lag_ms: 200 },
      explanation: "The event loop is late.",
      fix: null,
      measuredAt: "2026-03-02T11:59:00.000Z",
      durationMs: 3,
      failingSince: null,
      noticeId: null,
    } as CheckResult;
    const input = noticeFor("demo", result, Date.parse("2026-03-02T11:00:00.000Z"));
    expect(input.class).toBe("supervisor.check_failing");
    expect(input.evidence?.facts).toMatchObject({
      check_id: "event_loop_lag",
      scope: "server",
      failing_since: "2026-03-02T11:00:00.000Z",
      value_lag_ms: 480,
      threshold_lag_ms: 200,
    });
    // Codes and numbers only: a string value of the check is a name, not a fact
    expect(input.evidence?.facts).not.toHaveProperty("value_label");
    accepted(input);
  });

  it("a hold's decision", async () => {
    const raised: RaiseDecisionInput[] = [];
    const producer = {
      find: () => null,
      onResolved: () => () => {},
      raise: async (input: RaiseDecisionInput) => {
        raised.push(input);
        return { decision: { id: "d1" } as never, created: true };
      },
    } as unknown as DecisionProducer;
    const holds = new HoldDecisions("review-holds", "demo");
    holds.use(producer, async () => {});
    await holds.ensure({
      key: "hold:1",
      ref: "pr:7",
      title: "A merge is held",
      context: "Held by the owner.",
      releaseLabel: "Release it",
      releaseConsequences: "The merge goes on.",
      keepLabel: "Keep holding",
      keepConsequences: "Nothing changes.",
    });
    expect(raised).toHaveLength(1);
    accepted(raised[0]);
  });
});
