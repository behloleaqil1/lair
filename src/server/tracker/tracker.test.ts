/**
 * The tracker through the entry points the server wires: TrackerManager
 * (load, start, live reload, stop), the event bus with the payloads Lair's
 * modules emit (copied from planner/service.ts, agents/service.ts and
 * review/service.ts; contract.test.ts drives the real emitters), the
 * owner's routes, the Decision Inbox and the store on disk. Only GitHub is a
 * stand-in, at its HTTP boundary (testing/fake-github.ts): the real client
 * sends every request to it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import type { ProjectConfig } from "../../shared/types.js";
import type { EventType } from "../../shared/server-types.js";
import type { TrackerStatusView } from "../../shared/tracker-types.js";
import { EventBus } from "../core/event-bus.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { serverModules } from "../reload/modules.js";
import { TrackerManager } from "./manager.js";
import { registerTrackerRoutes } from "./routes.js";
import { TrackerStore } from "./store.js";
import { parseTrackerConfig } from "./config.js";
import { GitHubError, GitHubTrackerClient } from "./github-projects.js";
import { FakeGitHub } from "./testing/fake-github.js";
import { distinctiveTaskId, mentionTokens, titleSimilarity } from "./proposals.js";

const PROJECT = "shop";
const TOKEN = `ghp_${"a".repeat(36)}`;
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const SHA = "a".repeat(40);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** The payloads as Lair's modules emit them (the bus adds nothing; `project` comes from each module's emit wrapper) */
const runStarted = (task: string, agent = "worker-a", eventId = "ev-1") => ({
  kind: "started",
  eventId,
  agent,
  task,
  runId: `run-${eventId}`,
  subject: null,
  summary: `started ${agent} on ${task} as pid 4242 (default, new session 1a2b3c4d)`,
});
const plannerChanged = (op: string, task: string, outcome = "applied", source = "deterministic") => ({ op, task, source, outcome });
const plannerBlocked = (task: string, cls = "owner", rule: string | null = "needs_owner", agent = "worker-a") => ({ task, agent, class: cls, rule });
const reviewMerged = (pr: number) => ({ pr, headSha: SHA, resultSha: SHA, method: "local", strategy: "ff-only", tier: "green", by: "owner" });

interface RigOptions {
  tracker?: Record<string, unknown>;
  repos?: Record<string, unknown>[];
  tasks?: string[];
  done?: string[];
  agents?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  gh?: FakeGitHub;
  dir?: string;
  timeoutMs?: number;
  now?: () => number;
  start?: boolean;
}

function writeTasks(path: string, lines: string[], done: string[] = []): void {
  writeFileSync(path, `# agent|name|task|description\n${[...lines, ...done.map((l) => `#done ${l}`)].join("\n")}\n`);
}

const WEB = { repo: "acme/web", default: true, project: { owner: "acme", number: 1 }, agent_field: "Agent" };

function projectConfig(dir: string, tasksFile: string, o: RigOptions): ProjectConfig {
  return {
    name: "Shop",
    repo: dir,
    github: "acme/web",
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    read_only: false,
    agents: o.agents ?? { enabled: false, fill: { enabled: false, tasks_file: tasksFile, agents: ["worker-a", "worker-b"] } },
    tracker: { enabled: true, mode: "act", api_url: "https://api.github.test", repos: o.repos ?? [WEB], ...o.tracker },
  } as unknown as ProjectConfig;
}

async function rig(o: RigOptions = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "lair-tracker-"));
  if (!o.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tasksFile = join(dir, "tasks.txt");
  if (o.tasks || o.done || !existsSync(tasksFile)) writeTasks(tasksFile, o.tasks ?? [], o.done ?? []);
  const gh = o.gh ?? new FakeGitHub();
  const config = projectConfig(dir, tasksFile, o);
  const bus = new EventBus();
  const warnings: string[] = [];
  const manager = new TrackerManager({
    dbPath: join(dir, "tracker.db"),
    events: bus,
    fetch: gh.fetch,
    env: o.env ?? { GITHUB_TOKEN: TOKEN },
    timeoutMs: o.timeoutMs ?? 2_000,
    now: o.now,
    log: { warn: (text: string) => warnings.push(text) },
  });
  const inbox = new DecisionInbox({ store: new DecisionStore(":memory:"), secrets: new MemorySecretStore(), events: bus });
  manager.load([{ name: PROJECT, config }]);
  manager.useDecisions(inbox);
  const app = Fastify();
  const auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  await registerTrackerRoutes(app, manager, () => PROJECT, auth);
  await app.ready();
  const session = auth.createSession(readFileSync(join(dir, "owner.token"), "utf-8").trim());
  if (!session) throw new Error("no owner session");
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: session.session };
  cleanups.push(async () => {
    await manager.stop();
    await app.close();
    auth.close();
  });
  const idle = async () => {
    await manager.get(PROJECT)?.idle();
  };
  if (o.start !== false) {
    manager.start();
    await idle();
  }
  return {
    dir,
    tasksFile,
    gh,
    bus,
    manager,
    inbox,
    app,
    owner,
    sessionId: session.info.id,
    config,
    warnings,
    idle,
    /** Emit as the module would (its wrapper adds the project), then let the tracker's queue drain */
    async emit(type: EventType, data: Record<string, unknown>) {
      await bus.emit(type, { project: PROJECT, ...data });
      await idle();
    },
    async reconcile() {
      const res = await app.inject({ method: "POST", url: `/api/tracker/reconcile?project=${PROJECT}`, headers: owner });
      expect(res.statusCode, res.body).toBe(202);
      await idle();
    },
    async status(): Promise<TrackerStatusView> {
      const res = await app.inject({ url: `/api/tracker/status?project=${PROJECT}`, headers: owner });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().data as TrackerStatusView;
    },
    writeTasks: (lines: string[], done: string[] = []) => writeTasks(tasksFile, lines, done),
  };
}

const issueWrites = (gh: FakeGitHub, number: number, method: string) =>
  gh.writes().filter((r) => r.method === method && r.path.endsWith(`/issues/${number}`));

