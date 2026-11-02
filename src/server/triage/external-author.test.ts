/**
 * triage.external_author: tasks_file, through the production path
 * (TriageManager -> TriageService.ingest -> classifier -> real SQLite store
 * -> command adapters). The one fake boundary besides the harness's runner,
 * clock and git is the tasks file source: fill's status as its last check
 * read it (AgentsService.fillStatus), with the line shapes fill emits.
 * Results are signed (an external gate runner over HTTP), so their context
 * names no agent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FillLineView, FillStatusView } from "../../shared/agents-types.js";
import { findExternalAuthor, matchAuthorLines } from "./external-author.js";
import { actingTriage, fixture, gate, harness, NOW, sha, type Harness } from "./testing/harness.js";

let h: Harness | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await h?.cleanup();
  h = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tasks file outside the project's repository, as fill reads it */
function tasksFileOutside(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-tasks-"));
  dirs.push(dir);
  const file = join(dir, "tasks.txt");
  writeFileSync(file, "");
  return file;
}

function line(n: number, agent: string | null, task: string | null, state: FillLineView["state"], description = "work"): FillLineView {
  return {
    line: n,
    agent,
    name: agent ? `Name ${n}` : null,
    task,
    description,
    state,
    detail: "",
    hold: state === "held" ? "waiting" : null,
    releasable: state === "held",
    waiting: null,
    runId: null,
    decisionId: null,
  };
}

function fillView(tasksFile: string | null, lines: FillLineView[], extra: Partial<FillStatusView> = {}): FillStatusView {
  return {
    enabled: true,
    running: true,
    tasksFile,
    agents: ["worker-a", "worker-b"],
    maxActive: 2,
    active: 1,
    intervalSeconds: 60,
    lastCheck: "2026-03-02T11:59:00.000Z",
    lastError: null,
    lines,
    unmatchedReports: [],
    warnings: [],
    ...extra,
  };
}

/** A harness whose fill source returns `view` (a function: read at each ingest) */
function withFill(triage: Record<string, unknown>, view: () => FillStatusView | null): Harness {
  return harness(triage, {}, undefined, () => ({ taskLines: view }));
}

/** A code failure on `branch`, as an external runner's signed result (its context is never read) */
async function externalFailure(target: Harness, branch: string, at = sha("x1"), pipelineId = "backend") {
  return target.service.ingest({
    result: gate({ sha: at, branch, pipelineId }),
    reports: [{ content: fixture("junit-assertion.xml") }],
    trust: "signed",
  });
}

const OPEN_LINES = (): FillLineView[] => [
  line(1, "worker-a", "fix-login", "held"),
  line(2, "worker-b", "add-export", "started"),
];

