/**
 * The work store through its real entry points: the owner-only routes on Fastify with a real owner session, the
 * manager as index.ts wires it (load, start, its events), a real agents store (runs, claims, events), the real bus
 * (BusService writes the report, mirrors its queue line and emits bus.report) and real files on disk. Stand-ins, where
 * a test says so: fill's ready guard (the `accepted` option) and fill's view at its last check (the `fill` option).
 */
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FillLineView, FillStatusView } from "../../shared/agents-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { AgentsStore } from "../agents/store.js";
import type { AgentRun } from "../agents/types.js";
import type { ReportKind } from "../../bus/types.js";
import { BusService } from "../bus/service.js";
import { closeBusStores, existingBusStore, getBusStore } from "../bus/store.js";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { serverModules } from "../reload/modules.js";
import { WorkStoreManager, type WorkStatus } from "./manager.js";
import { registerWorkRoutes } from "./routes.js";
import { SqliteWorkStore } from "./store.js";

const PROJECT = "shop";
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const EMPTY_TAIL = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface RigOptions {
  workStore?: Record<string, unknown> | undefined;
  tasks?: string[];
  queue?: string[];
  accepted?: (task: string) => boolean | Promise<boolean>;
  /** Fill's view at its last check (a stand-in: fill itself is not running here) */
  fill?: () => FillStatusView | null;
  followTimeoutMs?: number;
  followIntervalMs?: number;
}

async function rig(o: RigOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lair-work-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tasksFile = join(dir, "tasks.txt");
  const queueFile = join(dir, "queue.md");
  writeFileSync(tasksFile, (o.tasks ?? []).join("\n") + "\n");
  writeFileSync(queueFile, (o.queue ?? []).join("\n") + "\n");
  const config = {
    name: "Shop",
    repo: dir,
    queue_file: queueFile,
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    read_only: false,
    // Relative: resolved against the repository, as fill resolves it
    agents: { enabled: false, fill: { enabled: false, tasks_file: "tasks.txt", agents: ["worker-a", "worker-b"] } },
    ...("workStore" in o ? (o.workStore ? { work_store: o.workStore } : {}) : { work_store: { mode: "observe" } }),
  } as unknown as ProjectConfig;
  const agents = new AgentsStore(join(dir, "agents.db"));
  const dataDir = join(dir, "data");
  const events = new EventBus();
  const warnings: string[] = [];
  let now = 1_000;
  // As index.ts builds it, with the server's events; the follower's timer is not what these tests wait on (one does)
  const managerFor = () =>
    new WorkStoreManager({
      dataDir,
      runs: () => agents,
      bus: () => null,
      reports: (project) => existingBusStore(project, dataDir),
      accepted: o.accepted ? () => async (_agent, task) => o.accepted!(task) : undefined,
      fill: o.fill ? () => o.fill!() : undefined,
      events,
      followIntervalMs: o.followIntervalMs ?? 3_600_000,
      followTimeoutMs: o.followTimeoutMs,
      now: () => now,
      log: { warn: (text: string) => warnings.push(text) },
    });
  const managers: WorkStoreManager[] = [];
  const started = (manager: WorkStoreManager) => {
    manager.load([{ name: PROJECT, config }]);
    managers.push(manager);
    return manager;
  };
  const manager = started(managerFor());
  const app = Fastify();
  const auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  await registerWorkRoutes(app, manager, () => PROJECT, auth);
  await app.ready();
  const session = auth.createSession(readFileSync(join(dir, "owner.token"), "utf-8").trim());
  if (!session) throw new Error("no owner session");
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: session.session };
  cleanups.push(async () => {
    for (const m of managers) await m.stop();
    await app.close();
    auth.close();
    agents.close();
    closeBusStores();
  });
  const get = async (url: string) => {
    const res = await app.inject({ url, headers: owner });
    return { status: res.statusCode, body: res.json() };
  };
  const importFiles = async (dryRun?: boolean) => {
    const res = await app.inject({ method: "POST", url: `/api/work/import?project=${PROJECT}`, headers: owner, payload: dryRun === undefined ? {} : { dry_run: dryRun } });
    return { status: res.statusCode, body: res.json() };
  };
  const task = (id: string) => get(`/api/work/task?project=${PROJECT}&id=${encodeURIComponent(id)}`);
  const tasks = async (query = "") => (await get(`/api/work/tasks?project=${PROJECT}${query}`)).body.data as Record<string, unknown>[];
  const status = async () => (await get(`/api/work/status?project=${PROJECT}`)).body.data as WorkStatus;
  const run = (fields: Partial<AgentRun>) =>
    agents.insertRun({ project: PROJECT, chainId: `chain-${fields.id}`, requestedAt: now, queueMark: { offset: 0, tail: EMPTY_TAIL }, ...fields } as AgentRun);
  // The bus as the bus routes build it: the report is stored, its line mirrored to the queue file, then bus.report
  const bus = new BusService({
    store: getBusStore(PROJECT, dataDir),
    getClaimedTask: (runId) => agents.getRun(runId)?.task ?? null,
    getAllClaims: () => [],
    getKnownAgents: () => [],
    mirrorConfig: { queueFile },
    events,
  });
  const report = async (runId: string, kind: ReportKind, summary: string, extra: { gateId?: string; pr?: number; sha?: string } = {}) => {
    const r = agents.getRun(runId)!;
    const sent = await bus.report({ project: PROJECT, agent: r.agent, runId, tokenHash: "t", issuedAt: 0 }, kind, r.task, summary, extra.gateId, extra.pr, extra.sha);
    if (!sent.ok) throw new Error(sent.error.message);
    return sent.data.id;
  };
  // A run and claim fact as AgentsService.record writes and emits it (agents/service.ts)
  const fact = async (kind: "started" | "completed" | "claim_released", runId: string) => {
    const r = agents.getRun(runId)!;
    const at = Date.now();
    const event = agents.addEvent({ project: PROJECT, kind, agent: r.agent, task: r.task, runId, subject: r.task, summary: `${kind} ${r.task}`, evidence: [], data: {}, at })!;
    const type = kind === "started" ? "agent.run.started" : kind === "completed" ? "agent.run.ended" : "agent.claim.released";
    await events.emit(type, { project: PROJECT, kind, eventId: event.id, agent: r.agent, task: r.task, runId, subject: r.task, summary: event.summary });
  };
  return {
    dir, config, manager, app, agents, owner, session, warnings, dataDir, tasksFile, queueFile, events,
    get, importFiles, task, tasks, status, run, report, fact,
    /** Another manager on the same data, as after a restart (not started) */
    restart: () => started(managerFor()),
    setNow: (at: number) => (now = at),
    writeTasks: (lines: string[]) => writeFileSync(tasksFile, lines.join("\n") + "\n"),
  };
}

