/**
 * The Work section's rows and an agent's detail (work-view.ts), from the
 * shapes GET /api/dragons, /api/agents/status and /api/agents/runs return.
 */
import { describe, expect, it } from "vitest";
import type { Dragon } from "../shared/types";
import type { AgentRunView, AgentsStatusView, AgentView, FillLineView } from "../shared/agents-types";
import {
  agentDetail,
  fillDecisionHref,
  fillItem,
  fillStateText,
  fillWaitingText,
  unreachableText,
  waitingText,
  workCounts,
  workRows,
} from "./work-view";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

const dragon = (over: Partial<Dragon> = {}): Dragon => ({ id: "kiro-A", name: "Smaug", task: "fix-login", running: false, ...over });

function run(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id: "1a2b3c4d-0000-4000-8000-000000000001",
    project: "demo",
    task: "feat-login",
    agent: "kiro-A",
    chainId: "c",
    attempt: 2,
    profileIndex: 0,
    profile: { adapter: "claude", model: "opus", provider: "anthropic" },
    sessionId: "5e5510n0-0000",
    sessionMode: "resume",
    sameSessionRestarts: 1,
    freshSessions: 0,
    startRetries: 1,
    state: "running",
    detail: "pid 5001 alive",
    pid: 5001,
    requestedAt: "2026-10-27T11:00:00.000Z",
    notBefore: "2026-10-27T11:00:00.000Z",
    spawnedAt: "2026-10-27T11:01:00.000Z",
    ...over,
  };
}

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "kiro-A",
    state: "working",
    detail: "working on feat-login",
    run: run(),
    profiles: [
      { adapter: "claude", model: "opus", provider: "anthropic" },
      { adapter: "codex", model: "gpt", provider: "openai" },
    ],
    claims: [
      { task: "feat-login", runId: run().id, agent: "kiro-A", ownerPid: 5001, ownerStartedAt: "x", ownerAlive: true, claimedAt: "2026-10-27T11:00:00.000Z" },
    ],
    recoveries: [],
    budget: null,
    ...over,
  };
}

const line = (over: Partial<FillLineView>): FillLineView => ({
  line: 1,
  agent: "kiro-A",
  name: null,
  task: "feat-login",
  description: "Add a login form",
  state: "started",
  detail: "run active",
  hold: null,
  releasable: false,
  waiting: null,
  runId: null,
  decisionId: null,
  ...over,
});

function status(agents: AgentView[], lines: FillLineView[] = []): AgentsStatusView {
  return {
    project: "demo",
    enabled: true,
    running: true,
    readOnly: false,
    errors: [],
    intervalSeconds: 30,
    lastTick: null,
    lastError: null,
    agents,
    claims: [],
    locks: [],
    projectBudget: null,
    fill: {
      enabled: true,
      running: true,
      tasksFile: "tasks.md",
      agents: ["kiro-A"],
      maxActive: 2,
      active: 1,
      intervalSeconds: 60,
      lastCheck: null,
      lastError: null,
      lines,
      unmatchedReports: [],
      warnings: [],
    },
  };
}

describe("work rows", () => {
  it("merges the project's dragons and the agents module's agents into one row each", () => {
    const rows = workRows(
      [dragon(), dragon({ id: "aider-1", name: "Aider", task: "docs", running: true, model: "m", modelFromDefault: true })],
      status([agent(), agent({ id: "lair-only", state: "hung", detail: "no output for 30 min", run: undefined, claims: [] })]),
    );
    expect(rows.map((r) => [r.id, r.state, r.managed, r.task, r.model])).toEqual([
      ["kiro-A", "working", true, "feat-login", "opus"],
      ["aider-1", "Running", false, "docs", "m (default)"],
      ["lair-only", "hung", true, null, "opus"],
    ]);
    expect(rows[2]).toMatchObject({ attention: true, badge: "badge-error", name: "lair-only" });
    expect(workCounts(rows)).toEqual({ total: 3, busy: 2, attention: 1 });
  });

  it("without the agents module, shows the dragons as the project's launcher reports them", () => {
    const rows = workRows([dragon({ running: true })], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "Running", managed: false, task: "fix-login" });
  });
});

