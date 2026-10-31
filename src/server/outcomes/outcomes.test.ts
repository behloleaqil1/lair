/**
 * The outcome tracker, driven through its real entry points: the real
 * Decision Inbox and store (in memory), the real event bus, the real fact log,
 * the real mount. Fakes are only the clock and, in the rule tests, the time
 * of a fact (events carry the bus's own time, so those tests write the fact
 * log directly at chosen times).
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Decision } from "../../shared/decision-types.js";
import { exampleFromDecision, splitLabels } from "../brain-trainer/examples.js";
import { EventBus } from "../core/event-bus.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import type { RaiseDecisionInput } from "../decisions/types.js";
import { parseOutcomeTrackerConfig } from "./config.js";
import { FactLog, factsFromEvent } from "./facts.js";
import { mountOutcomeTracker } from "./index.js";
import { OutcomeTracker } from "./service.js";
import type { Fact, WindowHours } from "./types.js";

const T0 = Date.parse("2026-03-02T08:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOWS: WindowHours = { restart: 24, hold: 6, release: 24, planner: 72, merge: 24 };

const dirs: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-outcomes-"));
  dirs.push(dir);
  return dir;
}

class FakeClock {
  t = T0;
  now(): number {
    return this.t;
  }
}

function harness(options: { factsPath?: string; storePath?: string; windows?: WindowHours; since?: string; batch?: number } = {}) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  bus.on("decision.outcome", (e) => {
    events.push({ type: e.type, data: e.data });
  });
  const store = new DecisionStore(options.storePath ?? ":memory:");
  closers.push(() => store.close());
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus, clock });
  const facts = new FactLog(options.factsPath ?? ":memory:");
  closers.push(() => facts.close());
  let nowMs = T0;
  const tracker = new OutcomeTracker({
    decisions: inbox,
    facts,
    events: bus,
    windows: options.windows ?? WINDOWS,
    checkMinutes: 10,
    since: options.since,
    batch: options.batch,
    clock: () => new Date(nowMs),
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return {
    clock,
    bus,
    inbox,
    store,
    facts,
    tracker,
    events,
    at: (ms: number) => (nowMs = T0 + ms),
    fact: (offsetMs: number, f: Omit<Fact, "at" | "project">) => facts.add({ at: iso(T0 + offsetMs), project: "demo", ...f }),
  };
}
type H = ReturnType<typeof harness>;

const TASK = "feat-search";

function escalation(key = "escalation:c1:3", task = TASK): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "escalation",
    title: "Worker-a is paused",
    context: "It failed.",
    options: [
      { id: "fresh_session", label: "Start it again", consequences: "A fresh session." },
      { id: "release", label: "Leave it", consequences: "Unclaimed." },
    ],
    recommended: { optionId: "release", reasoning: "r" },
    source: { module: "agents", ref: "chain:c1" },
    key,
    blocks: [`agents:demo:task:${task}`],
  };
}

function exhausted(task = TASK): RaiseDecisionInput {
  return {
    ...escalation(`exhausted:c1`, task),
    options: [
      { id: "wait", label: "Wait", consequences: "Wait for the cooldown." },
      { id: "stop", label: "Stop", consequences: "Stop the task." },
    ],
    recommended: { optionId: "wait", reasoning: "r" },
  };
}

function planner(): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: "Apply the planner's proposals",
    context: "Two proposals.",
    options: [
      { id: "approve_all", label: "Apply", consequences: "Applied." },
      { id: "reject_all", label: "Reject", consequences: "Nothing." },
    ],
    recommended: { optionId: "approve_all", reasoning: "r" },
    source: { module: "planner", ref: "run-1" },
    key: "approve:run-1",
    blocks: [],
  };
}

function mergeHold(): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: "A merge is held",
    context: "Held.",
    options: [
      { id: "release", label: "Release", consequences: "Merge." },
      { id: "keep", label: "Keep", consequences: "Hold." },
    ],
    recommended: { optionId: "keep", reasoning: "r" },
    source: { module: "review-holds", ref: "review:demo:pr:42" },
    key: "hold:42",
    blocks: ["review:demo:pr:42"],
  };
}

/** Raise a minute before `at` and answer at `at` (milliseconds after T0). */
async function answered(h: H, input: RaiseDecisionInput, optionId: string, at = 0): Promise<Decision> {
  h.clock.t = T0 + at - MIN;
  const { decision } = await h.inbox.raise(input);
  h.clock.t = T0 + at;
  return h.inbox.answer(decision.id, { optionId });
}