const changesOf = (body: { data: { changes: { task: string; kind: string; to?: string }[] } }) =>
  body.data.changes.map((c) => `${c.kind} ${c.task}${c.to ? ` ${c.to}` : ""}`).sort();

describe("work store routes: the owner's only", () => {
  it("answers 403 on every route without the owner session, before any work: no store file is made", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"] });
    const routes = [
      { method: "GET" as const, url: `/api/work/status?project=${PROJECT}` },
      { method: "GET" as const, url: `/api/work/tasks?project=${PROJECT}` },
      { method: "GET" as const, url: `/api/work/task?project=${PROJECT}&id=feat-1` },
      { method: "POST" as const, url: `/api/work/import?project=${PROJECT}`, payload: { dry_run: false } },
    ];
    for (const route of routes) {
      for (const headers of [{}, BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }]) {
        expect((await h.app.inject({ ...route, headers })).statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    }
    expect(existsSync(join(h.dataDir, "work"))).toBe(false);
  });

  it("refuses a valid owner session sent from another site, before the body is read: no store file is made", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"] });
    // The session is the owner's; the request comes from a foreign page (the cross-site hook runs first)
    const headers = { ...h.owner, origin: "http://evil.example", "sec-fetch-site": "cross-site" };
    const res = await h.app.inject({ method: "POST", url: `/api/work/import?project=${PROJECT}`, headers, payload: { dry_run: false } });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(h.dataDir, "work"))).toBe(false);
    // The same session from the dashboard is let in
    expect((await h.importFiles(true)).status).toBe(200);
  });
});

describe("work store: off by default", () => {
  it("keeps today's files exactly: no store file, every read and import 404, the status says off", async () => {
    const h = await rig({ workStore: undefined, tasks: ["worker-a|A|feat-1|Ship it"] });
    const status = await h.get(`/api/work/status?project=${PROJECT}`);
    expect(status.body.data).toMatchObject({ mode: "off", store: null, problems: [], follow: null, comparison: null });
    expect((await h.get(`/api/work/tasks?project=${PROJECT}`)).status).toBe(404);
    expect((await h.task("feat-1")).status).toBe(404);
    const imported = await h.importFiles(false);
    expect(imported.status).toBe(404);
    expect(imported.body.error).toContain("work_store.mode");
    expect(existsSync(join(h.dataDir, "work"))).toBe(false);
  });

  it("refuses an unknown key or mode: the store stays off and the status names why", async () => {
    const h = await rig({ workStore: { mode: "on" } });
    expect(h.manager.validate({ work_store: { mode: "on" } } as unknown as ProjectConfig)[0]).toContain("work_store.mode must be one of off, observe");
    expect(h.manager.validate({ work_store: { mode: "observe", files: "mirror" } } as unknown as ProjectConfig)[0]).toContain("work_store.files must be follow");
    expect(h.manager.validate({ work_store: { mode: "observe", follow: true } } as unknown as ProjectConfig)[0]).toContain("work_store.follow is not a known key");
    expect(h.manager.validate({ work_store: { mode: "observe", files: "follow" } } as unknown as ProjectConfig)).toEqual([]);
    expect(h.manager.validate({} as ProjectConfig)).toEqual([]);
    const status = await h.get(`/api/work/status?project=${PROJECT}`);
    expect(status.body.data.mode).toBe("off");
    expect(status.body.data.problems[0]).toContain("work_store.mode");
    expect(h.warnings[0]).toContain("the work store stays off");
    expect((await h.importFiles(true)).status).toBe(404);
  });

  it("follows a live reload through the reloader's module: on with observe, off again closes the store and keeps its file", async () => {
    const h = await rig({ workStore: undefined, tasks: ["worker-a|A|feat-1|Ship it"] });
    // As index.ts hands the manager to the reloader: its own block, and the blocks an import reads
    const module = serverModules({ work: h.manager }).find((m) => m.name === "work_store");
    expect(module).toMatchObject({ blocks: ["work_store"], reads: ["agents", "planner"] });
    expect(module!.validate({ ...h.config, work_store: { mode: "on" } })[0]).toContain("work_store.mode must be one of");
    expect((await h.importFiles(false)).status).toBe(404);
    await module!.reload({ name: PROJECT, config: { ...h.config, work_store: { mode: "observe" } } });
    expect((await h.importFiles(false)).status).toBe(200);
    await module!.reload({ name: PROJECT, config: { ...h.config, work_store: { mode: "off" } } });
    expect((await h.get(`/api/work/tasks?project=${PROJECT}`)).status).toBe(404);
    expect(existsSync(join(h.dataDir, "work", `${PROJECT}.db`))).toBe(true);
  });
});