describe("acceptance: the board follows the work", () => {
  it("a run starting on a linked task moves its card to In progress and sets the agent, once", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login: Login form" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    // The first reconcile adopted the open issue with the task's exact title and put it on the board
    expect(gh.issues("acme/web")).toHaveLength(1);
    expect(gh.card(board, "acme/web", issue.number)).toMatchObject({ status: "Backlog", agent: null });

    const before = gh.writes().length;
    await h.emit("agent.run.started", runStarted("feat-login"));
    expect(gh.card(board, "acme/web", issue.number)).toMatchObject({ status: "In progress", agent: "worker-a" });
    expect(gh.writes().slice(before).map((r) => r.graphql)).toEqual(["updateProjectV2ItemFieldValue", "updateProjectV2ItemFieldValue"]);

    // The same run seen again changes nothing
    await h.emit("agent.run.started", runStarted("feat-login", "worker-a", "ev-2"));
    expect(gh.writes()).toHaveLength(before + 2);
  });

  it("a PR closing the issue moves its card to In review while open; merged, to Done with the issue closed, once", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login: Login form" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    gh.addPull("acme/web", { number: 7, body: `Adds the login form.\n\nCloses #${issue.number}`, headRef: "agent/worker-a/login" });
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("In review");

    const pull = gh.repo("acme/web").pulls.get(7)!;
    pull.state = "closed";
    pull.merged = true;
    await h.emit("review.merged", reviewMerged(7));
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("Done");
    expect(gh.issue("acme/web", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(issueWrites(gh, issue.number, "PATCH")).toHaveLength(1);

    await h.emit("review.merged", reviewMerged(7));
    await h.reconcile();
    expect(issueWrites(gh, issue.number, "PATCH")).toHaveLength(1);
  });

  it("a PR whose branch ends with the task id counts for that task, and a review of it moves the card to In review", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    gh.addPull("acme/web", { number: 9, body: "No keywords here", headRef: "agent/worker-a/feat-login" });
    await h.emit("review.submitted", { pr: 9, headSha: SHA, reviewer: "worker-b", verdict: "approve", blockingFindings: 0, stale: false });
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("In review");
  });

  it("act: links an open issue with the task's exact title, else creates one with its labels, milestone and marker, on the board", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const existing = gh.addIssue("acme/web", { title: "feat-login: Login form" });
    gh.addIssue("acme/web", { title: "feat-search: Search page", state: "closed" });
    const m1 = gh.addMilestone("acme/web", { title: "M1: Launch", dueOn: "2026-12-01T00:00:00Z" });
    const h = await rig({
      gh,
      tracker: { create_issues_for_new_tasks: true },
      repos: [{ ...WEB, labels: ["lair"], milestones: { rules: [{ tasks: ["feat-*"], milestone: "M1: Launch" }] } }],
      tasks: ["worker-a|Alice|feat-login|Login form", "worker-b|Bob|feat-search|Search page"],
    });
    const issues = gh.issues("acme/web");
    // The open issue was adopted; a closed one with the same title never is
    expect(issues).toHaveLength(3);
    const created = issues[2];
    expect(created).toMatchObject({ title: "feat-search: Search page", labels: ["lair"], milestone: m1.number, viaApi: true });
    expect(created.body).toContain("Search page");
    expect(created.body).toMatch(/<!-- lair-task:[0-9a-f]{24} -->/);
    expect(gh.writes().filter((r) => r.method === "POST" && r.path === "/repos/acme/web/issues")).toHaveLength(1);
    const status = await h.status();
    expect(status.links.map((l) => [l.task, l.issueNumber]).sort()).toEqual([
      ["feat-login", existing.number],
      ["feat-search", created.number],
    ]);
    expect(gh.card(board, "acme/web", existing.number)?.status).toBe("Backlog");
    expect(gh.card(board, "acme/web", created.number)?.status).toBe("Backlog");
    // The milestone's due date is the owner's: never sent
    expect(gh.milestone("acme/web", m1.number)?.dueOn).toBe("2026-12-01T00:00:00Z");
  });

  it("a task fill can start goes to Ready, another to Backlog", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const dir = mkdtempSync(join(tmpdir(), "lair-tracker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tasksFile = join(dir, "tasks.txt");
    await rig({
      gh,
      dir,
      tracker: { create_issues_for_new_tasks: true },
      agents: { enabled: true, fill: { enabled: true, tasks_file: tasksFile, agents: ["worker-a"], prompt_files: ["{prompts_dir}/worker.txt"] } },
      tasks: ["worker-a|Alice|feat-login|Login form", "worker-c|Cid|feat-docs|Docs"],
    });
    const [login, docs] = gh.issues("acme/web");
    expect(gh.card(board, "acme/web", login.number)?.status).toBe("Ready");
    expect(gh.card(board, "acme/web", docs.number)?.status).toBe("Backlog");
  });

  it("reconcile puts back a card moved by hand and counts it; a fix that fails is not counted", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    gh.card(board, "acme/web", issue.number)!.status = "Done";
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("Backlog");
    expect((await h.status()).syncState?.driftFixedCount).toBe(1);

    gh.card(board, "acme/web", issue.number)!.status = "In review";
    gh.intercept = (req) => (req.graphql === "updateProjectV2ItemFieldValue" ? { status: 502, body: { message: "Bad gateway" } } : undefined);
    await h.reconcile();
    const status = await h.status();
    expect(status.syncState?.driftFixedCount).toBe(1);
    expect(status.recentWrites[0]).toMatchObject({ op: "set_status", result: "error" });
    expect(status.syncState?.lastError).toMatch(/502/);

    gh.intercept = null;
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("Backlog");
    expect((await h.status()).syncState?.driftFixedCount).toBe(2);
  });

  it("a card taken off the board is added back, in its column", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    await h.emit("agent.run.started", runStarted("feat-login"));
    board.items.length = 0;
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)).toMatchObject({ status: "In progress", agent: "worker-a" });
  });

  it("milestones: one with closed issues and no open one closes, one with an open issue reopens; only their state is sent", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const done = gh.addMilestone("acme/web", { title: "M1", dueOn: "2026-11-30T00:00:00Z", description: "First" });
    const reopened = gh.addMilestone("acme/web", { title: "M2", state: "closed", dueOn: "2026-12-31T00:00:00Z" });
    const empty = gh.addMilestone("acme/web", { title: "M3" });
    const shipped = gh.addIssue("acme/web", { title: "shipped", state: "closed", milestone: done.number });
    gh.addIssue("acme/web", { title: "reopened", state: "open", milestone: reopened.number });
    const h = await rig({ gh });
    expect(gh.milestone("acme/web", done.number)?.state).toBe("closed");
    expect(gh.milestone("acme/web", reopened.number)?.state).toBe("open");
    // No issues at all: left open
    expect(gh.milestone("acme/web", empty.number)?.state).toBe("open");
    const patches = gh.writes().filter((r) => r.path.includes("/milestones/"));
    expect(patches.map((r) => r.body)).toEqual([{ state: "closed" }, { state: "open" }]);
    expect(gh.milestone("acme/web", done.number)).toMatchObject({ dueOn: "2026-11-30T00:00:00Z", description: "First" });

    // An issue of a closed milestone reopens: so does the milestone
    gh.issue("acme/web", shipped.number)!.state = "open";
    await h.reconcile();
    expect(gh.milestone("acme/web", done.number)?.state).toBe("open");
  });
});