const now = (h: H, id: string) => h.inbox.get(id)!;

describe("restart answers", () => {
  it("good: the task is marked done within the window", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(2 * HOUR, { code: "task_done", task: TASK });
    h.at(3 * HOUR);
    expect(await h.tracker.sweep()).toBe(1);
    expect(now(h, d.id)).toMatchObject({
      outcome: "good",
      outcomeAt: iso(T0), // the inbox's clock
      outcomeEvidence: { rule: "restart", fact: "task_done", task: TASK },
    });
  });

  it("a run that exits well is not done: it settles nothing, and a pause after it is bad", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(HOUR, { code: "run_completed", task: TASK });
    h.at(2 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    expect(now(h, d.id).outcome).toBeUndefined();
    h.fact(3 * HOUR, { code: "task_paused", task: TASK });
    h.at(4 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "restart", fact: "task_paused" } });
  });

  it("a run that exits well and nothing more by the end of the window is unknown, not good", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(HOUR, { code: "run_completed", task: TASK });
    h.at(24 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { reason: "window_ended" } });
  });

  it("bad: the task fails again", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(HOUR, { code: "task_failed", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "restart", fact: "task_failed" } });
  });

  it("bad: the task is paused (escalated) again", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(HOUR, { code: "task_paused", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("bad");
  });

  it("the first signal in time settles it, and another task's facts do not count", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(30 * MIN, { code: "task_failed", task: "other-task" });
    h.fact(HOUR, { code: "task_failed", task: TASK });
    h.fact(2 * HOUR, { code: "run_completed", task: TASK });
    h.at(3 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("bad");
  });

  it("unknown: nothing happened by the end of the window; pending until then", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.at(23 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    expect(now(h, d.id).outcome).toBeUndefined();
    h.at(24 * HOUR);
    expect(await h.tracker.sweep()).toBe(1);
    expect(now(h, d.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { rule: "restart", reason: "window_ended" } });
  });

  it("window edges: a fact at the end counts, a fact a millisecond later or at the answer itself does not", async () => {
    const atEnd = harness();
    const a = await answered(atEnd, escalation(), "fresh_session");
    atEnd.fact(24 * HOUR, { code: "task_failed", task: TASK });
    atEnd.at(25 * HOUR);
    await atEnd.tracker.sweep();
    expect(now(atEnd, a.id).outcome).toBe("bad");

    const late = harness();
    const b = await answered(late, escalation(), "fresh_session");
    late.fact(24 * HOUR + 1, { code: "task_failed", task: TASK });
    late.fact(0, { code: "task_failed", task: TASK }); // the failure that was answered
    late.at(25 * HOUR);
    await late.tracker.sweep();
    expect(now(late, b.id).outcome).toBe("unknown");
  });
});

describe("wait / hold answers", () => {
  it("good: a run of the held task completes (the cause cleared)", async () => {
    const h = harness();
    const d = await answered(h, exhausted(), "wait");
    h.fact(2 * HOUR, { code: "run_completed", task: TASK });
    h.at(3 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "good", outcomeEvidence: { rule: "hold", fact: "run_completed" } });
  });

  it("a probe start is not a cleared hold: a start alone settles nothing, and a start that then fails is not good", async () => {
    const h = harness();
    const d = await answered(h, exhausted(), "wait");
    h.fact(HOUR, { code: "run_started", task: TASK });
    h.fact(HOUR + MIN, { code: "task_failed", task: TASK });
    h.at(2 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    expect(now(h, d.id).outcome).toBeUndefined();
    h.at(6 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { reason: "window_ended" } });
  });

  it("bad: the same hold is raised again for the same cause; another cause does not count", async () => {
    const h = harness();
    const d = await answered(h, exhausted(), "wait");
    h.fact(HOUR, { code: "hold_raised", family: "agents/signin:codex", task: TASK });
    h.fact(2 * HOUR, { code: "hold_raised", family: "agents/chain:c1", task: TASK });
    h.at(3 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "hold", fact: "hold_raised", factAt: iso(T0 + 2 * HOUR) } });
  });

  it("unknown when the window (6 hours) ends quietly", async () => {
    const h = harness();
    const d = await answered(h, exhausted(), "wait");
    h.fact(7 * HOUR, { code: "run_completed", task: TASK });
    h.at(7 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("unknown");
  });
});

