/**
 * G3's rules (wake-events.ts, docs/design/ai-spend.md §4.5) on the edges the acceptance tests don't reach: each
 * capture refused, the events' data as each emitter sends it (and data that doesn't check), the arrivals kept, and the
 * Decision Inbox's decision read as a wake. The agents module's use of them is in acceptance.test.ts ("AI spend G3").
 */
import { describe, expect, it } from "vitest";
import { WakeArrivals, decisionWake, storedCaptures, wakeCapturesOf, wakeKey, wakeKeyOfEvent, wakeStateOf, wakeTargetOf } from "./wake-events.js";

describe("G3: what a waiting line names", () => {
  it("a PR, a decision or the bus; one per wait (a PR first); anything else is refused, with why", () => {
    expect(wakeTargetOf(wakeCapturesOf({ pr: "42" }))).toEqual({ target: { kind: "pr", pr: 42 }, refused: null });
    expect(wakeTargetOf(wakeCapturesOf({ pr: " 1234567 " }))).toEqual({ target: { kind: "pr", pr: 1234567 }, refused: null });
    expect(wakeTargetOf(wakeCapturesOf({ decision: "3f0c2a8e-5b1d-4c6e-9f00-1a2b3c4d5e6f" })).target).toEqual({
      kind: "decision",
      id: "3f0c2a8e-5b1d-4c6e-9f00-1a2b3c4d5e6f",
    });
    expect(wakeTargetOf(wakeCapturesOf({ message: "BUS" })).target).toEqual({ kind: "message" });
    expect(wakeTargetOf(wakeCapturesOf({ pr: "42", decision: "d-1", message: "bus" })).target).toEqual({ kind: "pr", pr: 42 });
    for (const [captures, why] of [
      [{ pr: "12345678" }, 'PR "12345678" is not a PR number (1 to 7 digits)'],
      [{ pr: "0" }, 'PR "0" is not a PR number (1 to 7 digits)'],
      [{ pr: "../x" }, 'PR "../x" is not a PR number (1 to 7 digits)'],
      [{ decision: "a/b" }, 'decision "a/b" is not a decision id (letters, digits, _ and -, at most 64)'],
      [{ decision: "x".repeat(65) }, `decision "${"x".repeat(64)}" is not a decision id (letters, digits, _ and -, at most 64)`],
      [{ message: "mail" }, 'message "mail" is not "bus"'],
    ] as const) {
      expect(wakeTargetOf(wakeCapturesOf(captures)), JSON.stringify(captures)).toEqual({ target: null, refused: why });
    }
    // No G3 group, or empty ones: nothing named, nothing refused
    expect(wakeCapturesOf({ wake: "gate-1" })).toBeNull();
    expect(wakeCapturesOf({ pr: "  " })).toBeNull();
    expect(wakeTargetOf(null)).toEqual({ target: null, refused: null });
  });

  it("captures kept in a fill_waiting event read back the same; anything else there is no capture", () => {
    expect(storedCaptures({ pr: "42", other: "x" })).toEqual({ pr: "42" });
    expect(storedCaptures({ pr: 42 })).toBeNull();
    expect(storedCaptures("42")).toBeNull();
    expect(storedCaptures(undefined)).toBeNull();
  });
});