describe("events never wait on GitHub (F1)", () => {
  it("a hung GitHub never holds up the module that emits: the event returns at once, the request is cut off at the timeout", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"], timeoutMs: 400 });
    gh.intercept = (req) => (req.write ? "hang" : undefined);

    const started = Date.now();
    await h.bus.emit("agent.run.started", { project: PROJECT, ...runStarted("feat-login") });
    expect(Date.now() - started).toBeLessThan(150);

    await h.idle();
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    const status = await h.status();
    expect(status.recentWrites[0]).toMatchObject({ op: "set_status", result: "error" });
    expect(status.recentWrites[0].error).toMatch(/no answer in 1 s/);
    // Every request the client sent carried an abort signal
    expect(gh.requests.length).toBeGreaterThan(5);
    expect(gh.requests.every((r) => r.hadSignal)).toBe(true);
  });

  it("stop cuts a request in flight short, and the start never waits on GitHub", async () => {
    const gh = new FakeGitHub();
    gh.intercept = () => "hang";
    const h = await rig({ gh, timeoutMs: 60_000, start: false });
    const t0 = Date.now();
    expect(h.manager.start()).toEqual([PROJECT]);
    expect(Date.now() - t0).toBeLessThan(100);
    expect((await h.status()).running).toBe(true);
    await h.manager.stop();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("observe mode sends nothing (F2)", () => {
  it("on every path (adopt, explicit link, create, run, blocked, done, milestones, drift) it records the would-be writes once", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login: Login form" });
    const named = gh.addIssue("acme/web", { title: "Some other title" });
    const m = gh.addMilestone("acme/web", { title: "M1" });
    gh.addIssue("acme/web", { title: "old", state: "closed", milestone: m.number });
    const h = await rig({
      gh,
      tracker: { mode: "observe", create_issues_for_new_tasks: true },
      tasks: [
        "worker-a|Alice|feat-login|Login form",
        `worker-a|Alice|feat-named|Issue: #${named.number}`,
        "worker-b|Bob|feat-search|Search page",
      ],
    });
    await h.emit("agent.run.started", runStarted("feat-login"));
    await h.emit("planner.blocked", plannerBlocked("feat-named"));
    await h.emit("planner.changed", plannerChanged("mark_done", "feat-named"));
    await h.reconcile();
    await h.reconcile();

    expect(gh.writes()).toEqual([]);
    expect(board.items).toEqual([]);
    const status = await h.status();
    // Adopted and named issues are linked in Lair's own store only
    expect(status.links.map((l) => l.task).sort()).toEqual(["feat-login", "feat-named"]);
    // (The owner's two reconcile requests are audited too: they are not GitHub writes)
    expect(status.recentWrites.filter((w) => w.op === "sync_requested")).toHaveLength(2);
    const rows = status.recentWrites.filter((w) => w.op !== "sync_requested");
    expect(rows.every((w) => w.mode === "observe" && w.result === "would_send")).toBe(true);
    const ops = new Set(rows.map((w) => w.op));
    for (const op of ["add_to_board", "create_issue", "close_milestone", "close_issue", "add_label"]) expect(ops, op).toContain(op);
    // Each would-be write is one row, counted again on each cycle, never a new row
    const keys = rows.map((w) => `${w.op}|${w.task}|${w.wouldSend}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.find((w) => w.op === "create_issue")?.count).toBe(3);
  });

  it("a read-only client refuses a write before anything is sent", async () => {
    const gh = new FakeGitHub();
    const client = new GitHubTrackerClient({ apiUrl: gh.api, token: async () => TOKEN, fetch: gh.fetch, timeoutMs: 1000, readOnly: true });
    await expect(client.createIssue("acme/web", { title: "x", body: "", labels: [], milestone: null })).rejects.toMatchObject({ code: "read_only" });
    await expect(client.addToBoard("PVT_1", "I_1")).rejects.toMatchObject({ code: "read_only" });
    expect(gh.requests).toEqual([]);
  });
});

describe("an issue is created at most once per task (F3)", () => {
  it("a create whose answer is lost is found again by its marker after a restart, with search lagging behind", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    gh.searchLag = true;
    gh.intercept = (req) => (req.method === "POST" && req.path === "/repos/acme/web/issues" ? "lose-answer" : undefined);
    const options = { gh, tracker: { create_issues_for_new_tasks: true }, tasks: ["worker-a|Alice|feat-login|Login form"] };
    const h = await rig(options);
    // The issue was made; its answer never came
    expect(gh.issues("acme/web")).toHaveLength(1);
    let status = await h.status();
    expect(status.links).toEqual([]);
    expect(status.pending.map((p) => p.task)).toEqual(["feat-login"]);

    // Lair restarts: a new tracker on the same store
    gh.intercept = null;
    await h.manager.stop();
    const again = await rig({ ...options, dir: h.dir });
    expect(gh.issues("acme/web")).toHaveLength(1);
    status = await again.status();
    expect(status.links).toMatchObject([{ task: "feat-login", issueNumber: 1 }]);
    expect(status.pending).toEqual([]);
    expect(gh.card(board, "acme/web", 1)?.status).toBe("Backlog");
  });

  it("a board failure after the create keeps the link: a second event makes no second issue, the reconcile adds the card", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    gh.searchLag = true;
    gh.intercept = (req) => (req.graphql === "addProjectV2ItemById" ? { status: 502, body: { message: "Bad gateway" } } : undefined);
    const h = await rig({ gh, tracker: { create_issues_for_new_tasks: true }, tasks: ["worker-a|Alice|feat-login|Login form"] });
    expect(gh.issues("acme/web")).toHaveLength(1);
    expect(board.items).toEqual([]);
    await h.emit("planner.changed", plannerChanged("add", "feat-login"));
    await h.emit("agent.run.started", runStarted("feat-login"));
    expect(gh.issues("acme/web")).toHaveLength(1);

    gh.intercept = null;
    await h.reconcile();
    expect(gh.issues("acme/web")).toHaveLength(1);
    expect(gh.card(board, "acme/web", 1)).toMatchObject({ status: "In progress", agent: "worker-a" });
  });

  it("two add events for one task, back to back, make one issue", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.searchLag = true;
    const h = await rig({ gh, tracker: { create_issues_for_new_tasks: true } });
    h.writeTasks(["worker-a|Alice|feat-login|Login form"]);
    await h.bus.emit("planner.changed", { project: PROJECT, ...plannerChanged("add", "feat-login") });
    await h.bus.emit("planner.changed", { project: PROJECT, ...plannerChanged("add", "feat-login", "applied", "proposal") });
    await h.idle();
    expect(gh.issues("acme/web")).toHaveLength(1);
  });

  it("creates count against the write budget: the rest wait for the next minute", async () => {
    const gh = new FakeGitHub();
    let t = Date.parse("2026-10-31T12:00:00.000Z");
    const h = await rig({
      gh,
      now: () => t,
      repos: [{ repo: "acme/web", default: true }],
      tracker: { create_issues_for_new_tasks: true, write_budget_per_minute: 1 },
      tasks: ["worker-a|Alice|feat-a|A", "worker-a|Alice|feat-b|B"],
    });
    expect(gh.issues("acme/web").map((i) => i.title)).toEqual(["feat-a: A"]);
    const refused = (await h.status()).recentWrites.find((w) => w.op === "create_issue" && w.result === "rate_limited");
    expect(refused).toMatchObject({ task: "feat-b", error: expect.stringContaining("write budget") });
    t += 61_000;
    await h.reconcile();
    expect(gh.issues("acme/web").map((i) => i.title)).toEqual(["feat-a: A", "feat-b: B"]);
  });
});

describe("text sent to GitHub is redacted by default (F4)", () => {
  it("titles, bodies and comments lose paths, tokens, secret values, emails, addresses and the owner's patterns", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const secret = "s3cr3t-deploy-value";
    const ghToken = `ghp_${"b".repeat(36)}`;
    const h = await rig({
      gh,
      env: { GITHUB_TOKEN: TOKEN, DEPLOY_SECRET: secret },
      tracker: { create_issues_for_new_tasks: true, redact_patterns: ["project-bluebird"] },
      tasks: [`worker-a|Alice|feat-login|Fix /Users/user/src/app.ts for project-bluebird; key ${ghToken} ${secret}, mail dev@example.com at 10.0.0.12`],
    });
    const [issue] = gh.issues("acme/web");
    expect(issue).toBeDefined();
    await h.emit("planner.blocked", plannerBlocked("feat-login", "environment", "needs /home/user/.ssh/id_rsa and sk-ant-abcdefghijklmnopqrstuvwx"));
    expect(issue.comments).toHaveLength(1);
    const sent = [issue.title, issue.body, ...issue.comments].join("\n");
    for (const leak of ["/Users/user", "/home/user", ghToken, secret, "dev@example.com", "10.0.0.12", "project-bluebird", "sk-ant-"]) {
      expect(sent, leak).not.toContain(leak);
    }
    expect(issue.title).toBe("feat-login: Fix [path] for [redacted]; key [redacted token] [redacted], mail [email] at [address]");
    expect(issue.comments[0]).toContain("[path]");
    // Nothing the tracker sends carries the token in a body either
    expect(gh.requests.some((r) => JSON.stringify(r.body ?? "").includes(TOKEN))).toBe(false);
  });
});

describe("the events Lair emits drive it (F5)", () => {
  it("planner.changed: add links, mark_done closes as completed, drop closes as not planned, a planned (observe) change is ignored", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const h = await rig({ gh, tracker: { create_issues_for_new_tasks: true } });
    h.writeTasks(["worker-a|Alice|feat-a|A", "worker-a|Alice|feat-b|B", "worker-a|Alice|feat-c|C"]);
    // The planner's observe mode emits outcome "planned": the tasks file did not change
    await h.emit("planner.changed", plannerChanged("add", "feat-a", "planned"));
    expect(gh.issues("acme/web")).toEqual([]);
    for (const task of ["feat-a", "feat-b", "feat-c"]) await h.emit("planner.changed", plannerChanged("add", task));
    const [a, b, c] = gh.issues("acme/web");
    expect([a, b, c].map((i) => i.title)).toEqual(["feat-a: A", "feat-b: B", "feat-c: C"]);

    await h.emit("planner.changed", plannerChanged("mark_done", "feat-a"));
    await h.emit("planner.changed", plannerChanged("drop", "feat-b"));
    await h.emit("planner.changed", plannerChanged("mark_done", "feat-c", "planned"));
    expect(gh.issue("acme/web", a.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(gh.card(board, "acme/web", a.number)?.status).toBe("Done");
    expect(gh.issue("acme/web", b.number)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(gh.issue("acme/web", c.number)?.state).toBe("open");
  });

  it("a task marked done in the tasks file while no event came is closed by the reconcile", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    h.writeTasks([], ["worker-a|Alice|feat-login|Login form"]);
    await h.reconcile();
    expect(gh.issue("acme/web", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
  });

  it("another project's events and other event kinds are ignored", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    const before = gh.requests.length;
    await h.bus.emit("agent.run.started", { ...runStarted("feat-login"), project: "other" });
    await h.bus.emit("agent.run.started", { project: PROJECT, ...runStarted("feat-login"), kind: "requested" });
    await h.bus.emit("review.merged", { project: "other", ...reviewMerged(3) });
    await h.idle();
    expect(gh.requests).toHaveLength(before);
  });
});

describe("blocked tasks (F8)", () => {
  it("one label and one comment per reason, also after a restart; the label goes on unblock or on the next run", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const options = { gh, tasks: ["worker-a|Alice|feat-login|Login form"] };
    const h = await rig(options);
    await h.emit("planner.blocked", plannerBlocked("feat-login"));
    await h.emit("planner.blocked", plannerBlocked("feat-login"));
    expect(issue.labels).toEqual(["blocked"]);
    expect(issue.comments).toHaveLength(1);

    await h.manager.stop();
    const again = await rig({ ...options, dir: h.dir });
    await again.emit("planner.blocked", plannerBlocked("feat-login"));
    expect(issue.comments).toHaveLength(1);

    await again.emit("planner.changed", plannerChanged("unblock", "feat-login", "applied", "decision"));
    expect(issue.labels).toEqual([]);

    await again.emit("planner.blocked", plannerBlocked("feat-login", "environment", "docker_down"));
    expect(issue.labels).toEqual(["blocked"]);
    expect(issue.comments).toHaveLength(2);
    await again.emit("agent.run.started", runStarted("feat-login"));
    expect(issue.labels).toEqual([]);
  });
});

describe("only issues a task names on purpose are adopted (F9)", () => {
  it("a bare #N, another repository's issue, a closed issue or a pull request is never linked", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const other = gh.addIssue("acme/web", { title: "Unrelated" });
    const closed = gh.addIssue("acme/web", { title: "Closed one", state: "closed" });
    const pull = gh.addPull("acme/web", { body: "", headRef: "x" });
    gh.addIssue("acme/lib", { title: "Elsewhere" });
    const h = await rig({
      gh,
      tasks: [
        `worker-a|Alice|feat-a|See #${other.number} for the background`,
        "worker-a|Alice|feat-b|Follow https://github.com/acme/lib/issues/1",
        `worker-a|Alice|feat-c|Issue: #${closed.number}`,
        `worker-a|Alice|feat-d|Issue: #${pull.number}`,
        `worker-a|Alice|feat-e|Issue: #${other.number}`,
      ],
    });
    const status = await h.status();
    expect(status.links.map((l) => [l.task, l.issueNumber])).toEqual([["feat-e", other.number]]);
    expect(h.warnings.some((w) => w.includes(`#${closed.number}, which is closed`))).toBe(true);
    expect(h.warnings.some((w) => w.includes(`#${pull.number}, which is a pull request`))).toBe(true);
  });

  it("a merged PR closing another repository's issue number closes nothing here", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    gh.addPull("acme/web", { number: 5, state: "closed", merged: true, body: `Fixes acme/lib#${issue.number}`, headRef: "fix/lib" });
    await h.emit("review.merged", reviewMerged(5));
    expect(gh.issue("acme/web", issue.number)?.state).toBe("open");
  });
});