describe("release / stand-down answers", () => {
  it("bad: the same task is escalated again", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "release");
    h.fact(5 * HOUR, { code: "task_paused", task: TASK });
    h.at(6 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "release", fact: "task_paused" } });
  });

  it("unknown: a quiet window is no proof it was right, and another task's escalation is not this one's", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "release");
    h.fact(5 * HOUR, { code: "task_paused", task: "other-task" });
    h.fact(6 * HOUR, { code: "run_completed", task: TASK });
    h.at(24 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("unknown");
  });

  it("a stop answer is judged the same way", async () => {
    const h = harness();
    const d = await answered(h, exhausted(), "stop");
    h.fact(HOUR, { code: "task_paused", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("bad");
  });
});

describe("planner proposals", () => {
  it("good: every task it added reaches done", async () => {
    const h = harness();
    const d = await answered(h, planner(), "approve_all");
    h.fact(MIN, { code: "task_added", task: "feat-a" });
    h.fact(MIN, { code: "task_added", task: "feat-b" });
    h.fact(5 * HOUR, { code: "task_done", task: "feat-a" });
    h.at(6 * HOUR);
    expect(await h.tracker.sweep()).toBe(0); // one of two is not enough
    h.fact(8 * HOUR, { code: "run_completed", task: "feat-b" });
    h.at(9 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "good", outcomeEvidence: { rule: "planner", added: 2, done: 2 } });
  });

  it("bad: an added task is dropped or rewritten after it was applied", async () => {
    const dropped = harness();
    const a = await answered(dropped, planner(), "approve_all");
    dropped.fact(MIN, { code: "task_added", task: "feat-a" });
    dropped.fact(2 * HOUR, { code: "task_dropped", task: "feat-a" });
    dropped.at(3 * HOUR);
    await dropped.tracker.sweep();
    expect(now(dropped, a.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "planner", fact: "task_dropped" } });

    const reworded = harness();
    const b = await answered(reworded, planner(), "approve_all");
    reworded.fact(MIN, { code: "task_added", task: "feat-a" });
    reworded.fact(2 * HOUR, { code: "task_reworded", task: "feat-a" });
    reworded.at(3 * HOUR);
    await reworded.tracker.sweep();
    expect(now(reworded, b.id).outcome).toBe("bad");
  });

  it("unknown: nothing it added is settled when the window (72 hours) ends; a rejection has no rule", async () => {
    const h = harness();
    const d = await answered(h, planner(), "approve_all");
    h.fact(MIN, { code: "task_added", task: "feat-a" });
    h.fact(HOUR, { code: "task_dropped", task: "never-added" });
    h.at(72 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("unknown");

    const rejected = harness();
    const r = await answered(rejected, planner(), "reject_all");
    rejected.at(MIN);
    await rejected.tracker.sweep();
    expect(now(rejected, r.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { reason: "no_rule" } });
  });
});

describe("merges and reviews", () => {
  it("bad: the default branch turns red on the merged commit (the review was a miss)", async () => {
    const h = harness();
    const d = await answered(h, mergeHold(), "release");
    h.fact(10 * MIN, { code: "merged", pr: 42, sha: "abc123" });
    h.fact(2 * HOUR, { code: "default_red", sha: "abc123" });
    h.at(3 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({
      outcome: "bad",
      outcomeEvidence: { rule: "merge", fact: "default_red", pr: 42, review_miss: true },
    });
  });

  it("bad: a revert of the merge lands", async () => {
    const h = harness();
    const d = await answered(h, mergeHold(), "release");
    h.fact(10 * MIN, { code: "merged", pr: 42, sha: "abc123" });
    h.fact(5 * HOUR, { code: "reverted", sha: "abc123" });
    h.at(6 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { fact: "reverted" } });
  });

  it("unknown: another commit's trouble, another pull request's merge, or no merge at all", async () => {
    const h = harness();
    const d = await answered(h, mergeHold(), "release");
    h.fact(10 * MIN, { code: "merged", pr: 42, sha: "abc123" });
    h.fact(HOUR, { code: "default_red", sha: "other" });
    h.fact(2 * HOUR, { code: "merged", pr: 43, sha: "def456" });
    h.fact(3 * HOUR, { code: "reverted", sha: "def456" });
    h.at(24 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id).outcome).toBe("unknown");

    const none = harness();
    const n = await answered(none, mergeHold(), "release");
    none.fact(HOUR, { code: "reverted", sha: "abc123" });
    none.at(24 * HOUR);
    await none.tracker.sweep();
    expect(now(none, n.id).outcome).toBe("unknown");
  });
});

