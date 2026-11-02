/**
 * The work store through its real entry points: the owner-only routes on Fastify with a real owner session, the
 * manager as index.ts wires it, a real agents store (runs, claims) and real files on disk. Only fill's ready guard is
 * a stand-in (the `accepted` option), where a test says so.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../shared/types.js";
import { AgentsStore } from "../agents/store.js";
import type { AgentRun } from "../agents/types.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { serverModules } from "../reload/modules.js";
import { WorkStoreManager } from "./manager.js";
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
  accepted?: (task: string) => boolean;
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
  const warnings: string[] = [];
  let now = 1_000;
  const manager = new WorkStoreManager({
    dataDir,
    runs: () => agents,
    bus: () => null,
    accepted: o.accepted ? () => async (_agent, task) => o.accepted!(task) : undefined,
    now: () => now,
    log: { warn: (text: string) => warnings.push(text) },
  });
  manager.load([{ name: PROJECT, config }]);
  const app = Fastify();
  const auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  await registerWorkRoutes(app, manager, () => PROJECT, auth);
  await app.ready();
  const session = auth.createSession(readFileSync(join(dir, "owner.token"), "utf-8").trim());
  if (!session) throw new Error("no owner session");
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: session.session };
  cleanups.push(async () => {
    await manager.stop();
    await app.close();
    auth.close();
    agents.close();
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
  const run = (fields: Partial<AgentRun>) =>
    agents.insertRun({ project: PROJECT, chainId: `chain-${fields.id}`, requestedAt: now, queueMark: { offset: 0, tail: EMPTY_TAIL }, ...fields } as AgentRun);
  return {
    dir, config, manager, app, agents, owner, session, warnings, dataDir, tasksFile, queueFile,
    get, importFiles, task, tasks, run,
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
});

describe("work store: off by default", () => {
  it("keeps today's files exactly: no store file, every read and import 404, the status says off", async () => {
    const h = await rig({ workStore: undefined, tasks: ["worker-a|A|feat-1|Ship it"] });
    const status = await h.get(`/api/work/status?project=${PROJECT}`);
    expect(status.body.data).toMatchObject({ mode: "off", store: null, problems: [] });
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
    expect(h.manager.validate({ work_store: { mode: "observe", files: "mirror" } } as unknown as ProjectConfig)[0]).toContain("work_store.files is not a known key");
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
    expect((await h.get(`/api/work/status?project=${PROJECT}`)).body.data.store).toMatchObject({ schemaVersion: 1, counts: {}, lastImport: null });
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
    await expect(SqliteWorkStore.open(PROJECT, path)).rejects.toThrow("written by a newer Lair (schema 99, this one knows 1)");

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