describe("G3: the server events, as their emitters send them", () => {
  it("each type's key for its project; another project's event, or data that doesn't check, is none", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    // ReviewService.emit adds the project to each review event
    expect(wakeKeyOfEvent("review.submitted", { project: "demo", pr: 42, headSha: head, reviewer: "worker-b", verdict: "approve", blockingFindings: 0, stale: false }, "demo")).toEqual({
      key: "pr:42",
      event: "review.submitted",
    });
    expect(wakeKeyOfEvent("review.invalidated", { project: "demo", pr: 42, previousHead: head, headSha: head, staleReviews: 1 }, "demo")?.key).toBe("pr:42");
    expect(wakeKeyOfEvent("review.merged", { project: "demo", pr: 7, headSha: head, resultSha: head, method: "local", strategy: "ff-only", tier: "green", by: "owner" }, "demo")?.key).toBe("pr:7");
    expect(wakeKeyOfEvent("review.merge_refused", { project: "demo", pr: 7, headSha: head, reasons: [], refusedBy: "policy", by: "owner" }, "demo")?.key).toBe("pr:7");
    // DecisionInbox: decision.answered and decision.expired carry decisionId and project
    const id = "3f0c2a8e-5b1d-4c6e-9f00-1a2b3c4d5e6f";
    expect(wakeKeyOfEvent("decision.answered", { decisionId: id, project: "demo", kind: "other", module: "planner", optionId: "a", by: "owner", secretSupplied: false }, "demo")).toEqual({
      key: `decision:${id}`,
      event: "decision.answered",
    });
    expect(wakeKeyOfEvent("decision.expired", { decisionId: id, project: "demo", kind: "other", module: "planner", optionId: "a" }, "demo")?.event).toBe("decision.expired");
    // BusService: bus.message carries project and to
    expect(wakeKeyOfEvent("bus.message", { project: "demo", id: "a1b2c3d4", from: "owner", to: "worker-a", priority: 5 }, "demo")?.key).toBe("message:worker-a");

    expect(wakeKeyOfEvent("review.submitted", { project: "other", pr: 42 }, "demo")).toBeNull();
    expect(wakeKeyOfEvent("review.submitted", { pr: 42 }, "demo")).toBeNull();
    for (const pr of [0, -1, 1.5, "42", 10_000_000]) expect(wakeKeyOfEvent("review.merged", { project: "demo", pr }, "demo"), String(pr)).toBeNull();
    expect(wakeKeyOfEvent("decision.answered", { project: "demo", decisionId: "a/b" }, "demo")).toBeNull();
    expect(wakeKeyOfEvent("bus.message", { project: "demo", to: "" }, "demo")).toBeNull();
    expect(wakeKeyOfEvent("decision.withdrawn", { project: "demo", decisionId: id }, "demo")).toBeNull();
    expect(wakeKeyOfEvent("review.submitted", null, "demo")).toBeNull();
  });

  it("an arrival counts from `since` on; the newest of a key wins; at most 2000 keys are kept (the oldest go first)", () => {
    const arrivals = new WakeArrivals();
    arrivals.note("pr:42", "review.submitted", 1_000);
    expect(arrivals.since("pr:42", 1_000)).toEqual({ event: "review.submitted", at: 1_000, source: "event" });
    expect(arrivals.since("pr:42", 1_001)).toBeNull();
    expect(arrivals.since("pr:41", 0)).toBeNull();
    arrivals.note("pr:42", "review.merged", 2_000);
    expect(arrivals.since("pr:42", 1_500)).toMatchObject({ event: "review.merged", at: 2_000 });
    for (let i = 0; i < 2000; i++) arrivals.note(`message:agent-${i}`, "bus.message", 3_000 + i);
    expect(arrivals.since("pr:42", 0)).toBeNull();
    expect(arrivals.since("message:agent-1999", 0)).not.toBeNull();
  });

  it("a key per PR, per decision, and per agent for its messages", () => {
    expect(wakeKey({ kind: "pr", pr: 42 }, "worker-a")).toBe("pr:42");
    expect(wakeKey({ kind: "decision", id: "d-1" }, "worker-a")).toBe("decision:d-1");
    expect(wakeKey({ kind: "message" }, "worker-a")).toBe("message:worker-a");
  });
});

describe("G3: the state check", () => {
  it("reads each target from its module's record, with the time since which it counts; none without that record", async () => {
    const asked: string[] = [];
    const facts = {
      pr: (project: string, pr: number, since: number) => {
        asked.push(`pr ${project} ${pr} ${since}`);
        return pr === 42 ? { event: "review.merged" as const, at: since + 5 } : null;
      },
      decision: async (project: string, id: string) => {
        asked.push(`decision ${project} ${id}`);
        return { event: "decision.answered" as const, at: 9 };
      },
      message: (project: string, agent: string, since: number) => {
        asked.push(`message ${project} ${agent} ${since}`);
        return null;
      },
    };
    expect(await wakeStateOf(facts, "demo", "worker-a", { kind: "pr", pr: 42 }, 100)).toEqual({ event: "review.merged", at: 105, source: "state" });
    expect(await wakeStateOf(facts, "demo", "worker-a", { kind: "pr", pr: 41 }, 100)).toBeNull();
    expect(await wakeStateOf(facts, "demo", "worker-a", { kind: "decision", id: "d-1" }, 100)).toEqual({ event: "decision.answered", at: 9, source: "state" });
    expect(await wakeStateOf(facts, "demo", "worker-a", { kind: "message" }, 100)).toBeNull();
    expect(asked).toEqual(["pr demo 42 100", "pr demo 41 100", "decision demo d-1", "message demo worker-a 100"]);
    expect(await wakeStateOf(undefined, "demo", "worker-a", { kind: "pr", pr: 42 }, 100)).toBeNull();
    expect(await wakeStateOf({}, "demo", "worker-a", { kind: "message" }, 100)).toBeNull();
  });

  it("a Decision Inbox decision wakes once it is the project's and closed with an answer (answered, or expired with its default)", () => {
    const at = "2026-03-02T12:30:00.000Z";
    expect(decisionWake({ project: "demo", status: "answered", answeredAt: at }, "demo")).toEqual({ event: "decision.answered", at: Date.parse(at) });
    expect(decisionWake({ project: "demo", status: "expired", closedAt: at }, "demo")).toEqual({ event: "decision.expired", at: Date.parse(at) });
    expect(decisionWake({ project: "demo", status: "open" }, "demo")).toBeNull();
    expect(decisionWake({ project: "demo", status: "withdrawn", closedAt: at }, "demo")).toBeNull();
    expect(decisionWake({ project: "other", status: "answered", answeredAt: at }, "demo")).toBeNull();
    expect(decisionWake({ project: "demo", status: "answered" }, "demo")).toBeNull();
    expect(decisionWake(null, "demo")).toBeNull();
  });
});