describe("what the rules cannot judge", () => {
  it("stays unknown at once: a decision with no rule, and an answer the inbox applied itself", async () => {
    const h = harness();
    const other = await answered(h, { ...escalation("other:1"), source: { module: "custom", ref: "x" } }, "release");
    h.clock.t = T0;
    const expiring = (
      await h.inbox.raise({ ...escalation("escalation:c9:1"), kind: "other", expiresAt: iso(T0 + HOUR), defaultOptionId: "release" })
    ).decision;
    h.clock.t = T0 + 2 * HOUR;
    await h.inbox.expireDue();
    h.at(2 * HOUR);
    await h.tracker.sweep();
    expect(now(h, other.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { reason: "no_rule" } });
    // Expired, not answered by a person: it is no label, so it gets no outcome
    expect(now(h, expiring.id)).toMatchObject({ status: "expired" });
    expect(now(h, expiring.id).outcome).toBeUndefined();
  });
});

describe("one outcome per answer", () => {
  it("a decision answered twice (raised again after a failure) is judged answer by answer", async () => {
    const h = harness();
    const first = await answered(h, escalation("escalation:c1:3"), "fresh_session", 0);
    h.fact(HOUR, { code: "task_failed", task: TASK }); // after the first answer, before the second
    const second = await answered(h, escalation("escalation:c1:4"), "fresh_session", 2 * HOUR);
    h.fact(3 * HOUR, { code: "run_completed", task: TASK });
    h.at(4 * HOUR);
    await h.tracker.sweep();
    expect(now(h, first.id).outcome).toBe("bad"); // the first restart failed again at +1h
    expect(now(h, second.id).outcome).toBe("good"); // the failure at +1h was before its answer
  });

  it("an outcome is never replaced, and one for an answer that was undone is refused", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    h.fact(HOUR, { code: "task_failed", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    const before = now(h, d.id);
    h.fact(90 * MIN, { code: "run_completed", task: TASK });
    h.at(3 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    expect(now(h, d.id)).toEqual(before);
    expect(h.store.setOutcome(d.id, before.answeredAt!, "good", iso(T0), {})).toBe(false);
    expect(h.store.setOutcome(d.id, "2020-01-01T00:00:00.000Z", "good", iso(T0), {})).toBe(false);
  });

  it("a restart in the middle of a window picks it up from the saved facts, once", async () => {
    const dir = tempDir();
    const paths = { factsPath: join(dir, "outcomes.db"), storePath: join(dir, "decisions.db") };
    const first = harness(paths);
    const d = await answered(first, escalation(), "fresh_session");
    first.fact(HOUR, { code: "task_failed", task: TASK });
    first.at(30 * MIN);
    expect(await first.tracker.sweep()).toBe(0); // the failure is still in the future: pending
    first.tracker.stop();
    first.facts.close();
    first.store.close();

    const second = harness(paths);
    second.at(2 * HOUR);
    expect(await second.tracker.sweep()).toBe(1);
    expect(await second.tracker.sweep()).toBe(0);
    expect(second.events).toHaveLength(1);
    expect(now(second, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { fact: "task_failed" } });
  });
});

describe("read-only towards the rest of Lair", () => {
  it("changes only the outcome fields of a decision, and says so with one event", async () => {
    const h = harness();
    const d = await answered(h, escalation(), "fresh_session");
    const before = JSON.parse(JSON.stringify(h.inbox.get(d.id)));
    h.fact(HOUR, { code: "task_failed", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    const after = JSON.parse(JSON.stringify(h.inbox.get(d.id)));
    const { outcome, outcomeAt, outcomeEvidence, ...rest } = after;
    expect([outcome, typeof outcomeAt, typeof outcomeEvidence]).toEqual(["bad", "string", "object"]);
    expect(rest).toEqual(before);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].data).toMatchObject({ decisionId: d.id, outcome: "bad", evidence: { rule: "restart" } });
    // The audit trail still ends where it did: nothing was answered, retried or reopened
    expect(h.inbox.get(d.id)!.audit!.map((a) => a.action)).toEqual(before.audit.map((a: { action: string }) => a.action));
  });

  it("the evidence holds codes and ids, never prose", async () => {
    const h = harness();
    const d = await answered(h, { ...escalation(), title: "Do not echo this title", context: "Nor this context" }, "fresh_session");
    h.fact(HOUR, { code: "task_failed", task: TASK });
    h.at(2 * HOUR);
    await h.tracker.sweep();
    const text = JSON.stringify(now(h, d.id).outcomeEvidence) + JSON.stringify(h.events[0].data);
    expect(text).not.toContain("echo this");
    expect(text).not.toContain("this context");
  });
});

describe("the bus", () => {
  it("turns events into facts, and a verdict follows through the mount", async () => {
    const dir = tempDir();
    const configPath = join(dir, "server.yaml");
    writeFileSync(configPath, "outcome_tracker:\n  enabled: true\n  check_minutes: 5\n");
    chmodSync(configPath, 0o600);
    const bus = new EventBus();
    const store = new DecisionStore(":memory:");
    closers.push(() => store.close());
    const clock = new FakeClock();
    // The inbox's clock runs a minute behind real time so the event's own time is after the answer
    clock.t = Date.now() - 5 * MIN;
    const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus, clock });
    const app = Fastify();
    closers.push(() => void app.close());
    const tracker = mountOutcomeTracker(app, {
      configPath,
      dbPath: join(dir, "outcomes.db"),
      decisions: inbox,
      events: bus,
      timers: { setInterval: () => 0, clearInterval: () => undefined },
      clock: () => new Date(Date.now() + HOUR),
    });
    expect(tracker).not.toBeNull();
    const { decision } = await inbox.raise(escalation());
    await inbox.answer(decision.id, { optionId: "fresh_session" });
    await bus.emit("agent.recovery", { project: "demo", kind: "crashed", task: TASK, agent: "worker-a", summary: "free text is not kept" });
    await tracker!.sweep();
    expect(inbox.get(decision.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "restart", fact: "task_failed", task: TASK } });
  });

  it("maps the events the rules use, ignores the rest and malformed data", () => {
    const e = (type: string, data: Record<string, unknown>) => ({ id: "x", type: type as never, timestamp: iso(T0), data });
    expect(factsFromEvent(e("agent.recovery", { project: "demo", kind: "escalated", task: "t" }))).toMatchObject([{ code: "task_paused", task: "t" }]);
    expect(factsFromEvent(e("agent.recovery", { project: "demo", kind: "failover", task: "t" }))).toEqual([]);
    expect(factsFromEvent(e("agent.recovery", { kind: "crashed", task: "t" }))).toEqual([]);
    expect(factsFromEvent(e("agent.run.started", { project: "demo", task: 5 }))).toEqual([]);
    expect(factsFromEvent(e("planner.changed", { project: "demo", op: "mark_done", task: "t", outcome: "applied" }))).toMatchObject([{ code: "task_done" }]);
    expect(factsFromEvent(e("planner.changed", { project: "demo", op: "drop", task: "t", outcome: "planned" }))).toEqual([]);
    expect(factsFromEvent(e("review.merged", { project: "demo", pr: 7, resultSha: "abc" }))).toMatchObject([{ code: "merged", pr: 7, sha: "abc" }]);
    expect(factsFromEvent(e("review.merged", { project: "demo", pr: "7", resultSha: "abc" }))).toEqual([]);
    // A revert that was only asked for may be declined or fail: it is no fact. A proven culprit is.
    expect(factsFromEvent(e("triage.revert_requested", { project: "demo", sha: "abc" }))).toEqual([]);
    expect(factsFromEvent(e("triage.culprit_found", { project: "demo", sha: "abc" }))).toMatchObject([{ code: "default_red", sha: "abc" }]);
    expect(
      factsFromEvent(e("decision.raised", { project: "demo", module: "agents", key: "exhausted:c1", ref: "chain:c1", blocks: ["agents:demo:task:t"] })),
    ).toMatchObject([{ code: "hold_raised", family: "agents/chain:c1", task: "t" }]);
    // No ref, no usable cause
    expect(factsFromEvent(e("decision.raised", { project: "demo", module: "agents", key: "exhausted:c1" }))).toEqual([]);
  });
});