describe("work store: the importer", () => {
  const TASKS = [
    "# the tasks",
    "worker-a|A|Feat-1.2|Ship the search page",
    "worker-b|B|area/topic#3|Fix the topic list",
    "|Anyone|free-1|Work for any agent",
    "#done worker-a|A|old-1|Finished earlier",
    "a line without fields",
  ];

  it("a dry run (the default) reports every task fill's parser reads and a warning, and writes nothing", async () => {
    const h = await rig({ tasks: TASKS });
    const dry = await h.importFiles();
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, tasksFile: h.tasksFile, read: 4, unchanged: 0 });
    expect(changesOf(dry.body)).toEqual(["created Feat-1.2 ready", "created area/topic#3 ready", "created free-1 ready", "created old-1 done"]);
    expect(dry.body.data.warnings).toEqual(["line 6: expected <agent>|<name>|<task>|<description>"]);
    expect(await h.tasks()).toEqual([]);
    // A dry run adopts nothing: no cursor, and the follower waits
    expect((await h.status()).store).toMatchObject({ schemaVersion: 2, counts: {}, lastImport: null, adopted: false, cursors: {} });
  });

  it("an apply stores the states fill's checks read: DONE, WAITING, BLOCKED, a refused DONE, and a claim shown running with no write", async () => {
    const h = await rig({
      tasks: [
        "worker-a|A|feat-done|Done in the queue",
        "worker-b|B|feat-wait|Waits on a gate",
        "worker-a|A|feat-block|Needs a key",
        "worker-b|B|feat-run|Being worked on",
        "worker-a|A|feat-guard|Its PR is not ready",
      ],
      queue: [
        "- DONE feat-done by worker-a",
        "- WAITING feat-wait gate-12 by worker-b",
        "- BLOCKED feat-block needs the signing key by worker-a",
        "- DONE feat-guard PR #12 by worker-a",
      ],
      // Fill's ready guard (the one stand-in): it refuses feat-guard's DONE
      accepted: (task) => task !== "feat-guard",
    });
    h.run({ id: "run-wait", task: "feat-wait", agent: "worker-b", state: "completed" });
    h.run({ id: "run-block", task: "feat-block", agent: "worker-a", state: "completed" });
    h.run({ id: "run-live", task: "feat-run", agent: "worker-b", state: "running" });
    expect(h.agents.claim(PROJECT, "feat-run", "run-live", "worker-b", { pid: 4242, startedAt: 1 }, 1_000, () => true).ok).toBe(true);

    const applied = await h.importFiles(false);
    expect(applied.status).toBe(200);
    expect(applied.body.data.warnings).toEqual(["feat-guard: fill's ready guard refuses its DONE line: imported as not done"]);
    const byId = Object.fromEntries((await h.tasks()).map((t) => [t.id, t]));
    expect(byId["feat-done"]).toMatchObject({ state: "done", derived: "done" });
    expect(byId["feat-wait"]).toMatchObject({ state: "waiting", derived: "waiting" });
    expect(byId["feat-block"]).toMatchObject({ state: "blocked", blockedReason: "- BLOCKED feat-block needs the signing key by worker-a" });
    expect(byId["feat-guard"]).toMatchObject({ state: "ready", derived: "ready" });
    // The claim is the holder: the row stays ready (version 1), the read shows running
    expect(byId["feat-run"]).toMatchObject({ state: "ready", version: 1, derived: "running", holder: { agent: "worker-b", runId: "run-live" } });
    expect((await h.tasks("&state=running")).map((t) => t.id)).toEqual(["feat-run"]);
    expect((await h.tasks("&state=ready")).map((t) => t.id)).toEqual(["feat-guard"]);

    const wait = await h.task("feat-wait");
    expect(wait.body.data.events).toEqual([
      expect.objectContaining({ kind: "created", actor: { kind: "owner", id: h.session.info.id }, payload: expect.objectContaining({ state: "waiting", reason: "- WAITING feat-wait gate-12 by worker-b" }) }),
    ]);
    const status = (await h.get(`/api/work/status?project=${PROJECT}`)).body.data.store;
    expect(status.counts).toEqual({ done: 1, waiting: 1, blocked: 1, ready: 2 });
    expect(status.lastImport).toMatchObject({ created: 5, updated: 0, dropped: 0, actor: { kind: "owner", id: h.session.info.id } });
  });

  it("is idempotent and one way: a second apply changes nothing; an edit, a removal and a return are one event each", async () => {
    const h = await rig({ tasks: TASKS });
    await h.importFiles(false);
    const first = (await h.get(`/api/work/status?project=${PROJECT}`)).body.data.store.lastImport;
    const again = await h.importFiles(false);
    expect(again.body.data).toMatchObject({ changes: [], unchanged: 4 });
    expect((await h.get(`/api/work/status?project=${PROJECT}`)).body.data.store.lastImport.id).toBe(first.id);

    // Reworded, one line gone, and the unassigned line made malformed (fill refuses it: its task is kept, not dropped)
    h.setNow(2_000);
    h.writeTasks(["worker-a|A|Feat-1.2|Ship the search page with filters", "|Anyone|free-1", "#done worker-a|A|old-1|Finished earlier"]);
    const changed = await h.importFiles(false);
    expect(changesOf(changed.body)).toEqual(["dropped area/topic#3 dropped", "edited Feat-1.2"]);
    const feat = (await h.task("Feat-1.2")).body.data;
    expect(feat.task).toMatchObject({ title: "Ship the search page with filters", version: 2, updatedAt: 2_000 });
    expect(feat.events[0]).toMatchObject({
      kind: "edited",
      payload: { fields: { description: { before: "Ship the search page", after: "Ship the search page with filters" } } },
    });
    expect((await h.task("free-1")).body.data.task.state).toBe("ready");
    expect((await h.task("area/topic#3")).body.data.events[0]).toMatchObject({ kind: "dropped", payload: { reason: "no longer in the tasks file" } });

    // Back in the file: reopened
    h.writeTasks(["worker-b|B|area/topic#3|Fix the topic list"]);
    const back = await h.importFiles(false);
    expect(back.body.data.changes).toEqual(expect.arrayContaining([{ task: "area/topic#3", kind: "reopened", from: "dropped", to: "ready" }]));
  });

  it("drops nothing when the tasks file can't be read", async () => {
    const h = await rig({ tasks: TASKS });
    await h.importFiles(false);
    unlinkSync(h.tasksFile);
    const refused = await h.importFiles(false);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("nothing is imported or dropped");
    expect((await h.get(`/api/work/status?project=${PROJECT}`)).body.data.store.counts).toEqual({ ready: 3, done: 1 });
  });

  it("runs one import of a project at a time", async () => {
    const h = await rig({ tasks: TASKS });
    const actor = { kind: "owner" as const, id: "s1" };
    const results = await Promise.all([h.manager.import(PROJECT, { dryRun: false, actor }), h.manager.import(PROJECT, { dryRun: false, actor })]);
    expect(results.map((r) => (r.ok ? 200 : r.code)).sort()).toEqual([200, 409]);
    expect((await h.importFiles(false)).body.data.changes).toEqual([]);
  });

  it("a blocked task blocked for another reason is an edit of the reason with a new version, never a silent write", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-block|Needs a key"], queue: ["- BLOCKED feat-block needs the signing key by worker-a"] });
    h.run({ id: "run-1", task: "feat-block", agent: "worker-a", state: "completed" });
    await h.importFiles(false);
    // The same run's later BLOCKED line is the reason now
    appendFileSync(h.queueFile, "- BLOCKED feat-block needs the release key by worker-a\n");
    const changed = await h.importFiles(false);
    expect(changed.body.data.changes).toEqual([
      { task: "feat-block", kind: "edited", fields: { blockedReason: { before: "- BLOCKED feat-block needs the signing key by worker-a", after: "- BLOCKED feat-block needs the release key by worker-a" } } },
    ]);
    const block = (await h.task("feat-block")).body.data;
    expect(block.task).toMatchObject({ state: "blocked", version: 2, blockedReason: "- BLOCKED feat-block needs the release key by worker-a" });
    expect(block.events[0]).toMatchObject({ kind: "edited" });
  });

  it("keeps the stored state of a task a run holds: the files say nothing new while it works", async () => {
    const h = await rig({ tasks: ["worker-b|B|feat-wait|Waits on a gate"], queue: ["- WAITING feat-wait gate-12 by worker-b"] });
    h.run({ id: "run-1", task: "feat-wait", agent: "worker-b", state: "completed" });
    await h.importFiles(false);
    expect((await h.task("feat-wait")).body.data.task.state).toBe("waiting");
    // A new run holds it: its WAITING line is the old run's, so the import neither keeps nor clears it: the store does
    h.setNow(2_000);
    h.run({ id: "run-2", task: "feat-wait", agent: "worker-b", state: "running" });
    expect(h.agents.claim(PROJECT, "feat-wait", "run-2", "worker-b", { pid: 4242, startedAt: 1 }, 2_000, () => true).ok).toBe(true);
    expect((await h.importFiles(false)).body.data).toMatchObject({ changes: [], unchanged: 1 });
    expect((await h.task("feat-wait")).body.data.task).toMatchObject({ state: "waiting", version: 1 });
  });
});