describe("triage.external_author: tasks_file", () => {
  it("an external gate failure for a task with one open line routes to that line's agent", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES()));
    const out = await externalFailure(h, "kiro/worker-a/fix-login");
    expect(out.record).toMatchObject({ trust: "signed", agent: "worker-a", verdict: "code" });
    const notes = h.runner.callsTo("./bin/notify");
    expect(notes).toHaveLength(1);
    expect(notes[0][1]).toBe("worker-a");
    expect(out.actions.find((a) => a.kind === "note" && a.detail.startsWith("author worker-a"))?.detail).toBe(
      "author worker-a: the one open tasks file line that names this result (line 1, task fix-login, by its agent and task in the branch)",
    );
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({ status: "done", argv: notes[0] });
  });

  it("two open lines that name the result route to the owner, not to either agent", async () => {
    const file = tasksFileOutside();
    const lines = [line(1, "worker-a", "fix-login", "held"), line(2, "worker-b", "fix-login-ui", "started", "see feature/fix-login")];
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, lines));
    const out = await externalFailure(h, "feature/fix-login");
    expect(out.record.agent).toBeUndefined();
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toContain("2 open tasks file lines name branch feature/fix-login");
    expect(out.actions.find((a) => a.kind === "decision")).toMatchObject({ status: "done" });
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("no open line that names the result routes to the owner", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES()));
    const out = await externalFailure(h, "feature/unknown-work");
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toBe(
      "no author from the tasks file: no open tasks file line names branch feature/unknown-work or pipeline backend",
    );
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("observe records the would-route with the matched agent and sends nothing", async () => {
    const file = tasksFileOutside();
    h = withFill({ ...actingTriage({ external_author: "tasks_file" }), mode: "observe" }, () => fillView(file, OPEN_LINES()));
    const out = await externalFailure(h, "worker-a/fix-login");
    expect(out.record.agent).toBe("worker-a");
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({
      status: "planned",
      detail: "2 cause(s) sent to worker-a (not run: triage.mode is observe)",
    });
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    await h.manager.idle();
    expect(h.events.getRecentEvents("triage.routed")[0].data).toMatchObject({ agent: "worker-a", recordId: out.record.id });
  });

  it("observe with no single author records the owner route and raises no decision", async () => {
    const file = tasksFileOutside();
    h = withFill({ ...actingTriage({ external_author: "tasks_file" }), mode: "observe" }, () => fillView(file, OPEN_LINES()));
    const out = await externalFailure(h, "feature/unknown-work");
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({
      status: "planned",
      detail: "2 cause(s) to the owner: no single author (not run: triage.mode is observe)",
    });
    expect(out.actions.find((a) => a.kind === "decision")).toBeUndefined();
    expect(h.inbox()).toBe("");
  });

  it("is off by default: a matching line is not read and the route is skipped as before", async () => {
    const file = tasksFileOutside();
    let reads = 0;
    h = withFill(actingTriage(), () => {
      reads++;
      return fillView(file, OPEN_LINES());
    });
    const out = await externalFailure(h, "kiro/worker-a/fix-login");
    expect(reads).toBe(0);
    expect(out.record.agent).toBeUndefined();
    expect(out.actions.find((a) => a.kind === "route")).toMatchObject({ status: "skipped" });
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(h.inbox()).toBe("");
  });

  it("a tasks file inside the project's repository is not trusted: the owner is asked", async () => {
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => {
      const file = join(h!.dir, "work", "tasks.txt");
      mkdirSync(join(h!.dir, "work"), { recursive: true });
      writeFileSync(file, "");
      return fillView(file, OPEN_LINES());
    });
    const out = await externalFailure(h, "kiro/worker-a/fix-login");
    expect(out.record.agent).toBeUndefined();
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toContain("inside the project's repository");
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("an unreadable fill status, or no fill at all, finds no author and asks the owner", async () => {
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => {
      throw new Error("fill is restarting");
    });
    const thrown = await externalFailure(h, "feature/fix-login");
    expect(thrown.actions.find((a) => a.kind === "note")?.detail).toContain("could not be read (fill is restarting)");
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    await h.cleanup();

    h = harness(actingTriage({ external_author: "tasks_file" }));
    const none = await externalFailure(h, "feature/fix-login", sha("x2"));
    expect(none.actions.find((a) => a.kind === "note")?.detail).toContain("no tasks file source is connected");
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("a trusted result that names its agent keeps it: the tasks file is not read", async () => {
    const file = tasksFileOutside();
    let reads = 0;
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => {
      reads++;
      return fillView(file, OPEN_LINES());
    });
    await h.ingest({
      result: gate({ sha: sha("x3"), branch: "feature/fix-login" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { agent: "worker-b" },
    });
    expect(reads).toBe(0);
    expect(h.runner.callsTo("./bin/notify").map((c) => c[1])).toEqual(["worker-b"]);
  });

  it("a second failure at the same commit asks the owner once", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES()));
    await externalFailure(h, "feature/unknown-work", sha("x4"), "backend");
    const again = await externalFailure(h, "feature/unknown-work", sha("x4"), "frontend");
    expect(again.actions.find((a) => a.kind === "decision")).toMatchObject({ status: "skipped" });
    expect(h.inbox().match(/no author agent is known for it/g)).toHaveLength(1);
  });

  it("one line that names the result only by pipeline routes to the owner, not to its agent", async () => {
    const file = tasksFileOutside();
    // Task id e2e is the pipeline; the failing branch is one no line names
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, [line(1, "worker-b", "e2e", "started", "stabilise the e2e suite")]));
    const out = await externalFailure(h, "claude/billing-fix", sha("p1"), "e2e");
    expect(out.record.agent).toBeUndefined();
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toBe(
      "no author from the tasks file: only line 1 (worker-b, e2e) names branch claude/billing-fix or pipeline e2e, by its pipeline only, which does not show who wrote the branch",
    );
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("one held line that names the result only by its last segment (a takeover's branch) routes to the owner", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, [line(1, "worker-a", "fix-login", "held")]));
    const out = await externalFailure(h, "claude/fix-login", sha("p2"));
    expect(out.record.agent).toBeUndefined();
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toContain("by its branch's last segment only");
    expect(h.inbox()).toContain("no author agent is known for it");
  });

  it("a trusted in-process result without context.agent gets its author from the tasks file", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES()));
    const out = await h.ingest({
      result: gate({ sha: sha("t1"), branch: "kiro/worker-b/add-export" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
    });
    expect(out.record).toMatchObject({ trust: "trusted", agent: "worker-b" });
    expect(h.runner.callsTo("./bin/notify").map((c) => c[1])).toEqual(["worker-b"]);
  });

  it("a symlinked tasks file whose target is inside the repository is not trusted", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "lair-link-")), "tasks.txt");
    dirs.push(join(link, ".."));
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => {
      const target = join(h!.dir, "tasks.txt");
      writeFileSync(target, "");
      try {
        symlinkSync(target, link);
      } catch {
        // already linked by an earlier read
      }
      return fillView(link, OPEN_LINES());
    });
    const out = await externalFailure(h, "kiro/worker-a/fix-login", sha("s1"));
    expect(out.record.agent).toBeUndefined();
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
    expect(out.actions.find((a) => a.kind === "note")?.detail).toContain("inside the project's repository");
  });

  it("a stopped fill or a stale last check finds no author: the owner is asked", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES(), { running: false }));
    const stopped = await externalFailure(h, "kiro/worker-a/fix-login", sha("f1"));
    expect(stopped.record.agent).toBeUndefined();
    expect(stopped.actions.find((a) => a.kind === "note")?.detail).toContain("agents.fill is stopped");
    await h.cleanup();

    // 121 s before NOW with a 60 s interval: older than two intervals
    const stale = new Date(NOW - 121_000).toISOString();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES(), { lastCheck: stale }));
    const old = await externalFailure(h, "kiro/worker-a/fix-login", sha("f2"));
    expect(old.record.agent).toBeUndefined();
    expect(old.actions.find((a) => a.kind === "note")?.detail).toContain("older than two intervals");
    expect(h.runner.callsTo("./bin/notify")).toEqual([]);
  });

  it("the owner's question says no author is known, not that the tasks file was read", async () => {
    const file = tasksFileOutside();
    h = withFill(actingTriage({ external_author: "tasks_file" }), () => fillView(file, OPEN_LINES()));
    await externalFailure(h, "feature/unknown-work", sha("w1"));
    expect(h.inbox()).not.toContain("no single open task line");
    expect(h.inbox()).toContain("no author agent is known for it");
  });
});