describe("off by default", () => {
  it("opens nothing and subscribes to nothing without the section, with it disabled, or with a refused one", () => {
    for (const yaml of [null, "outcome_tracker:\n  enabled: false\n", "outcome_tracker:\n  enabled: true\n  surprise: 1\n"]) {
      const dir = tempDir();
      const configPath = join(dir, "server.yaml");
      if (yaml !== null) {
        writeFileSync(configPath, yaml);
        chmodSync(configPath, 0o600);
      }
      const bus = new EventBus();
      const app = Fastify();
      closers.push(() => void app.close());
      const lines: string[] = [];
      const tracker = mountOutcomeTracker(app, {
        configPath,
        dbPath: join(dir, "outcomes.db"),
        decisions: { awaitingOutcome: () => [], recordOutcome: () => false },
        events: bus,
        log: (l) => lines.push(l),
      });
      expect(tracker).toBeNull();
      expect(existsSync(join(dir, "outcomes.db"))).toBe(false);
      if (yaml?.includes("surprise")) expect(lines.join(" ")).toContain("outcome_tracker");
    }
  });

  it("parses the section, with defaults and bounds", () => {
    expect(parseOutcomeTrackerConfig({})).toMatchObject({ ok: true, settings: { enabled: false } });
    expect(parseOutcomeTrackerConfig({ outcome_tracker: { enabled: true, hold_hours: 2 } })).toMatchObject({
      ok: true,
      settings: { enabled: true, checkMinutes: 10, windows: { restart: 24, hold: 2, release: 24, planner: 72, merge: 24 } },
    });
    expect(parseOutcomeTrackerConfig({ outcome_tracker: { hold_hours: 0 } })).toMatchObject({ ok: false });
    expect(parseOutcomeTrackerConfig({ outcome_tracker: { enabled: "yes" } })).toMatchObject({ ok: false });
  });
});