describe("several repositories, each with its own board (multi-repo)", () => {
  it("a task goes to the repository its line names, else its match rule, else the default; cards land on their own board", async () => {
    const gh = new FakeGitHub();
    const webBoard = gh.addBoard("acme", 1);
    const apiBoard = gh.addBoard("acme", 2);
    const h = await rig({
      gh,
      tracker: { create_issues_for_new_tasks: true },
      repos: [
        WEB,
        { repo: "acme/api", project: { owner: "acme", number: 2 }, agent_field: "Agent", match: { tasks: ["api-*"], agents: ["worker-b"] } },
      ],
      tasks: [
        "worker-a|Alice|web-home|Home page",
        "worker-a|Alice|api-auth|Token endpoint",
        "worker-b|Bob|feat-search|Search service",
        "worker-a|Alice|feat-x|Move the schema repo:acme/api",
      ],
    });
    expect(gh.issues("acme/web").map((i) => i.title)).toEqual(["web-home: Home page"]);
    expect(gh.issues("acme/api").map((i) => i.title)).toEqual(["api-auth: Token endpoint", "feat-search: Search service", "feat-x: Move the schema"]);
    expect(webBoard.items).toHaveLength(1);
    expect(apiBoard.items).toHaveLength(3);

    await h.emit("agent.run.started", runStarted("api-auth", "worker-b"));
    expect(gh.card(apiBoard, "acme/api", 1)).toMatchObject({ status: "In progress", agent: "worker-b" });
    expect(webBoard.items.map((i) => i.status)).toEqual(["Backlog"]);

    // A PR in the second repository moves its own card
    gh.addPull("acme/api", { number: 9, body: "Closes #2", headRef: "agent/worker-b/search" });
    await h.reconcile();
    expect(gh.card(apiBoard, "acme/api", 2)?.status).toBe("In review");
    const status = await h.status();
    expect(status.repos.map((r) => [r.repo, r.board?.loaded])).toEqual([
      ["acme/web", true],
      ["acme/api", true],
    ]);
  });

  it("an unassigned line (no agent) is linked by its task id: no agent rule takes it, no Agent field, Backlog until a run starts", async () => {
    const gh = new FakeGitHub();
    const webBoard = gh.addBoard("acme", 1);
    const apiBoard = gh.addBoard("acme", 2);
    const adopted = gh.addIssue("acme/web", { title: "feat-free" });
    const dir = mkdtempSync(join(tmpdir(), "lair-tracker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const h = await rig({
      gh,
      dir,
      tracker: { create_issues_for_new_tasks: true },
      agents: { enabled: true, fill: { enabled: true, tasks_file: join(dir, "tasks.txt"), agents: ["worker-b"], prompt_files: ["{prompts_dir}/worker.txt"] } },
      repos: [WEB, { repo: "acme/api", project: { owner: "acme", number: 2 }, agent_field: "Agent", match: { agents: ["worker-b"] } }],
      // Unassigned lines, as fill and the planner read them: an empty agent field
      tasks: ["|Anyone|feat-free|Pick me up", "|Anyone|feat-open|Open work"],
    });
    expect((await h.status()).errors).toEqual([]);
    expect(gh.issues("acme/web").map((i) => i.title)).toEqual(["feat-free", "feat-open: Open work"]);
    expect(apiBoard.items).toEqual([]);
    expect(gh.card(webBoard, "acme/web", adopted.number)).toMatchObject({ status: "Backlog", agent: null });
    await h.emit("agent.run.started", runStarted("feat-free", "worker-b"));
    expect(gh.card(webBoard, "acme/web", adopted.number)).toMatchObject({ status: "In progress", agent: "worker-b" });
  });

  it("with several repositories and no default, a task no rule takes is not tracked", async () => {
    const gh = new FakeGitHub();
    const h = await rig({
      gh,
      tracker: { create_issues_for_new_tasks: true },
      repos: [
        { repo: "acme/web", match: { tasks: ["web-*"] } },
        { repo: "acme/api", match: { tasks: ["api-*"] } },
      ],
      tasks: ["worker-a|Alice|docs-intro|Intro"],
    });
    expect(gh.writes()).toEqual([]);
    expect(h.warnings.some((w) => w.includes("no tracked repository takes it"))).toBe(true);
  });
});

describe("the token (F10, F11)", () => {
  it("a missing project scope raises one owner decision listing it and stops the writes; 'check again' resumes them", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    gh.scopes = "repo";
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    const status = await h.status();
    expect(status.scopes).toEqual({ checked: true, granted: ["repo"], missing: ["project"] });
    expect(status.syncState?.needsOwner).toMatch(/lacks the scope project/);
    expect(gh.writes()).toEqual([]);
    expect(status.recentWrites.find((w) => w.op === "add_to_board")).toMatchObject({ result: "skipped" });

    await h.reconcile();
    const open = h.inbox.openOf(PROJECT, "tracker");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ class: "tracker.token_scopes", source: { module: "tracker", ref: "token-scopes" } });
    expect(open[0].title).toContain("project");
    expect(open[0].context).not.toContain(TOKEN);

    gh.scopes = "repo, project";
    await h.inbox.answer(open[0].id, { optionId: "recheck" });
    await h.idle();
    expect((await h.status()).syncState?.needsOwner).toBeNull();
    await h.reconcile();
    expect(board.items).toHaveLength(1);
    expect(h.inbox.openOf(PROJECT, "tracker")).toEqual([]);
  });

  it("a fine-grained token (no scope header) is not refused; a 403 on a write stops the writes until the owner acts", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    gh.scopes = null;
    gh.intercept = (req) =>
      req.graphql === "addProjectV2ItemById" ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : undefined;
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    const status = await h.status();
    expect(status.scopes.missing).toEqual([]);
    expect(status.syncState?.needsOwner).toMatch(/forbidden/);
    const sent = gh.writes().length;
    await h.emit("agent.run.started", runStarted("feat-login"));
    expect(gh.writes()).toHaveLength(sent);
  });

  it("is read from review's token settings when the tracker names none; the config refuses http and two defaults", () => {
    const base = { name: "x", repo: "/r", github: "acme/web" } as unknown as ProjectConfig;
    const fromReview = parseTrackerConfig({ enabled: true }, { ...base, review: { token_env: "REVIEW_TOKEN", token_cmd: ["gh", "auth", "token"] } } as ProjectConfig);
    expect(fromReview.ok && fromReview.settings.token).toEqual({ env: "REVIEW_TOKEN", cmd: ["gh", "auth", "token"], from: "review" });
    const http = parseTrackerConfig({ enabled: true, api_url: "http://api.example.com" }, base);
    expect(http.ok ? [] : http.errors).toEqual([expect.stringContaining("https://")]);
    const two = parseTrackerConfig({ enabled: true, repos: [{ repo: "a/b", default: true }, { repo: "a/c", default: true }] }, base);
    expect(two.ok ? [] : two.errors).toEqual([expect.stringContaining("only one repository may be the default")]);
  });
});