describe("work store: its own file, versioned", () => {
  const snapshot = { tasks: [{ id: "feat-1", agent: "worker-a", agentName: "A", description: "Ship it", state: "ready" as const, line: 1, reason: null }], kept: new Set<string>(), tasksFileHash: "h", warnings: 0 };

  it("reopens a file it wrote with its tasks; refuses a newer schema, another store's file and a set user_version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-work-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "nested", "shop.db");
    const store = await SqliteWorkStore.open(PROJECT, path);
    await store.syncFromFiles(snapshot, { dryRun: false, actor: { kind: "owner", id: "s1" }, at: 5 });
    store.close();
    const reopened = await SqliteWorkStore.open(PROJECT, path);
    expect(await reopened.getTask("feat-1")).toMatchObject({ title: "Ship it", state: "ready", source: { kind: "import", ref: "tasks_file:1" } });
    reopened.close();

    const raw = new Database(path);
    raw.prepare(`UPDATE work_schema SET version = 99`).run();
    raw.close();
    await expect(SqliteWorkStore.open(PROJECT, path)).rejects.toThrow("written by a newer Lair (schema 99, this one knows 2)");

    const other = join(dir, "bus.db");
    const bus = new Database(other);
    bus.exec(`CREATE TABLE bus_schema (version INTEGER PRIMARY KEY)`);
    bus.close();
    await expect(SqliteWorkStore.open(PROJECT, other)).rejects.toThrow("belongs to another store");

    const versioned = join(dir, "versioned.db");
    const v = new Database(versioned);
    v.pragma("user_version = 5");
    v.close();
    await expect(SqliteWorkStore.open(PROJECT, versioned)).rejects.toThrow("belongs to another store (user_version 5)");
  });

  it("opens a file written at schema 1 and brings it to 2: tasks and imports kept, adopted, no cursor yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-work-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "shop.db");
    // Schema 1 exactly as work store 1 wrote it (its migration 1, then one applied import)
    const v1 = new Database(path);
    v1.exec(`CREATE TABLE work_schema (version INTEGER NOT NULL);
      CREATE TABLE work_tasks (
        project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL, agent TEXT, agent_name TEXT, priority INTEGER NOT NULL DEFAULT 500,
        source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, blocked_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project, id));
      CREATE INDEX work_tasks_state ON work_tasks(project, state, priority);
      CREATE INDEX work_tasks_agent ON work_tasks(project, agent) WHERE agent IS NOT NULL;
      CREATE TABLE work_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, actor_run_id TEXT, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX work_events_task ON work_events(project, task_id, id);
      CREATE TABLE work_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at INTEGER NOT NULL, actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL, tasks_file_hash TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        dropped INTEGER NOT NULL, warnings INTEGER NOT NULL);
      INSERT INTO work_schema (version) VALUES (1);
      INSERT INTO work_tasks (project, id, title, description, state, agent, agent_name, priority, source_kind, source_ref, created_at, updated_at)
        VALUES ('shop', 'feat-1', 'Ship it', 'Ship it', 'waiting', 'worker-a', 'A', 1, 'import', 'tasks_file:1', 5, 5);
      INSERT INTO work_imports (project, at, actor_kind, actor_id, tasks_file_hash, created, updated, dropped, warnings)
        VALUES ('shop', 5, 'owner', 's1', 'h', 1, 0, 0, 0);`);
    v1.close();
    const store = await SqliteWorkStore.open(PROJECT, path);
    expect(store.schemaVersion).toBe(2);
    expect(await store.getTask("feat-1")).toMatchObject({ state: "waiting", version: 1 });
    // Adopted under work store 1: the consumer starts each source at its end when it first runs (no history replay)
    expect(await store.adopted()).toBe(true);
    expect(await store.cursors()).toEqual({});
    store.close();
    const raw = new Database(path);
    expect(raw.prepare(`SELECT version FROM work_schema`).all()).toEqual([{ version: 2 }]);
    raw.close();
  });

  it("refuses a file whose schema table is empty, with the reason, and changes nothing in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-work-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "shop.db");
    const raw = new Database(path);
    raw.exec(`CREATE TABLE work_schema (version INTEGER NOT NULL)`);
    raw.close();
    await expect(SqliteWorkStore.open(PROJECT, path)).rejects.toThrow("the work store's schema table is empty");
    const after = new Database(path);
    expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([{ name: "work_schema" }]);
    after.close();
  });

  it("follows only what an import made: a task the planner or the owner made is never edited, moved or dropped by the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-work-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "shop.db");
    const store = await SqliteWorkStore.open(PROJECT, path);
    store.close();
    // Two tasks a later producer (the planner, work store 4) made, one of them also in the tasks file
    const raw = new Database(path);
    for (const id of ["feat-1", "plan-2"]) {
      raw.prepare(`INSERT INTO work_tasks (project, id, title, description, state, agent, agent_name, priority, source_kind, source_ref, created_at, updated_at)
        VALUES ('shop', ?, ?, ?, 'ready', 'worker-a', 'A', 1, 'planner', 'plan:1', 5, 5)`).run(id, id, id);
    }
    raw.close();
    const reopened = await SqliteWorkStore.open(PROJECT, path);
    const files = { ...snapshot, tasks: [{ ...snapshot.tasks[0], description: "Reworded in the file", state: "blocked" as const, reason: "a line" }] };
    const synced = await reopened.syncFromFiles(files, { dryRun: false, actor: { kind: "owner", id: "s1" }, at: 9 });
    expect(synced).toEqual({ changes: [], unchanged: 0, skipped: ["feat-1: made by the planner, so the files do not change it"] });
    expect(await reopened.getTask("feat-1")).toMatchObject({ description: "feat-1", state: "ready", version: 1 });
    // plan-2 is not in the file: not dropped (only what an import made is)
    expect(await reopened.getTask("plan-2")).toMatchObject({ state: "ready", version: 1 });
    reopened.close();
  });

  it("applies facts only with the cursor they were read at: a cursor another drain moved applies nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-work-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = await SqliteWorkStore.open(PROJECT, join(dir, "shop.db"));
    cleanups.push(() => store.close());
    await store.syncFromFiles(snapshot, { dryRun: false, actor: { kind: "owner", id: "s1" }, at: 5, cursors: { "bus.report": 3 } });
    const fact = { source: "bus.report" as const, id: 4, at: 6, task: "feat-1", agent: "worker-a", runId: "r1", kind: "WAITING" as const, summary: "gate", gateId: "g-1", pr: null, sha: null, accepted: false };
    // Read at 2, but the cursor is at 3: refused whole
    expect(await store.applyFacts([fact], [{ source: "bus.report", from: 2, to: 4 }], 7)).toEqual({ moved: false, applied: 0, skipped: 0 });
    expect(await store.getTask("feat-1")).toMatchObject({ state: "ready", version: 1 });
    expect(await store.cursors()).toEqual({ "bus.report": 3 });
    // Read at 3: applied once, with the cursor
    expect(await store.applyFacts([fact], [{ source: "bus.report", from: 3, to: 4 }], 7)).toEqual({ moved: true, applied: 1, skipped: 0 });
    expect(await store.applyFacts([fact], [{ source: "bus.report", from: 3, to: 4 }], 7)).toMatchObject({ moved: false });
    expect(await store.getTask("feat-1")).toMatchObject({ state: "waiting", version: 2 });
    expect((await store.timeline("feat-1", 10)).map((e) => e.kind)).toEqual(["state_changed", "report", "created"]);
  });

  it("shows a store that can't be opened in the status and refuses the import, for that project only", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"] });
    const path = join(h.dataDir, "work", `${PROJECT}.db`);
    mkdirSync(join(h.dataDir, "work"), { recursive: true });
    const foreign = new Database(path);
    foreign.pragma("user_version = 3");
    foreign.close();
    const status = (await h.get(`/api/work/status?project=${PROJECT}`)).body.data;
    expect(status.store).toBeNull();
    expect(status.problems[0]).toContain("can't be opened: this database belongs to another store");
    expect((await h.importFiles(false)).status).toBe(500);
  });
});

