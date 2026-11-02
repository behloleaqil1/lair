/**
 * The tracker against the events Lair's modules really emit (F5): the
 * agents module and the planner (their own harness: the real modules, a fake
 * process spawner and clock) and the review module (the real ReviewManager
 * and merge, a stand-in git host). The tracker subscribes to the same bus
 * as in src/server/index.ts; only GitHub, as the tracker's client sees it,
 * is a stand-in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import { MIN, cleanup as plannerCleanup, makePaths, plannerBlock, queue, setup, tasks } from "../planner/testing/harness.js";
import { ReviewManager } from "../review/service.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "../review/testing/fakes.js";
import { TrackerManager } from "./manager.js";
import { FakeGitHub } from "./testing/fake-github.js";

const TOKEN = `ghp_${"c".repeat(36)}`;
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const README: FakeFile = {
  filename: "docs/usage.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n # Usage\n-Old text\n+New text",
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await plannerCleanup();
});

function startTracker(project: string, config: ProjectConfig, events: EventBus, gh: FakeGitHub, dbPath: string): TrackerManager {
  const tracker = new TrackerManager({ dbPath, events, fetch: gh.fetch, env: { GITHUB_TOKEN: TOKEN }, log: { warn: () => {} } });
  tracker.load([{ name: project, config }]);
  expect(tracker.status(project).errors).toEqual([]);
  tracker.start();
  cleanups.push(() => tracker.stop());
  return tracker;
}

describe("the events the agents module and the planner emit", () => {
  it("a run starts (In progress, agent set), the planner routes a BLOCKED line (label, one comment), then marks the task done (Done, closed)", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setup(p, plannerBlock(p, { agent: undefined }));
    await h.service.cycle();
    const gh = new FakeGitHub();
    const board = gh.addBoard("example", 1);
    const config = {
      ...h.config,
      tracker: {
        enabled: true,
        mode: "act",
        api_url: gh.api,
        create_issues_for_new_tasks: true,
        repos: [{ repo: "example/demo", default: true, project: { owner: "example", number: 1 }, agent_field: "Agent" }],
      },
    } as ProjectConfig;
    const tracker = startTracker("demo", config, h.events, gh, join(p.dir, "tracker.db"));
    const idle = () => tracker.get("demo")!.idle();
    await idle();
    const [issue] = gh.issues("example/demo");
    expect(issue.title).toBe("feat-login: Login form");
    expect(gh.card(board, "example/demo", issue.number)?.status).toBe("Backlog");

    // The agents module starts a run: agent.run.started as it emits it
    await h.agentsService.requestRun({ agent: "worker-a", task: "feat-login", prompt: "Build the login form" });
    await h.agentsService.tick();
    await idle();
    expect(h.bus.some((e) => e.type === "agent.run.started" && e.data.task === "feat-login")).toBe(true);
    expect(gh.card(board, "example/demo", issue.number)).toMatchObject({ status: "In progress", agent: "worker-a" });

    // The planner routes the agent's BLOCKED line: planner.blocked as it emits it
    queue(p, "- BLOCKED feat-login by worker-a 12:02Z: the payment provider account needs the owner's approval");
    await h.service.cycle();
    await idle();
    expect(h.bus.some((e) => e.type === "planner.blocked" && e.data.task === "feat-login")).toBe(true);
    expect(gh.issue("example/demo", issue.number)?.labels).toEqual(["blocked"]);
    expect(gh.issue("example/demo", issue.number)?.comments).toHaveLength(1);

    // The run exits 0 (agent.run.ended: an exit is not a done task, nothing moves)
    const call = h.spawner.calls.at(-1)!;
    h.clock.t += 2 * MIN;
    appendFileSync(call.logPath, "worked\n");
    const t = new Date(h.clock.now());
    utimesSync(call.logPath, t, t);
    h.spawner.exit(call.pid, 0);
    await h.agentsService.tick();
    await idle();
    expect(h.bus.some((e) => e.type === "agent.run.ended" && e.data.task === "feat-login")).toBe(true);
    expect(gh.card(board, "example/demo", issue.number)?.status).toBe("In progress");

    // The planner marks it done from the queue (a task with an active run never is): planner.changed {op: "mark_done"}
    queue(p, "- DONE feat-login by worker-a 12:05Z: merged #12");
    await h.service.cycle();
    await idle();
    expect(h.bus.some((e) => e.type === "planner.changed" && e.data.op === "mark_done" && e.data.outcome === "applied")).toBe(true);
    expect(gh.card(board, "example/demo", issue.number)?.status).toBe("Done");
    expect(gh.issue("example/demo", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
  });
});

describe("the event the review module emits", () => {
  it("review.merged (a PR number only) closes the issue the merged PR's body closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-tracker-review-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tasksFile = join(dir, "tasks.txt");
    writeFileSync(tasksFile, "# agent|name|task|description\nworker-a|Alice|feat-docs|Usage docs\n");

    // The review module's host: PR #3, green (docs only), its checks passed
    const remote = new FakeRemote("example-org/demo");
    const base = remote.commit([], AGENT, "initial");
    remote.branches.set("main", base);
    remote.setChecks(base, [["build", "success"]]);
    const head = remote.commit([base], AGENT, "docs: usage");
    remote.openPull({ number: 3, title: "Usage docs", headRef: "agent/worker-a/usage", headSha: head, files: [README] });
    remote.setChecks(head, [["build", "success"]]);

    // The same repository as the tracker's client sees it: the issue, and PR #3 closing it
    const gh = new FakeGitHub();
    const board = gh.addBoard("example-org", 1);
    const issue = gh.addIssue("example-org/demo", { title: "feat-docs: Usage docs" });
    gh.addPull("example-org/demo", { number: 3, body: `Writes the usage docs.\n\nCloses #${issue.number}`, headRef: "agent/worker-a/usage" });

    const config = {
      name: "demo",
      repo: dir,
      github: "example-org/demo",
      queue_file: join(dir, "queue.md"),
      agents_dir: join(dir, "agents"),
      gates_dir: join(dir, "gates"),
      machines: {},
      read_only: false,
      agents: { enabled: false, fill: { enabled: false, tasks_file: tasksFile, agents: ["worker-a"] } },
      review: {
        enabled: true,
        authors: { branch_pattern: "agent/{agent}/**" },
        reviewers: { green: [] },
        merge: {
          gate: { source: "checks", required: ["build"] },
          method: "local",
          local_strategy: "ff-only",
          allowed_emails: ["*@users.noreply.github.com"],
          work_dir: join(dir, "work"),
        },
      },
      tracker: {
        enabled: true,
        mode: "act",
        api_url: gh.api,
        repos: [{ repo: "example-org/demo", default: true, project: { owner: "example-org", number: 1 } }],
      },
    } as unknown as ProjectConfig;

    const events = new EventBus();
    const review = new ReviewManager({
      dbPath: ":memory:",
      events,
      clock: new FakeClock(Date.parse("2026-03-02T12:00:00.000Z")),
      git: new FakeGit(remote),
      fetch: fakeGitHubApi(remote),
      env: {},
      cwd: dir,
      autoRequestMs: 0,
    });
    cleanups.push(() => review.close());
    review.load([{ name: "demo", config }]);
    const merged: Record<string, unknown>[] = [];
    events.on("review.merged", (e) => {
      merged.push(e.data);
    });
    const tracker = startTracker("demo", config, events, gh, join(dir, "tracker.db"));
    await tracker.get("demo")!.idle();
    expect(gh.card(board, "example-org/demo", issue.number)?.status).toBe("In review");

    const service = review.get("demo");
    if (!service) throw new Error(`reviews are off: ${review.info("demo").errors.join("; ")}`);
    const result = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(result.merged, JSON.stringify(result)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    await tracker.get("demo")!.idle();
    // Exactly the payload the review module emits: the PR's number and no body
    expect(merged).toEqual([expect.objectContaining({ project: "demo", pr: 3 })]);
    expect(merged[0]).not.toHaveProperty("body");
    expect(gh.issue("example-org/demo", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(gh.card(board, "example-org/demo", issue.number)?.status).toBe("Done");
  });
});