describe("agent detail", () => {
  it("has its task and description, the current run, claims, recent runs and reports", () => {
    const older = run({ id: "older", task: "old-task", state: "completed", exitCode: 0, endedAt: "2026-10-27T10:00:00.000Z" });
    const other = run({ id: "other", agent: "someone-else" });
    const detail = agentDetail(
      "kiro-A",
      [dragon({ instructions: "Keep PRs small", stats: { doneCount: 4, waitingCount: 0, blockedCount: 1, gatesSubmitted: 2, gatesPassed: 2, gatesFailed: 0, firstTimePassRate: 100, earlyStops: 0 } })],
      status([agent()], [line({}), line({ line: 2, task: "feat-logout", description: null, state: "held", hold: "owner", releasable: true, detail: "its last run failed" })]),
      [run(), older, other],
      [
        { raw: "a", type: "WAITING", agent: "kiro-A", task: "feat-login", message: "gate", timestamp: "10:00" },
        { raw: "b", type: "DONE", agent: "kiro-A", task: "old-task", message: "done", timestamp: "11:00" },
      ],
      NOW,
    )!;
    expect(detail).toMatchObject({
      name: "Smaug",
      task: "feat-login",
      description: "Add a login form",
      instructions: "Keep PRs small",
      adapter: "claude",
      model: "opus",
      profiles: "claude/opus → codex/gpt",
      managed: true,
    });
    expect(detail.run).toMatchObject({
      state: "running",
      startedAt: "2026-10-27T11:01:00.000Z",
      attempt: 2,
      pid: 5001,
      recoveries: "1 restart(s) in the same session, 0 fresh session(s), 1 start retry",
      active: true,
    });
    expect(detail.claims.map((c) => c.task)).toEqual(["feat-login"]);
    expect(detail.recentRuns.map((r) => r.id)).toEqual([run().id, "older"]);
    expect(detail.holds).toEqual([
      expect.objectContaining({ task: "feat-logout", state: "held: owner", releasable: true, detail: "its last run failed" }),
    ]);
    expect(detail.fill).toHaveLength(2);
    // Newest report first
    expect(detail.reports.map((r) => r.type)).toEqual(["DONE", "WAITING"]);
    expect(detail.stats?.doneCount).toBe(4);
  });

  it("says what a run waits for, and since when", () => {
    const waiting = run({
      state: "waiting_lock",
      waitingLock: {
        lock: "gradle",
        path: "/tmp/gradle.lock",
        holderPid: 77,
        holderStartedAt: null,
        holderAlive: true,
        since: "2026-10-27T11:50:00.000Z",
        detail: "held",
      },
    });
    expect(waitingText(waiting, NOW)).toBe("Waiting on lock gradle since 10 min ago (held by pid 77, alive)");
    expect(waitingText(run({ state: "queued", notBefore: "2026-10-27T12:05:00.000Z", detail: "backoff" }), NOW)).toBe(
      "Queued: starts in 5 min (backoff)",
    );
    expect(waitingText(run(), NOW)).toBeNull();
    expect(waitingText(undefined, NOW)).toBeNull();
  });

  it("says what fill's task waits on (a WAITING line's wake), since when, and when fill tries again", () => {
    expect(
      fillWaitingText({ wake: "gate-123", since: "2026-10-27T11:55:00.000Z", fallbackAt: null, refused: null }, NOW),
    ).toBe("Waiting on gate-123 since 5 min ago");
    expect(
      fillWaitingText(
        { wake: "../x", since: "2026-10-27T11:00:00.000Z", fallbackAt: "2026-10-27T12:30:00.000Z", refused: "not a safe file name" },
        NOW,
      ),
    ).toBe("Waiting on ../x since 1 h ago; not used: not a safe file name; fill starts it again in 30 min without it");
    // An agent with no run of its own waits on what fill says
    const waitingLine = line({
      state: "held",
      hold: "waiting",
      releasable: true,
      detail: "its run ended on WAITING",
      waiting: { wake: "gate-9", since: "2026-10-27T11:50:00.000Z", fallbackAt: null, refused: null },
    });
    const detail = agentDetail("kiro-A", [dragon()], status([agent({ run: undefined, claims: [] })], [waitingLine]), [], [], NOW)!;
    expect(detail.waiting).toBe("Waiting on gate-9 since 10 min ago");
    expect(detail.holds[0]).toMatchObject({ state: "held: waiting", releasable: true, waiting: "Waiting on gate-9 since 10 min ago" });
  });

  it("says when the gate a task waits on is still in the gate queue, and which providers Lair waits out", () => {
    const since = "2026-10-27T09:00:00.000Z";
    expect(
      fillWaitingText(
        {
          wake: "gate-123",
          since,
          fallbackAt: null,
          refused: null,
          queued: { gate: "gate-123", requeuedFrom: null, lane: "remote", status: "queued", since: "2026-10-27T08:59:00.000Z" },
        },
        NOW,
      ),
    ).toBe("Waiting on gate-123 since 3 h ago; still queued in remote since 3 h ago");
    expect(
      fillWaitingText(
        {
          wake: "gate-123",
          since,
          fallbackAt: null,
          refused: null,
          queued: { gate: "gate-124", requeuedFrom: "gate-123", lane: "heavy", status: "running", since: "2026-10-27T11:40:00.000Z" },
        },
        NOW,
      ),
    ).toBe("Waiting on gate-123 since 3 h ago; re-queued as gate-124, still running in heavy since 20 min ago");
    const outage = {
      provider: "provider-a",
      since: "2026-10-27T11:30:00.000Z",
      failures: 6,
      nextTryAt: "2026-10-27T12:15:00.000Z",
      line: "Error: A network error occurred.",
      fleet: true,
      agents: ["kiro-A", "kiro-B"],
      waiting: 4,
    };
    expect(unreachableText(outage, NOW)).toBe(
      "Provider provider-a unreachable since 30 min ago (6 transient failures): every agent waits, 4 runs waiting; next try in 15 min",
    );
    expect(unreachableText({ ...outage, fleet: false, agents: ["kiro-C"], failures: 1, waiting: 1 }, NOW)).toBe(
      "Provider provider-a unreachable since 30 min ago (1 transient failure): kiro-C waits, 1 run waiting; next try in 15 min",
    );
  });

  it("is null for an agent nobody knows", () => {
    expect(agentDetail("ghost", [dragon()], status([agent()]), [])).toBeNull();
  });

  it("a hold that needs you links to its decision; a task you paused says so and is still yours to release", () => {
    const id = "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b";
    const asked = fillItem(line({ state: "held", hold: "no_done", releasable: true, decisionId: id }), NOW);
    expect(asked).toMatchObject({ state: "held: no done", decisionHref: `#/decisions/${id}`, releasable: true });
    const paused = fillItem(line({ state: "held", hold: "paused", releasable: true, detail: "you chose to keep it paused" }), NOW);
    expect(paused).toMatchObject({ state: "Paused by you", decisionHref: null, releasable: true, badge: "badge-neutral" });
    expect(fillStateText("started", null)).toBe("started");
    expect(fillStateText("held", "waited_too_long")).toBe("held: waited too long");
    expect(fillDecisionHref({ decisionId: null })).toBeNull();
  });
});