describe("the GitHub client's answers (F7)", () => {
  const client = (gh: FakeGitHub, now = () => 1_000_000) =>
    new GitHubTrackerClient({ apiUrl: gh.api, token: async () => TOKEN, fetch: gh.fetch, timeoutMs: 1_000, readOnly: false, now });

  it("sends the token, the API version and an abort signal on every request", async () => {
    const gh = new FakeGitHub();
    await client(gh).getIssue("acme/web", 1);
    expect(gh.requests[0]).toMatchObject({ method: "GET", path: "/repos/acme/web/issues/1", auth: `Bearer ${TOKEN}`, hadSignal: true });
  });

  it("a 403 with Retry-After is a rate limit: no request until it ends", async () => {
    const gh = new FakeGitHub();
    gh.intercept = () => ({ status: 403, body: { message: "You have exceeded a secondary rate limit" }, headers: { "Retry-After": "30" } });
    const c = client(gh);
    const error = await c.getIssue("acme/web", 1).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ code: "rate_limit", retryAt: 1_000_000 + 30_000 });
    gh.intercept = null;
    await expect(c.getIssue("acme/web", 1)).rejects.toMatchObject({ code: "rate_limit" });
    expect(gh.requests).toHaveLength(1);
  });

  it("X-RateLimit-Remaining 0 with its reset time is a rate limit; a 429 too", async () => {
    const gh = new FakeGitHub();
    gh.intercept = () => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2000" } });
    await expect(client(gh).getIssue("acme/web", 1)).rejects.toMatchObject({ code: "rate_limit", retryAt: 2_000_000 });
    gh.intercept = () => ({ status: 429, body: { message: "slow down" } });
    await expect(client(gh).getIssue("acme/web", 1)).rejects.toMatchObject({ code: "rate_limit", retryAt: 1_000_000 + 60_000 });
  });

  it("a 403 without a rate-limit sign is forbidden (with the scopes it needs), never retried as a rate limit; 401 is auth", async () => {
    const gh = new FakeGitHub();
    gh.intercept = () => ({ status: 403, body: { message: "Resource not accessible" }, headers: { "X-Accepted-OAuth-Scopes": "project" } });
    const c = client(gh);
    const error = await c.getIssue("acme/web", 1).catch((e) => e);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(error.message).toContain("it needs the scopes: project");
    expect(c.rateLimitedUntil).toBe(0);
    gh.intercept = () => ({ status: 401, body: { message: "Bad credentials" } });
    await expect(c.getIssue("acme/web", 1)).rejects.toMatchObject({ code: "auth" });
  });

  it("GraphQL errors in a 200: RATE_LIMITED waits, INSUFFICIENT_SCOPES is forbidden, a missing board is not found", async () => {
    const limited = new FakeGitHub();
    limited.intercept = () => ({
      status: 200,
      body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      headers: { "X-RateLimit-Reset": "1500" },
    });
    await expect(client(limited).getBoard("acme", 1, "Status", null)).rejects.toMatchObject({ code: "rate_limit", retryAt: 1_500_000 });
    const scoped = new FakeGitHub();
    scoped.intercept = () => ({ status: 200, body: { data: null, errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] } });
    await expect(client(scoped).getBoard("acme", 1, "Status", null)).rejects.toMatchObject({ code: "forbidden" });
    await expect(client(new FakeGitHub()).getBoard("acme", 9, "Status", null)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a rate limit hit by a write is kept across a restart: the new tracker sends nothing before it ends", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    const t = Date.parse("2026-10-31T12:00:00.000Z");
    const resetAt = Math.floor(t / 1000) + 600;
    gh.intercept = (req) =>
      req.graphql === "addProjectV2ItemById"
        ? { status: 403, body: { message: "API rate limit exceeded" }, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt) } }
        : undefined;
    const options = { gh, now: () => t, tasks: ["worker-a|Alice|feat-login|Login form"] };
    const h = await rig(options);
    expect((await h.status()).syncState?.rateLimitResetAt).toBe(new Date(resetAt * 1000).toISOString());
    gh.intercept = null;
    await h.manager.stop();
    const sent = gh.requests.length;
    await rig({ ...options, dir: h.dir });
    expect(gh.requests).toHaveLength(sent);
  });

  it("escapes quotes in a title search and tells pull requests from issues by their type", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const pull = gh.addPull("acme/web", { body: "", headRef: "x" });
    board.items.push({ id: "PVTI_pr", contentNodeId: `PR_${pull.number}`, status: "Done", agent: null });
    const c = client(gh);
    await c.findOpenIssuesByTitle("acme/web", 'say "hi" now', ['say "hi" now']);
    expect(gh.requests[0].query.get("q")).toBe('repo:acme/web is:issue is:open in:title "say hi now"');
    const items = await c.listBoardItems(board.id, "Status", null);
    expect(items).toEqual([{ id: "PVTI_pr", kind: "PullRequest", repo: "acme/web", number: pull.number, status: "Done", agent: null }]);
  });
});

const closedPullLists = (gh: FakeGitHub) => gh.requests.filter((r) => r.method === "GET" && r.path.endsWith("/pulls") && r.query.get("state") === "closed");
const statusSets = (gh: FakeGitHub, from: number) => gh.requests.slice(from).filter((r) => r.graphql === "updateProjectV2ItemFieldValue");
const issuePatches = (gh: FakeGitHub, from: number) => gh.requests.slice(from).filter((r) => r.method === "PATCH" && /\/issues\/\d+$/.test(r.path));