/** Polls until `check` holds, for at most 5 s */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("waited 5 s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A line of fill's view as AgentsFill.view() returns it (src/shared/agents-types.ts) */
const fillLine = (task: string, state: FillLineView["state"], hold: FillLineView["hold"] = null): FillLineView => ({
  line: 1, agent: "worker-a", name: "A", task, description: task, state, detail: "", hold, releasable: false, waiting: null, runId: null, decisionId: null,
});
const fillView = (lines: FillLineView[]): FillStatusView => ({
  enabled: true, running: true, tasksFile: null, agents: ["worker-a", "worker-b"], maxActive: 2, active: 0, intervalSeconds: 60,
  lastCheck: "2026-01-01T00:00:00.000Z", lastError: null, lines, unmatchedReports: [], warnings: [],
});
const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe("work store 2: it follows by itself once the owner applied an import", () => {
  it("follows nothing before the owner's first applied import; a dry run adopts nothing; the apply starts the cursors", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"] });
    h.manager.start();
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ waiting: true, checks: 0, reads: 0 });
    expect((await h.importFiles(true)).status).toBe(200);
    // A run's end before the apply: the files the import reads cover it, so it is not replayed after
    h.run({ id: "run-0", task: "feat-1", agent: "worker-a", state: "completed" });
    await h.fact("completed", "run-0");
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ waiting: true, reads: 0 });
    expect(await h.tasks()).toEqual([]);

    await h.importFiles(false);
    expect((await h.status()).store).toMatchObject({ adopted: true, cursors: { "bus.report": 0, "agents.event": 1 } });
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ waiting: false, checks: 1, reads: 1, applied: 0, skipped: 0, failures: 0 });
    expect(kinds((await h.task("feat-1")).body.data.events)).toEqual(["created"]);
  });

  it("applies a bus report once, across a restart between the bus write and the store write", async () => {
    const h = await rig({ tasks: ["worker-b|B|feat-wait|Waits on a gate"] });
    h.run({ id: "run-1", task: "feat-wait", agent: "worker-b", state: "running" });
    expect(h.agents.claim(PROJECT, "feat-wait", "run-1", "worker-b", { pid: 4242, startedAt: 1 }, 1_000, () => true).ok).toBe(true);
    await h.importFiles(false);
    h.manager.start();
    await h.manager.settled();
    // The server stops after the bus stored the report and mirrored its line, before the work store applied it
    await h.manager.stop();
    const id = await h.report("run-1", "WAITING", "waits on the gate", { gateId: "gate-12" });
    expect(readFileSync(h.queueFile, "utf-8")).toContain(`[bus:${id}]`);

    // The next start replays it from the cursor
    const next = h.restart();
    next.start();
    await next.settled();
    const after = await next.task(PROJECT, "feat-wait");
    if (!after.ok) throw new Error(after.error);
    expect(after.data.task).toMatchObject({ state: "waiting", version: 2 });
    expect(kinds(after.data.events)).toEqual(["state_changed", "report", "created"]);
    expect(after.data.events[1]).toMatchObject({ actor: { kind: "agent", id: "worker-b", runId: "run-1" }, payload: { busId: id, kind: "WAITING", gateId: "gate-12" } });
    expect((await next.status(PROJECT)).store?.cursors).toMatchObject({ "bus.report": id });
    await next.stop();

    // Once: another start applies nothing again (and its follower, reading the mirrored line, keeps the state)
    const third = h.restart();
    third.start();
    await third.settled();
    const again = await third.task(PROJECT, "feat-wait");
    if (!again.ok) throw new Error(again.error);
    expect(again.data.task).toMatchObject({ state: "waiting", version: 2 });
    expect(kinds(again.data.events)).toEqual(["state_changed", "report", "created"]);
  });

  it("applies a live report at once: BLOCKED with its summary as the reason, PROGRESS recorded only, an unknown task skipped", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Needs a key"] });
    h.run({ id: "run-1", task: "feat-1", agent: "worker-a", state: "running" });
    h.run({ id: "run-x", task: "other-1", agent: "worker-b", state: "running" });
    await h.importFiles(false);
    h.manager.start();
    await h.manager.settled();
    await h.report("run-1", "PROGRESS", "half way");
    await h.manager.settled();
    expect((await h.task("feat-1")).body.data.task).toMatchObject({ state: "ready", version: 1 });
    await h.report("run-1", "BLOCKED", "needs the signing key");
    await h.report("run-x", "WAITING", "a task the store does not have");
    await h.manager.settled();
    const t = (await h.task("feat-1")).body.data;
    expect(t.task).toMatchObject({ state: "blocked", blockedReason: "needs the signing key", version: 2 });
    expect(kinds(t.events)).toEqual(["state_changed", "report", "report", "created"]);
    expect(t.events[0]).toMatchObject({ actor: { kind: "agent", id: "worker-a" }, payload: { from: "ready", to: "blocked", reason: "needs the signing key" } });
    expect((await h.status()).follow).toMatchObject({ applied: 2, skipped: 1, failures: 0 });
    expect(h.warnings).toEqual([]);
  });

  it("a DONE report the ready guard refuses is recorded and changes nothing; one it accepts closes the task", async () => {
    const h = await rig({
      tasks: ["worker-a|A|feat-guard|Its PR is not ready", "worker-b|B|feat-ok|Ships"],
      // Fill's ready guard (a stand-in): it refuses feat-guard's DONE
      accepted: (task) => task !== "feat-guard",
    });
    h.run({ id: "run-g", task: "feat-guard", agent: "worker-a", state: "running" });
    h.run({ id: "run-o", task: "feat-ok", agent: "worker-b", state: "running" });
    await h.importFiles(false);
    h.manager.start();
    await h.manager.settled();
    await h.report("run-g", "DONE", "opened the PR", { pr: 12, sha: "abc123" });
    await h.report("run-o", "DONE", "shipped", { pr: 13, sha: "def456" });
    await h.manager.settled();
    const guard = (await h.task("feat-guard")).body.data;
    expect(guard.task).toMatchObject({ state: "ready", version: 1 });
    expect(guard.events[0]).toMatchObject({ kind: "report", payload: { kind: "DONE", pr: 12, sha: "abc123", refused: "fill's ready guard does not accept it now" } });
    const ok = (await h.task("feat-ok")).body.data;
    expect(ok.task).toMatchObject({ state: "done", version: 2 });
    expect(kinds(ok.events)).toEqual(["state_changed", "report", "created"]);
  });

  it("a run that starts on a waiting task shows it running again; a replayed start of a run that ended moves nothing", async () => {
    const h = await rig({
      tasks: ["worker-b|B|feat-wait|Waits on a gate", "worker-a|A|feat-old|Waits too"],
      queue: ["- WAITING feat-wait gate-12 by worker-b", "- WAITING feat-old gate-13 by worker-a"],
    });
    h.run({ id: "run-1", task: "feat-wait", agent: "worker-b", state: "completed" });
    h.run({ id: "run-old", task: "feat-old", agent: "worker-a", state: "completed" });
    await h.importFiles(false);
    h.manager.start();
    await h.manager.settled();
    h.setNow(2_000);
    h.run({ id: "run-2", task: "feat-wait", agent: "worker-b", state: "running" });
    expect(h.agents.claim(PROJECT, "feat-wait", "run-2", "worker-b", { pid: 4242, startedAt: 1 }, 2_000, () => true).ok).toBe(true);
    await h.fact("started", "run-2");
    // run-old's start recorded late, after it ended: it moves nothing
    await h.fact("started", "run-old");
    await h.manager.settled();
    const wait = (await h.task("feat-wait")).body.data;
    expect(wait.task).toMatchObject({ state: "ready", derived: "running", holder: { runId: "run-2" }, version: 2 });
    expect(kinds(wait.events)).toEqual(["state_changed", "started", "created"]);
    expect(wait.events[1]).toMatchObject({ actor: { kind: "module", id: "agents", runId: "run-2" } });
    const old = (await h.task("feat-old")).body.data;
    expect(old.task).toMatchObject({ state: "waiting", version: 1 });
    expect(kinds(old.events)).toEqual(["started", "created"]);
    // The run's end and its claim's release are recorded; they move nothing
    await h.fact("completed", "run-2");
    await h.fact("claim_released", "run-2");
    await h.manager.settled();
    expect(kinds((await h.task("feat-wait")).body.data.events).slice(0, 2)).toEqual(["claim_released", "ended"]);
    expect((await h.task("feat-wait")).body.data.task).toMatchObject({ state: "ready", version: 2 });
  });

  it("reads the files only when they changed: an unchanged file costs a stat, a hand-written line is followed", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"] });
    await h.importFiles(false);
    h.manager.start();
    await h.manager.settled();
    await h.manager.followNow();
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ checks: 3, reads: 1 });
    // A DONE written by hand (no bus): the queue file changed, so the follower reads the files again
    appendFileSync(h.queueFile, "- DONE feat-1 by worker-a\n");
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ checks: 4, reads: 2 });
    const t = (await h.task("feat-1")).body.data;
    expect(t.task.state).toBe("done");
    expect(t.events[0]).toMatchObject({ kind: "state_changed", actor: { kind: "module", id: "follower" } });
    expect((await h.status()).store?.lastImport).toMatchObject({ actor: { kind: "module", id: "follower" }, updated: 1 });
  });

  it("follows on its timer", async () => {
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"], followIntervalMs: 20 });
    await h.importFiles(false);
    h.manager.start();
    appendFileSync(h.queueFile, "- DONE feat-1 by worker-a\n");
    await waitFor(async () => (await h.task("feat-1")).body.data.task.state === "done");
  });

  it("a follow step that times out is a failure with a backoff, and the step in flight ends before another starts", async () => {
    let release!: (ok: boolean) => void;
    const guard = new Promise<boolean>((resolve) => (release = resolve));
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"], accepted: () => guard, followTimeoutMs: 50 });
    await h.importFiles(false);
    appendFileSync(h.queueFile, "- DONE feat-1 PR #12 by worker-a\n");
    // The first step reads the files, and the ready guard holds its import
    h.manager.start();
    await waitFor(async () => (await h.status()).follow?.failures === 1);
    const failed = (await h.status()).follow!;
    expect(failed).toMatchObject({ checks: 1, reads: 1, lastError: "the follow step timed out after 0.05 s" });
    expect(failed.nextAt).not.toBeNull();
    expect(h.warnings[0]).toContain("the follow step timed out");
    // The import in flight still ends (and applies once)
    release(true);
    await h.manager.settled();
    expect((await h.task("feat-1")).body.data.task.state).toBe("done");
    // During the backoff no step starts; after it, a step that ends in time clears the failure
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ checks: 1, failures: 1 });
    h.setNow(10 * 3_600_000);
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ checks: 2, reads: 1, failures: 0, lastError: null, nextAt: null });
  });

  it("a live reload of the blocks an import reads does not restart a follow step in flight", async () => {
    let release!: (ok: boolean) => void;
    const guard = new Promise<boolean>((resolve) => (release = resolve));
    const h = await rig({ tasks: ["worker-a|A|feat-1|Ship it"], accepted: () => guard });
    await h.importFiles(false);
    appendFileSync(h.queueFile, "- DONE feat-1 PR #12 by worker-a\n");
    h.manager.start();
    await waitFor(async () => (await h.status()).follow?.reads === 1);
    // The reloader re-applies the module for an agents change while the follower's import waits on the guard
    const module = serverModules({ work: h.manager }).find((m) => m.name === "work_store")!;
    const agents = { enabled: false, fill: { enabled: false, tasks_file: "tasks.txt", agents: ["worker-a", "worker-b", "worker-c"] } };
    await module.reload({ name: PROJECT, config: { ...h.config, agents } as unknown as ProjectConfig });
    release(true);
    await h.manager.settled();
    expect((await h.status()).follow).toMatchObject({ checks: 1, reads: 1, failures: 0 });
    expect((await h.status()).store?.lastImport).toMatchObject({ actor: { kind: "module", id: "follower" }, updated: 1 });
    expect((await h.task("feat-1")).body.data.task.state).toBe("done");
    // Nothing was left to read again
    await h.manager.followNow();
    expect((await h.status()).follow).toMatchObject({ checks: 2, reads: 1 });
  });

  it("compares the store with fill's view at its last check, names the tasks they disagree on, and leaves fill's holds out", async () => {
    let view: FillStatusView | null = null;
    const h = await rig({
      tasks: ["worker-a|A|feat-done|Done", "worker-b|B|feat-wait|Waits", "worker-a|A|feat-run|Runs", "worker-b|B|feat-paused|Paused", "worker-a|A|feat-gone|Store only"],
      queue: ["- DONE feat-done by worker-a", "- WAITING feat-wait gate-12 by worker-b"],
      // Fill's view at its last check (a stand-in)
      fill: () => view,
    });
    h.run({ id: "run-w", task: "feat-wait", agent: "worker-b", state: "completed" });
    await h.importFiles(false);
    // Fill has not checked yet: nothing to compare with
    expect((await h.status()).comparison).toBeNull();
    view = fillView([
      fillLine("feat-done", "done"),
      fillLine("feat-wait", "held", "waiting"),
      // Fill started it, but the store sees no run or claim
      fillLine("feat-run", "started"),
      // Fill's own hold: not a stored state, not compared
      fillLine("feat-paused", "held", "paused"),
      fillLine("feat-new", "started"),
    ]);
    const comparison = (await h.status()).comparison!;
    expect(comparison).toMatchObject({ fillCheckedAt: "2026-01-01T00:00:00.000Z", agree: 2, ignored: 1, disagreeCount: 3 });
    expect(comparison.disagree).toEqual([
      { task: "feat-run", fill: "started", store: "ready" },
      { task: "feat-new", fill: "started", store: "not in the store" },
      { task: "feat-gone", fill: "no line", store: "ready" },
    ]);
    // A run holding it makes them agree
    h.run({ id: "run-r", task: "feat-run", agent: "worker-a", state: "running" });
    expect((await h.status()).comparison).toMatchObject({ agree: 3, disagreeCount: 2 });
  });
});