describe("matchAuthorLines and findExternalAuthor", () => {
  const subject = { branch: "team/fix-login", pipelineId: "backend" };

  it("counts only started and held lines with an agent and a task", () => {
    const lines = [
      line(1, "worker-a", "fix-login", "done"),
      line(2, "worker-b", "fix-login", "claimed"),
      line(3, null, "fix-login", "unassigned"),
      line(4, "worker-c", "fix-login", "not_allowlisted"),
      line(5, "worker-d", "fix-login", "malformed"),
      line(6, "worker-e", "fix-login", "held"),
    ];
    expect(matchAuthorLines(lines, subject)).toEqual([{ line: 6, agent: "worker-e", task: "fix-login", by: "segment" }]);
  });

  it("names a result by the whole branch, its last segment, the pipeline, or the branch as a word in the description", () => {
    expect(matchAuthorLines([line(1, "worker-a", "team/fix-login", "held")], subject)[0]?.by).toBe("branch");
    expect(matchAuthorLines([line(1, "worker-a", "fix-login", "held")], subject)[0]?.by).toBe("segment");
    expect(matchAuthorLines([line(1, "worker-a", "fix-login", "held")], { branch: "kiro/worker-a/fix-login", pipelineId: "p" })[0]?.by).toBe("agent_branch");
    // Another agent's id in the branch is not the line's agent
    expect(matchAuthorLines([line(1, "worker-a", "fix-login", "held")], { branch: "kiro/worker-b/fix-login", pipelineId: "p" })[0]?.by).toBe("segment");
    expect(matchAuthorLines([line(1, "worker-a", "backend", "held")], subject)[0]?.by).toBe("pipeline");
    expect(matchAuthorLines([line(1, "worker-a", "t1", "held", "on team/fix-login, then review")], subject)[0]?.by).toBe("description");
    // Part of a longer name is not the branch
    expect(matchAuthorLines([line(1, "worker-a", "t1", "held", "on team/fix-login-2")], subject)).toEqual([]);
    expect(matchAuthorLines([line(1, "worker-a", "login", "held")], subject)).toEqual([]);
    // A bare branch name is never read from a description
    expect(matchAuthorLines([line(1, "worker-a", "t1", "held", "fix the bug")], { branch: "fix", pipelineId: "p" })).toEqual([]);
  });

  it("is unavailable when fill is off, not checked yet, failed its last check, or has no tasks file", () => {
    const file = tasksFileOutside();
    const repo = mkdtempSync(join(tmpdir(), "lair-repo-"));
    dirs.push(repo);
    expect(findExternalAuthor(null, repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(file, OPEN_LINES(), { enabled: false }), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(file, OPEN_LINES(), { lastCheck: null }), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(file, OPEN_LINES(), { lastError: "too long" }), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(null, OPEN_LINES()), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(join(repo, "missing.txt"), OPEN_LINES()), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(file, OPEN_LINES(), { running: false }), repo, subject, NOW).kind).toBe("unavailable");
    expect(findExternalAuthor(fillView(file, OPEN_LINES(), { lastCheck: "not a time" }), repo, subject, NOW).kind).toBe("unavailable");
    // A last segment alone names the result but does not pick its author
    expect(findExternalAuthor(fillView(file, OPEN_LINES()), repo, subject, NOW).kind).toBe("none");
    expect(findExternalAuthor(fillView(file, OPEN_LINES()), repo, { branch: "team/worker-a/fix-login", pipelineId: "backend" }, NOW)).toMatchObject({
      kind: "one",
      author: { agent: "worker-a", by: "agent_branch" },
    });
    // A strong match plus a pipeline-only one is ambiguous
    const both = [line(1, "worker-a", "fix-login", "held"), line(2, "worker-b", "backend", "started")];
    expect(findExternalAuthor(fillView(file, both), repo, { branch: "worker-a/fix-login", pipelineId: "backend" }, NOW).kind).toBe("ambiguous");
  });
});