describe("merges made outside the review module (#262 item 2)", () => {
  it("a merged PR no review.merged announced (closing ref or branch name) moves its card to Done and closes the issue, once, also across a restart", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const login = gh.addIssue("acme/web", { title: "feat-login" });
    const search = gh.addIssue("acme/web", { title: "feat-search" });
    const options = { gh, tasks: ["worker-a|Alice|feat-login|Login form", "worker-b|Bob|feat-search|Search page"] };
    const h = await rig(options);
    await h.emit("agent.run.started", runStarted("feat-login"));
    gh.addPull("acme/web", { number: 21, body: "No keywords here", headRef: "agent/worker-b/feat-search" });
    await h.reconcile();
    expect(gh.card(board, "acme/web", login.number)?.status).toBe("In progress");
    expect(gh.card(board, "acme/web", search.number)?.status).toBe("In review");

    // Merged by a script's push or the web UI: PR 20 was never seen open, PR 21 was; no review.merged for either
    gh.addPull("acme/web", { number: 20, state: "closed", merged: true, body: `Fixes the form.\n\nCloses #${login.number}`, headRef: "fix/form" });
    gh.closePull("acme/web", 21, true);
    const before = gh.requests.length;
    await h.reconcile();
    expect(gh.card(board, "acme/web", login.number)?.status).toBe("Done");
    expect(gh.card(board, "acme/web", search.number)?.status).toBe("Done");
    expect(gh.issue("acme/web", login.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(gh.issue("acme/web", search.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(statusSets(gh, before)).toHaveLength(2);
    expect(issuePatches(gh, before)).toHaveLength(2);
    expect((await h.status()).links.every((l) => l.closedAs === "completed" && l.closedSynced && l.status === "done")).toBe(true);

    // Seen again, and after a restart (the store on disk): nothing more is sent, and no closed PRs are read for finished tasks
    const writes = gh.writes().length;
    const lists = closedPullLists(gh).length;
    await h.reconcile();
    await h.manager.stop();
    const again = await rig({ ...options, dir: h.dir });
    await again.reconcile();
    await again.emit("review.merged", reviewMerged(21));
    expect(gh.writes()).toHaveLength(writes);
    expect(closedPullLists(gh)).toHaveLength(lists);
  });

  it("a PR closed without merging leaves the card and the issue alone and is listed in the status; a later merge still finishes the task", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-login|Login form"] });
    gh.addPull("acme/web", { number: 30, body: `Closes #${issue.number}`, headRef: "fix/one" });
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("In review");

    gh.closePull("acme/web", 30, false);
    const writes = gh.writes().length;
    await h.reconcile();
    await h.reconcile();
    expect(gh.writes()).toHaveLength(writes);
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("In review");
    expect(gh.issue("acme/web", issue.number)?.state).toBe("open");
    const status = await h.status();
    expect(status.closedUnmerged).toEqual([{ task: "feat-login", prRepo: "acme/web", pr: 30 }]);
    expect(status.links[0]).toMatchObject({ status: "in_review", closedAs: null });

    gh.addPull("acme/web", { number: 31, state: "closed", merged: true, body: `Closes #${issue.number}`, headRef: "fix/two" });
    await h.reconcile();
    expect(gh.card(board, "acme/web", issue.number)?.status).toBe("Done");
    expect(gh.issue("acme/web", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect((await h.status()).closedUnmerged).toEqual([]);
  });

  it("reads one page of closed PRs per tracked repository, only while a linked task is In progress or In review; a failed read is an error, never a move", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    gh.addBoard("acme", 2);
    const issue = gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({
      gh,
      repos: [WEB, { repo: "acme/api", project: { owner: "acme", number: 2 }, match: { tasks: ["api-*"] } }],
      tasks: ["worker-a|Alice|feat-login|Login form"],
    });
    await h.reconcile();
    expect(closedPullLists(gh)).toHaveLength(0);

    await h.emit("agent.run.started", runStarted("feat-login"));
    await h.reconcile();
    expect(closedPullLists(gh).map((r) => [r.path, r.query.get("per_page"), r.query.get("sort"), r.query.get("direction")])).toEqual([
      ["/repos/acme/web/pulls", "100", "updated", "desc"],
      ["/repos/acme/api/pulls", "100", "updated", "desc"],
    ]);
    expect(closedPullLists(gh).every((r) => r.hadSignal)).toBe(true);

    gh.addPull("acme/web", { number: 40, state: "closed", merged: true, body: `Closes #${issue.number}`, headRef: "fix/x" });
    gh.intercept = (req) => (req.path.endsWith("/pulls") && req.query.get("state") === "closed" ? { status: 502, body: { message: "Bad gateway" } } : undefined);
    await h.reconcile();
    expect(gh.issue("acme/web", issue.number)?.state).toBe("open");
    expect((await h.status()).syncState?.lastError).toMatch(/closed pull requests.*502/);
    gh.intercept = null;
    await h.reconcile();
    expect(gh.issue("acme/web", issue.number)).toMatchObject({ state: "closed", stateReason: "completed" });
  });
});

describe("task lines removed by hand (#262 item 4)", () => {
  const LINES = {
    a: "worker-a|Alice|feat-a|Removed",
    b: "worker-a|Alice|feat-b|Commented out",
    c: "worker-a|Alice|feat-c|Grows too long",
    d: "worker-b|Bob|feat-d|Loses its description",
    e: "worker-b|Bob|feat-e|Comes and goes",
  };

  it("close_removed_tasks: a removed or commented-out line closes its issue as not planned after 2 reconciles in a row; a malformed or too-long line never", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const issues = Object.fromEntries(Object.keys(LINES).map((k) => [k, gh.addIssue("acme/web", { title: `feat-${k}` })]));
    const h = await rig({ gh, tracker: { close_removed_tasks: true }, tasks: Object.values(LINES) });
    expect((await h.status()).links).toHaveLength(5);
    // c grows past fill's 2000 characters, d loses its description field: both malformed, neither removed
    const kept = [`worker-a|Alice|feat-c|${"x".repeat(2100)}`, "worker-b|Bob|feat-d", LINES.e];
    const before = gh.requests.length;

    h.writeTasks([`#${LINES.b}`, ...kept]);
    await h.reconcile();
    expect(issuePatches(gh, before)).toHaveLength(0);
    expect((await h.status()).removedTasks.map((r) => [r.task, r.missedReconciles, r.action]).sort()).toEqual([
      ["feat-a", 1, "waiting"],
      ["feat-b", 1, "waiting"],
    ]);

    // The second reconcile in a row closes a and b; e leaves for one reconcile only, then once more after it came back
    h.writeTasks([`#${LINES.b}`, ...kept.slice(0, 2)]);
    await h.reconcile();
    expect(issuePatches(gh, before).map((r) => r.path).sort()).toEqual([`/repos/acme/web/issues/${issues.a.number}`, `/repos/acme/web/issues/${issues.b.number}`].sort());
    for (const k of ["a", "b"]) expect(gh.issue("acme/web", issues[k].number)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    h.writeTasks([`#${LINES.b}`, ...kept]);
    await h.reconcile();
    h.writeTasks([`#${LINES.b}`, ...kept.slice(0, 2)]);
    await h.reconcile();
    // A file with no task line at all is taken for a broken write: it counts nothing
    h.writeTasks([]);
    await h.reconcile();
    await h.reconcile();

    expect(issuePatches(gh, before)).toHaveLength(2);
    for (const k of ["c", "d", "e"]) expect(gh.issue("acme/web", issues[k].number)?.state, k).toBe("open");
    const status = await h.status();
    expect(status.links.filter((l) => l.closedAs === "not_planned").map((l) => l.task).sort()).toEqual(["feat-a", "feat-b"]);
    expect(status.removedTasks).toEqual([{ task: "feat-e", repo: "acme/web", issueNumber: issues.e.number, missedReconciles: 1, action: "waiting" }]);
  });

  it("without close_removed_tasks (the default) a removed line is recorded as would_close, once, and shown in the status; nothing is sent", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const a = gh.addIssue("acme/web", { title: "feat-a" });
    gh.addIssue("acme/web", { title: "feat-e" });
    const h = await rig({ gh, tasks: [LINES.a, LINES.e] });
    h.writeTasks([LINES.e]);
    const writes = gh.writes().length;
    await h.reconcile();
    await h.reconcile();
    await h.reconcile();
    expect(gh.writes()).toHaveLength(writes);
    expect(gh.issue("acme/web", a.number)?.state).toBe("open");
    const status = await h.status();
    expect(status.removedTasks).toEqual([{ task: "feat-a", repo: "acme/web", issueNumber: a.number, missedReconciles: 3, action: "would_close" }]);
    const rows = status.recentWrites.filter((w) => w.result === "would_close");
    expect(rows).toEqual([
      expect.objectContaining({ op: "close_issue", task: "feat-a", issueNumber: a.number, value: "not_planned", mode: "act", count: 2 }),
    ]);
    expect(JSON.parse(rows[0].wouldSend!)).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(status.links.find((l) => l.task === "feat-a")?.closedAs).toBeNull();
  });

  it("observe: a merge outside the review module and a removed line (close_removed_tasks on) are recorded as would_send; nothing is sent", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const login = gh.addIssue("acme/web", { title: "feat-login" });
    const a = gh.addIssue("acme/web", { title: "feat-a" });
    const h = await rig({ gh, tracker: { mode: "observe", close_removed_tasks: true }, tasks: ["worker-a|Alice|feat-login|Login form", LINES.a] });
    await h.emit("agent.run.started", runStarted("feat-login"));
    gh.addPull("acme/web", { number: 50, state: "closed", merged: true, body: `Closes #${login.number}`, headRef: "fix/form" });
    h.writeTasks(["worker-a|Alice|feat-login|Login form"]);
    await h.reconcile();
    await h.reconcile();
    await h.reconcile();
    expect(gh.writes()).toEqual([]);
    const closes = (await h.status()).recentWrites.filter((w) => w.op === "close_issue");
    expect(closes.map((w) => `${w.issueNumber} ${w.value} ${w.mode} ${w.result}`).sort()).toEqual(
      [`${login.number} completed observe would_send`, `${a.number} not_planned observe would_send`].sort(),
    );
  });
});

describe("wiring: off by default, live reload, owner-only routes, its own store (F6, F12)", () => {
  it("a project without a tracker block starts nothing and creates no store file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-tracker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const gh = new FakeGitHub();
    const manager = new TrackerManager({ dbPath: join(dir, "tracker.db"), fetch: gh.fetch, events: new EventBus() });
    const config = { name: "x", repo: dir, github: "acme/web" } as unknown as ProjectConfig;
    manager.load([{ name: PROJECT, config }]);
    expect(manager.validate(config)).toEqual([]);
    expect(manager.start()).toEqual([]);
    expect(manager.status(PROJECT)).toMatchObject({ enabled: false, running: false, errors: [] });
    await manager.stop();
    expect(readdirSync(dir)).toEqual([]);
    expect(gh.requests).toEqual([]);
  });

  it("a config change reloads it: observe then act, its links carried over", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    gh.addIssue("acme/web", { title: "feat-login" });
    const h = await rig({ gh, tracker: { mode: "observe" }, tasks: ["worker-a|Alice|feat-login|Login form"] });
    expect(gh.writes()).toEqual([]);
    const [module] = serverModules({ trackers: h.manager });
    expect(module).toMatchObject({ name: "tracker", blocks: ["tracker"] });
    const act = { ...h.config, tracker: { ...(h.config.tracker as object), mode: "act" } } as ProjectConfig;
    expect(module.validate(act)).toEqual([]);
    expect(module.validate({ ...h.config, tracker: { enabled: true, mode: "loud" } } as unknown as ProjectConfig)).toEqual([
      expect.stringContaining("tracker.mode"),
    ]);
    await module.reload({ name: PROJECT, config: act });
    await h.idle();
    expect(h.manager.get(PROJECT)?.settings.mode).toBe("act");
    expect(board.items).toHaveLength(1);
    expect((await h.status()).links.map((l) => l.task)).toEqual(["feat-login"]);
  });

  it("every route is the owner's; a reconcile asked for is recorded with the owner session", async () => {
    const h = await rig();
    for (const [method, url] of [
      ["GET", "/api/tracker/status"],
      ["POST", "/api/tracker/reconcile"],
    ] as const) {
      for (const headers of [{}, BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }]) {
        expect((await h.app.inject({ method, url, headers })).statusCode, `${method} ${url}`).toBe(403);
      }
    }
    await h.reconcile();
    const status = await h.status();
    expect(status.recentWrites.find((w) => w.op === "sync_requested")).toMatchObject({ value: h.sessionId });
    const off = await h.app.inject({ method: "POST", url: "/api/tracker/reconcile?project=other", headers: h.owner });
    expect(off.statusCode).toBe(404);
  });

  it("keeps its schema version in its own table: another store's file and a newer one are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-tracker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const shared = join(dir, "shared.db");
    const other = new Database(shared);
    other.pragma("user_version = 5");
    other.close();
    expect(() => new TrackerStore(shared)).toThrow(/belongs to another store/);

    const own = join(dir, "tracker.db");
    new TrackerStore(own).close();
    const db = new Database(own);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    db.prepare("UPDATE tracker_schema SET version = 99").run();
    db.close();
    expect(() => new TrackerStore(own)).toThrow(/newer Lair/);
  });
});

describe("no synchronous fs or child process on the event loop", () => {
  it("the tracker's sources use none", () => {
    const dir = join(__dirname);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(6);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf-8");
      expect(text, file).not.toMatch(/\b\w+Sync\(/);
      expect(text, file).not.toMatch(/from "(?:node:)?child_process"/);
    }
  });
});