describe("the store", () => {
  it("adds the outcome columns to a decisions file from before", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "decisions.db");
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL,
        options TEXT NOT NULL, recommended_option TEXT NOT NULL, recommended_reasoning TEXT NOT NULL,
        source_module TEXT NOT NULL, source_ref TEXT NOT NULL, dedupe_key TEXT NOT NULL, links TEXT NOT NULL,
        secret_name TEXT, default_option TEXT, created_at TEXT NOT NULL, expires_at TEXT, overdue_at TEXT,
        status TEXT NOT NULL, answer_option TEXT, answer_note TEXT, answer_secret_supplied INTEGER NOT NULL DEFAULT 0,
        answered_by TEXT, answered_at TEXT, withdrawn_reason TEXT, closed_at TEXT, delivered_at TEXT,
        delivery_error TEXT, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action'
      );
      INSERT INTO decisions (id, project, kind, title, context, options, recommended_option, recommended_reasoning,
        source_module, source_ref, dedupe_key, links, created_at, status, answer_option, answered_by, answered_at)
      VALUES ('0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b', 'demo', 'other', 'Old one', 'c',
        '[{"id":"ok","label":"OK","consequences":"x"},{"id":"no","label":"No","consequences":"y"}]', 'ok', 'r', 'agents', 'r', 'k', '[]',
        '2026-03-01T00:00:00.000Z', 'answered', 'ok', 'owner', '2026-03-01T01:00:00.000Z');
    `);
    old.pragma("user_version = 3");
    old.close();
    const store = new DecisionStore(dbPath);
    closers.push(() => store.close());
    expect(store.awaitingOutcome(10).map((d) => d.id)).toEqual(["0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b"]);
    expect(store.setOutcome("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b", "2026-03-01T01:00:00.000Z", "good", "2026-03-02T00:00:00.000Z", { rule: "x" })).toBe(true);
    expect(store.awaitingOutcome(10)).toEqual([]);
    expect(store.get("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b")).toMatchObject({ outcome: "good", outcomeEvidence: { rule: "x" } });
  });
});

describe("the brain trainer reads the outcome", () => {
  it("a bad outcome makes the answer a negative example; good stays positive; the tracker's unknown is no label", async () => {
    const h = harness();
    const bad = await answered(h, escalation("escalation:c1:1", "t-bad"), "fresh_session", 0);
    const good = await answered(h, escalation("escalation:c1:2", "t-good"), "fresh_session", MIN);
    const unknown = await answered(h, { ...escalation("other:1"), source: { module: "custom", ref: "x" } }, "release", 2 * MIN);
    const untracked = await answered(h, escalation("escalation:c1:5", "t-none"), "fresh_session", 3 * MIN);
    h.fact(HOUR, { code: "task_failed", task: "t-bad" });
    h.fact(HOUR, { code: "task_done", task: "t-good" });
    h.at(2 * HOUR);
    // The untracked one is judged too late to matter here: take its example before the sweep
    const before = exampleFromDecision(now(h, untracked.id));
    await h.tracker.sweep();
    expect(before?.outcome).toBe("unknown");
    const examples = [bad, good, unknown].map((d) => exampleFromDecision(now(h, d.id))!);
    // The tracker's own unknown means it could not tell
    expect(examples.map((e) => e.outcome)).toEqual(["bad", "good", "inconclusive"]);
    const sets = splitLabels(examples);
    expect(sets.negative.map((e) => e.id)).toEqual([bad.id]);
    expect(sets.positive.map((e) => e.id)).toEqual([good.id]);
    expect(sets.pending.map((e) => e.id)).toEqual([unknown.id]);
    expect(examples[0].outcomeAt).toBe(now(h, bad.id).outcomeAt);
  });
});

describe("hold answers judge the same cause", () => {
  function signIn(tool: string): RaiseDecisionInput {
    return {
      project: "demo",
      kind: "other",
      title: `${tool} is not signed in`,
      context: "Signed out.",
      options: [
        { id: "wait", label: "Keep waiting", consequences: "Waits." },
        { id: "retry_now", label: "Check again", consequences: "Checks." },
      ],
      recommended: { optionId: "retry_now", reasoning: "r" },
      source: { module: "agents", ref: `signin:${tool}` },
      key: `signin:${tool}:mac-1`,
      blocks: [`agents:demo:tool:${tool}`],
    };
  }

  function outage(provider: string, tasks: string[]): RaiseDecisionInput {
    return {
      ...signIn(provider),
      kind: "escalation",
      source: { module: "agents", ref: `transient:${provider}` },
      key: `transient:${provider}:1000`,
      blocks: tasks.map((t) => `agents:demo:task:${t}`),
    };
  }

  it("bad: the same tool's sign-in hold is raised again; another tool's does not count", async () => {
    const h = harness();
    const d = await answered(h, signIn("codex"), "wait");
    h.fact(HOUR, { code: "hold_raised", family: "agents/signin:claude" });
    h.at(2 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    h.fact(3 * HOUR, { code: "hold_raised", family: "agents/signin:codex" });
    h.at(4 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "hold", family: "agents/signin:codex" } });
  });

  it("an outage hold: another provider's outage is not this one's, and any of its waiting tasks completing is good", async () => {
    const h = harness();
    const d = await answered(h, outage("anthropic", ["t1", "t2", "t3"]), "wait");
    h.fact(HOUR, { code: "hold_raised", family: "agents/transient:openai" });
    h.fact(2 * HOUR, { code: "run_completed", task: "unrelated" });
    h.at(3 * HOUR);
    expect(await h.tracker.sweep()).toBe(0);
    h.fact(4 * HOUR, { code: "run_completed", task: "t3" });
    h.at(5 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "good", outcomeEvidence: { rule: "hold", fact: "run_completed", task: "t3" } });
  });

  it("through the bus: the fact carries the ref, so a hold of another tool is another family", async () => {
    const h = harness();
    h.tracker.subscribe();
    await h.bus.emit("decision.raised", { project: "demo", module: "agents", key: "signin:claude:mac-1", ref: "signin:claude", blocks: ["agents:demo:tool:claude"] });
    const facts = h.facts.between("demo", "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    expect(facts).toMatchObject([{ code: "hold_raised", family: "agents/signin:claude" }]);
    expect(facts[0].task).toBeUndefined();
  });
});

describe("merge answers count from the merge", () => {
  it("a proven culprit inside the window after the merge is bad, even past the window after the answer", async () => {
    const h = harness();
    const d = await answered(h, mergeHold(), "release");
    h.fact(20 * HOUR, { code: "merged", pr: 42, sha: "abc123" });
    h.fact(40 * HOUR, { code: "default_red", sha: "abc123" });
    h.at(41 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "merge", fact: "default_red", pr: 42 } });
  });

  it("a culprit after the window that started at the merge is not counted", async () => {
    const h = harness();
    const d = await answered(h, mergeHold(), "release");
    h.fact(20 * HOUR, { code: "merged", pr: 42, sha: "abc123" });
    h.fact(45 * HOUR, { code: "default_red", sha: "abc123" });
    h.at(45 * HOUR);
    await h.tracker.sweep();
    expect(now(h, d.id)).toMatchObject({ outcome: "unknown", outcomeEvidence: { reason: "window_ended" } });
  });

  it("a revert only requested is no revert: the event makes no fact", async () => {
    const h = harness();
    h.tracker.subscribe();
    await h.bus.emit("triage.revert_requested", { project: "demo", incidentId: "i1", sha: "abc123", by: null });
    expect(h.facts.between("demo", "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("what waits for an outcome", () => {
  it("a sweep pages through every waiting answer: undecided ones in front do not hide the rest", async () => {
    const h = harness({ batch: 2 });
    const quiet: Decision[] = [];
    for (let i = 0; i < 4; i++) quiet.push(await answered(h, escalation(`escalation:c1:q${i}`, `quiet-${i}`), "fresh_session", i * MIN));
    const done = await answered(h, escalation("escalation:c1:d", "done-task"), "fresh_session", 5 * MIN);
    h.fact(HOUR, { code: "task_done", task: "done-task" });
    h.at(2 * HOUR);
    expect(await h.tracker.sweep()).toBe(1);
    expect(now(h, done.id).outcome).toBe("good");
    for (const q of quiet) expect(now(h, q.id).outcome).toBeUndefined();
  });

  it("answers given before the tracker first ran are left alone, never stamped unknown", async () => {
    const h = harness({ since: iso(T0 + HOUR) });
    const before = await answered(h, escalation("escalation:c1:old", "old-task"), "fresh_session", 0);
    const after = await answered(h, escalation("escalation:c1:new", "new-task"), "fresh_session", 2 * HOUR);
    h.fact(3 * HOUR, { code: "task_done", task: "new-task" });
    h.at(30 * HOUR);
    await h.tracker.sweep();
    expect(now(h, before.id).outcome).toBeUndefined();
    expect(now(h, after.id).outcome).toBe("good");
  });

  it("the fact log keeps the first start time across opens", () => {
    const dir = tempDir();
    const path = join(dir, "outcomes.db");
    const first = new FactLog(path);
    expect(first.enabledSince("2026-03-02T08:00:00.000Z")).toBe("2026-03-02T08:00:00.000Z");
    first.close();
    const second = new FactLog(path);
    closers.push(() => second.close());
    expect(second.enabledSince("2026-04-01T00:00:00.000Z")).toBe("2026-03-02T08:00:00.000Z");
  });
});

describe("the store opens a file from every older version", () => {
  const COMMON = `
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL,
    options TEXT NOT NULL, recommended_option TEXT NOT NULL, recommended_reasoning TEXT NOT NULL,
    source_module TEXT NOT NULL, source_ref TEXT NOT NULL, dedupe_key TEXT NOT NULL, links TEXT NOT NULL,
    secret_name TEXT, default_option TEXT, created_at TEXT NOT NULL, expires_at TEXT, overdue_at TEXT,
    status TEXT NOT NULL, answer_option TEXT, answer_note TEXT, answer_secret_supplied INTEGER NOT NULL DEFAULT 0,
    answered_by TEXT, answered_at TEXT, withdrawn_reason TEXT, closed_at TEXT, delivered_at TEXT, delivery_error TEXT`;
  const COLUMNS: Record<number, string> = {
    1: COMMON,
    2: `${COMMON}, raised_via TEXT NOT NULL DEFAULT 'server'`,
    3: `${COMMON}, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action'`,
    // Main's version 4: class and evidence, no outcome
    4: `${COMMON}, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action', class TEXT, evidence TEXT`,
  };
  const ID = "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b";

  for (const version of [1, 2, 3, 4]) {
    it(`version ${version}: the outcome columns are added and the tracker works`, () => {
      const dbPath = join(tempDir(), "decisions.db");
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE decisions (${COLUMNS[version]});
        INSERT INTO decisions (id, project, kind, title, context, options, recommended_option, recommended_reasoning,
          source_module, source_ref, dedupe_key, links, created_at, status, answer_option, answered_by, answered_at)
        VALUES ('${ID}', 'demo', 'other', 'Old one', 'c',
          '[{"id":"ok","label":"OK","consequences":"x"},{"id":"no","label":"No","consequences":"y"}]', 'ok', 'r', 'agents', 'r', 'k', '[]',
          '2026-03-01T00:00:00.000Z', 'answered', 'ok', 'owner', '2026-03-01T01:00:00.000Z');
      `);
      old.pragma(`user_version = ${version}`);
      old.close();
      const store = new DecisionStore(dbPath);
      closers.push(() => store.close());
      expect(store.awaitingOutcome(10).map((d) => d.id)).toEqual([ID]);
      expect(store.setOutcome(ID, "2026-03-01T01:00:00.000Z", "bad", "2026-03-02T00:00:00.000Z", { rule: "x" })).toBe(true);
      expect(store.get(ID)).toMatchObject({ outcome: "bad", outcomeEvidence: { rule: "x" } });
      // And class/evidence from main's version 4 are still there to write
      expect(new Database(dbPath, { readonly: true }).prepare("SELECT class, evidence FROM decisions").all()).toEqual([{ class: null, evidence: null }]);
    });
  }
});
