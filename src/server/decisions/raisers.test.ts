/**
 * Every module that raises a decision gives it a class, evidence and an
 * effect on each option (docs/design/decision-policies.md §4, rollout 1).
 *
 * The first test lists the raisers in src/server by reading the sources: a
 * file that raises a decision and is not listed here fails it, and so does a
 * listed file that no longer carries its classes. The others run the
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

describe("the modules that raise decisions", () => {
  it("each set class, evidence and option effects: a new raiser must be listed here", () => {
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
    const found = sources(SERVER)
      .map((path) => relative(SERVER, path))
      .filter((file) => !PLUMBING.has(file))
      .filter((file) => RAISE_CALL.test(readFileSync(join(SERVER, file), "utf8")))
      .sort();
    expect(found).toEqual(Object.keys(RAISERS).sort());

    for (const [file, classes] of Object.entries(RAISERS)) {
      const text = readFileSync(join(SERVER, file), "utf8");
      expect(text, `${file} sets evidence`).toMatch(/evidence: \{/);
      expect(text, `${file} sets an effect on its options`).toMatch(/effect: "|effects: \[/);
      for (const id of classes) expect(text, `${file} sets class ${id}`).toContain(id);
    }
  });

  it("the classes they set that are in the policy table use its modules", () => {
    for (const id of Object.keys(KNOWN_DECISION_CLASSES)) {
      expect(id).toMatch(/^(agents|supervisor|watchdog|planner|triage|review)\.[a-z_]+$/);
    }
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