describe("link proposals (#262 item 1)", () => {
  const accept = (h: Awaited<ReturnType<typeof rig>>, body: Record<string, unknown>, headers: Record<string, string> = h.owner) =>
    h.app.inject({ method: "POST", url: `/api/tracker/links?project=${PROJECT}`, headers, payload: body });

  it("an issue naming the task, a PR of the task closing an issue, a close title: proposed as would_link, not linked (auto_link off); the owner accepts one, audited", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const alpha = gh.addIssue("acme/web", { title: "Build the checkout (feat-alpha)" });
    const payments = gh.addIssue("acme/web", { title: "Payments" });
    const gamma = gh.addIssue("acme/web", { title: "Order history page for customer" });
    gh.addPull("acme/web", { number: 40, body: `Adds the provider.\n\nCloses #${payments.number}`, headRef: "agent/worker-a/feat-beta" });
    const h = await rig({
      gh,
      tasks: ["worker-a|Alice|feat-alpha|Checkout page", "worker-a|Alice|feat-beta|Payment provider", "worker-a|Alice|feat-gamma|Order history page for customers", "worker-a|Alice|feat-delta|Nothing like it"],
    });
    const status = await h.status();
    expect(status.links).toEqual([]);
    expect(board.items).toEqual([]);
    expect(status.proposals.map((p) => [p.task, p.action, p.candidates.map((c) => [c.issueNumber, c.reasons.join("+"), c.pr])])).toEqual([
      ["feat-alpha", "would_link", [[alpha.number, "mentions_task", null]]],
      ["feat-beta", "would_link", [[payments.number, "pull_closes", 40]]],
      ["feat-gamma", "would_link", [[gamma.number, "similar_title", null]]],
    ]);
    expect(status.proposals[2].candidates[0].score).toBeGreaterThanOrEqual(0.85);
    const rows = status.recentWrites.filter((w) => w.result === "would_link");
    expect(rows.map((w) => `${w.task} ${w.op} ${w.issueNumber} ${w.value} ${w.mode}`).sort()).toEqual([
      `feat-alpha link_issue ${alpha.number} mentions_task act`,
      `feat-beta link_issue ${payments.number} pull_closes act`,
      `feat-gamma link_issue ${gamma.number} similar_title act`,
    ]);
    // Recorded once: a second reconcile counts the same rows up
    await h.reconcile();
    expect((await h.status()).recentWrites.filter((w) => w.result === "would_link").map((w) => w.count)).toEqual([2, 2, 2]);
    expect((await h.status()).links).toEqual([]);

    // Not proposed for that task: refused; without an owner session: refused, nothing linked
    expect((await accept(h, { task: "feat-alpha", repo: "acme/web", issue: gamma.number })).statusCode).toBe(409);
    expect((await accept(h, { task: "feat-delta", repo: "acme/web", issue: alpha.number })).statusCode).toBe(409);
    for (const headers of [{}, BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }]) {
      expect((await accept(h, { task: "feat-alpha", repo: "acme/web", issue: alpha.number }, headers)).statusCode).toBe(403);
    }
    expect((await accept(h, { task: "feat-alpha", repo: "acme/web", issue: "1" })).statusCode).toBe(400);
    await h.idle();
    expect((await h.status()).links).toEqual([]);

    const res = await accept(h, { task: "feat-alpha", repo: "acme/web", issue: alpha.number });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    const after = await h.status();
    expect(after.links.map((l) => [l.task, l.issueNumber])).toEqual([["feat-alpha", alpha.number]]);
    expect(gh.card(board, "acme/web", alpha.number)?.status).toBe("Backlog");
    expect(after.recentWrites.find((w) => w.op === "link_issue" && w.result === "success")).toMatchObject({ task: "feat-alpha", value: `owner ${h.sessionId}` });
    expect(after.proposals.map((p) => p.task)).toEqual(["feat-beta", "feat-gamma"]);
    // Linked already: refused
    expect((await accept(h, { task: "feat-alpha", repo: "acme/web", issue: alpha.number })).statusCode).toBe(409);
  });

  it("ambiguous (two candidates, or one issue for two tasks) is never linked, even with auto_link; a single candidate is, once; the owner may pick one", async () => {
    const gh = new FakeGitHub();
    const board = gh.addBoard("acme", 1);
    const first = gh.addIssue("acme/web", { title: "feat-login follow-up" });
    const second = gh.addIssue("acme/web", { title: "Session cookies", body: "Depends on feat-login." });
    const shared = gh.addIssue("acme/web", { title: "Settings page layout" });
    const cart = gh.addIssue("acme/web", { title: "Shopping cart drawer" });
    const h = await rig({
      gh,
      tracker: { auto_link: true },
      tasks: [
        "worker-a|Alice|feat-login|Sign in",
        "worker-a|Alice|feat-set1|Settings page layout",
        "worker-a|Alice|feat-set2|Settings page layouts",
        "worker-a|Alice|feat-cart|Shopping cart drawer",
      ],
    });
    let status = await h.status();
    expect(status.links.map((l) => [l.task, l.issueNumber])).toEqual([["feat-cart", cart.number]]);
    expect(gh.card(board, "acme/web", cart.number)?.status).toBe("Backlog");
    expect(status.recentWrites.filter((w) => w.op === "link_issue" && w.result === "success").map((w) => w.value)).toEqual(["auto: similar_title"]);
    expect(status.proposals.map((p) => [p.task, p.action, p.candidates.map((c) => c.issueNumber).sort()])).toEqual([
      ["feat-login", "ambiguous", [first.number, second.number].sort()],
      ["feat-set1", "ambiguous", [shared.number]],
      ["feat-set2", "ambiguous", [shared.number]],
    ]);
    const ambiguousRows = status.recentWrites.filter((w) => w.result === "would_link");
    expect(ambiguousRows).toHaveLength(3);
    for (const row of ambiguousRows) expect(row).toMatchObject({ op: "link_issue", repo: null, issueNumber: null, value: expect.stringMatching(/^ambiguous: /) });

    // Later reconciles link nothing more
    const writes = gh.writes().length;
    await h.reconcile();
    await h.reconcile();
    expect(gh.writes()).toHaveLength(writes);
    status = await h.status();
    expect(status.links).toHaveLength(1);
    expect(status.recentWrites.filter((w) => w.op === "link_issue" && w.result === "success")).toHaveLength(1);

    // The owner picks one of the candidates
    const res = await accept(h, { task: "feat-login", repo: "acme/web", issue: second.number });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    expect((await h.status()).links.find((l) => l.task === "feat-login")?.issueNumber).toBe(second.number);
  });

  it("observe: proposals are recorded as would_link and never linked, even with auto_link; an accepted link is Lair's only, its card would_send", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const cart = gh.addIssue("acme/web", { title: "Shopping cart drawer" });
    const h = await rig({ gh, tracker: { mode: "observe", auto_link: true }, tasks: ["worker-a|Alice|feat-cart|Shopping cart drawer"] });
    let status = await h.status();
    expect(status.links).toEqual([]);
    expect(status.recentWrites.filter((w) => w.result === "would_link")).toEqual([
      expect.objectContaining({ task: "feat-cart", issueNumber: cart.number, op: "link_issue", mode: "observe", value: "similar_title" }),
    ]);
    const res = await accept(h, { task: "feat-cart", repo: "acme/web", issue: cart.number });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    status = await h.status();
    expect(status.links.map((l) => l.task)).toEqual(["feat-cart"]);
    expect(status.recentWrites.find((w) => w.op === "add_to_board")).toMatchObject({ result: "would_send", mode: "observe" });
    expect(gh.writes()).toEqual([]);
  });

  it("a failed read links nothing: the open-issues page failing keeps the proposals as they were; an accept whose issue read fails is audited as an error", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const cart = gh.addIssue("acme/web", { title: "Shopping cart drawer" });
    const openIssuesPage = (req: { method: string; path: string; query: URLSearchParams }) =>
      req.method === "GET" && req.path === "/repos/acme/web/issues" && req.query.get("sort") === "updated";
    gh.intercept = (req) => (openIssuesPage(req) ? { status: 502, body: { message: "Bad gateway" } } : undefined);
    const h = await rig({ gh, tasks: ["worker-a|Alice|feat-cart|Shopping cart drawer"] });
    let status = await h.status();
    expect(status.proposals).toEqual([]);
    expect(status.recentWrites.filter((w) => w.op === "link_issue")).toEqual([]);
    expect(status.syncState?.lastError).toMatch(/open issues/);
    expect(gh.requests.filter(openIssuesPage)).toHaveLength(1);

    gh.intercept = null;
    await h.reconcile();
    expect((await h.status()).proposals.map((p) => p.task)).toEqual(["feat-cart"]);
    // The page fails again: the last proposals stay, still nothing linked
    gh.intercept = (req) => (openIssuesPage(req) ? { status: 502, body: { message: "Bad gateway" } } : undefined);
    await h.reconcile();
    expect((await h.status()).proposals.map((p) => p.task)).toEqual(["feat-cart"]);

    gh.intercept = (req) => (req.method === "GET" && req.path === `/repos/acme/web/issues/${cart.number}` ? { status: 500, body: { message: "boom" } } : undefined);
    expect((await accept(h, { task: "feat-cart", repo: "acme/web", issue: cart.number })).statusCode).toBe(202);
    await h.idle();
    status = await h.status();
    expect(status.links).toEqual([]);
    expect(status.recentWrites.find((w) => w.op === "link_issue" && w.result !== "would_link")).toMatchObject({ result: "error", value: `owner ${h.sessionId}` });

    gh.intercept = null;
    gh.issue("acme/web", cart.number)!.state = "closed";
    expect((await accept(h, { task: "feat-cart", repo: "acme/web", issue: cart.number })).statusCode).toBe(202);
    await h.idle();
    status = await h.status();
    expect(status.links).toEqual([]);
    expect(status.recentWrites.find((w) => w.op === "link_issue" && w.result === "skipped")).toMatchObject({ error: "the issue is closed" });
  });

  it("each reconcile tries the next unlinked tasks (at most 10 searches), so a task past the 10th is linked too", async () => {
    const gh = new FakeGitHub();
    const lines = Array.from({ length: 12 }, (_, i) => `worker-a|Alice|feat-${i + 1}|Plain task number ${i + 1}`);
    gh.addIssue("acme/web", { title: "feat-12" });
    const h = await rig({ gh, repos: [{ repo: "acme/web", default: true }], tasks: lines });
    const searches = () => gh.requests.filter((r) => r.path === "/search/issues").length;
    expect(searches()).toBe(10);
    expect((await h.status()).links).toEqual([]);
    await h.reconcile();
    expect(searches()).toBeLessThanOrEqual(20);
    expect((await h.status()).links.map((l) => l.task)).toEqual(["feat-12"]);
  });

  it("matching: a task id is a word of its own; a plain-word id is never matched by mention; titles compare by bigrams", () => {
    expect([...mentionTokens("Fixes (feat-a). See `feat-b`: x, feat-c.v2 and #feat-d")].filter((w) => w.startsWith("feat"))).toEqual(["feat-a", "feat-b", "feat-c.v2", "feat-d"]);
    expect(distinctiveTaskId("login")).toBe(false);
    expect(distinctiveTaskId("api")).toBe(false);
    expect(distinctiveTaskId("feat-a")).toBe(true);
    expect(titleSimilarity("Order history page for customers", "order history page, for customer")).toBeGreaterThan(0.9);
    expect(titleSimilarity("Login form (web)", "Login form")).toBeLessThan(0.85);
    expect(titleSimilarity("short", "short")).toBe(0);
  });
});

describe("per-repository redaction and creates (#262 item 3)", () => {
  const CORE = { repo: "acme/core", default: true, project: { owner: "acme", number: 2 }, agent_field: "Agent" };

  it("create_issues per repository: on for the private one, off for the public one", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 2);
    gh.addBoard("acme", 3);
    const h = await rig({
      gh,
      tracker: { create_issues_for_new_tasks: true },
      repos: [CORE, { repo: "acme/site", project: { owner: "acme", number: 3 }, match: { tasks: ["site-*"] }, create_issues: false }],
      tasks: ["worker-a|Alice|core-api|API server", "worker-a|Alice|site-home|Home page"],
    });
    expect(gh.issues("acme/core").map((i) => i.title)).toEqual(["core-api: API server"]);
    expect(gh.issues("acme/site")).toEqual([]);
    expect(gh.writes().filter((r) => r.path.startsWith("/repos/acme/site"))).toEqual([]);
    expect((await h.status()).links.map((l) => `${l.task} ${l.repo}`)).toEqual(["core-api acme/core"]);
    expect(parseTrackerConfig({ enabled: true, create_issues_for_new_tasks: true, repos: [{ repo: "a/b" }, { repo: "a/c", create_issues: false }] }, h.config))
      .toMatchObject({ ok: true, settings: { repos: [{ createIssues: true }, { createIssues: false }] } });
    expect(parseTrackerConfig({ enabled: true, repos: [{ repo: "a/b", redact_patterns: ["(unclosed"] }] }, h.config)).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^tracker\.repos\[0\]\.redact_patterns\[0\]: not a valid regular expression/)],
    });
  });

  it("a private name configured for the public repository never reaches it (title, body, comment, Agent field, search); the private one still gets it", async () => {
    const gh = new FakeGitHub();
    const coreBoard = gh.addBoard("acme", 2);
    const siteBoard = gh.addBoard("acme", 3);
    const h = await rig({
      gh,
      tracker: { create_issues_for_new_tasks: true },
      repos: [CORE, { repo: "acme/site", project: { owner: "acme", number: 3 }, agent_field: "Agent", match: { tasks: ["*-site"] }, redact_patterns: ["zephyr"] }],
      tasks: ["zephyr-bot|Zed|zephyr-site|Zephyr landing page", "zephyr-bot|Zed|zephyr-core|Zephyr engine"],
    });
    for (const task of ["zephyr-site", "zephyr-core"]) {
      await h.emit("agent.run.started", runStarted(task, "zephyr-bot", `ev-${task}`));
      await h.emit("planner.blocked", plannerBlocked(task, "owner", "zephyr_gate", "zephyr-bot"));
    }

    const [site] = gh.issues("acme/site");
    const [core] = gh.issues("acme/core");
    expect(site.title).toBe("[redacted]-site: [redacted] landing page");
    expect(site.comments).toHaveLength(1);
    expect(gh.card(siteBoard, "acme/site", site.number)?.agent).toBe("[redacted]-bot");
    const toSite = gh.requests.filter(
      (r) => r.path.startsWith("/repos/acme/site") || (r.query.get("q") ?? "").includes("repo:acme/site") || r.body?.variables?.board === siteBoard.id,
    );
    expect(toSite.filter((r) => r.write).length).toBeGreaterThanOrEqual(5);
    for (const r of toSite) expect(JSON.stringify({ path: r.path, query: r.query.toString(), body: r.body ?? null }), r.path).not.toMatch(/zephyr/i);

    expect(core.title).toBe("zephyr-core: Zephyr engine");
    expect(core.body).toContain("Zephyr engine");
    expect(core.comments[0]).toContain("zephyr_gate");
    expect(gh.card(coreBoard, "acme/core", core.number)?.agent).toBe("zephyr-bot");
  });

  it("observe: what would be sent to the public repository is recorded redacted", async () => {
    const gh = new FakeGitHub();
    const h = await rig({
      gh,
      tracker: { mode: "observe", create_issues_for_new_tasks: true },
      repos: [{ repo: "acme/core", default: true }, { repo: "acme/site", match: { tasks: ["*-site"] }, redact_patterns: ["zephyr"] }],
      tasks: ["worker-a|Alice|zephyr-site|Zephyr landing page", "worker-a|Alice|zephyr-core|Zephyr engine"],
    });
    const creates = (await h.status()).recentWrites.filter((w) => w.op === "create_issue");
    expect(creates.map((w) => `${w.repo} ${w.result}`).sort()).toEqual(["acme/core would_send", "acme/site would_send"]);
    expect(creates.find((w) => w.repo === "acme/site")!.wouldSend).not.toMatch(/zephyr/i);
    expect(creates.find((w) => w.repo === "acme/core")!.wouldSend).toMatch(/Zephyr engine/);
    expect(gh.writes()).toEqual([]);
  });
});

describe("a removed-line miss counts only for tasks this process has seen (#271)", () => {
  it("links from before a restart whose lines are gone count nothing; a line seen and then removed still does", async () => {
    const gh = new FakeGitHub();
    gh.addBoard("acme", 1);
    const a = gh.addIssue("acme/web", { title: "feat-a" });
    const e = gh.addIssue("acme/web", { title: "feat-e" });
    const lineA = "worker-a|Alice|feat-a|Removed while stopped";
    const lineE = "worker-b|Bob|feat-e|Removed while running";
    const first = await rig({ gh, tracker: { close_removed_tasks: true }, tasks: [lineA, lineE] });
    expect((await first.status()).links).toHaveLength(2);
    await first.manager.stop();

    // Restarted with a's line gone (or a reload pointing at another file): a was never seen by this process
    const h = await rig({ gh, dir: first.dir, tracker: { close_removed_tasks: true }, tasks: [lineE] });
    await h.reconcile();
    await h.reconcile();
    expect(gh.issue("acme/web", a.number)?.state).toBe("open");
    expect((await h.status()).removedTasks).toEqual([]);

    h.writeTasks(["worker-a|Alice|feat-x|Another line"]);
    await h.reconcile();
    await h.reconcile();
    expect(gh.issue("acme/web", e.number)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(gh.issue("acme/web", a.number)?.state).toBe("open");
  });
});
