/**
 * The owner-only writes of the route modules that predate the owner
 * credential: controls (commands, dragon start and stop), bus messages,
 * processes, settings, scheduler and tasks, fleet. Each is mounted as
 * src/server/index.ts mounts it, with a real HumanAuth. Per group: a request
 * without the owner's session gets 403 and changes nothing; the owner gets
 * through, with the dashboard's own client helper (src/client/owner-actions.ts)
 * where a view sends the request. Reads stay open.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { getBusStore, closeBusStores } from "../bus/store.js";
import { getStore, closeStore } from "../store/store.js";
import { getScheduler, stopScheduler } from "../scheduler/scheduler.js";
import { getBudgetManager, resetBudgetManager } from "../fleet/budget.js";
import { getSupervisor } from "../services/supervisor.js";
import { registerControlRoutes } from "./controls.js";
import { registerBusRoutes, type BusRoutesOptions } from "./bus.js";
import { registerProcessRoutes } from "./processes.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerSchedulerRoutes } from "./scheduler.js";
import { registerFleetRoutes } from "./fleet.js";
import { signIn } from "../../client/owner-session";
import { processAction, runCommand, sendBusMessage, startDragon } from "../../client/owner-actions";
import { loadProjectConfig } from "../config.js";
import type { AgentsManager } from "../agents/index.js";

const DATA = join(process.cwd(), "data");
const TMP = join(DATA, "test-owner-routes");
const LOCAL_DIR = join(process.cwd(), "projects", "local");
const PROJECT = "lair-owner-routes-test";
const PROJECT_FILE = join(LOCAL_DIR, `${PROJECT}.yaml`);
const AGENT_RUN_FILE = join(TMP, "agent-run.txt");
/** The dashboard in a browser, as requests carry it (no session yet) */
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

let app: FastifyInstance;
let ownerToken = "";
let ownerSession = "";
let createdLocalDir = false;

function owner(): Record<string, string> {
  return { ...BROWSER, [OWNER_SESSION_HEADER]: ownerSession };
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(LOCAL_DIR)) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    createdLocalDir = true;
  }
  const q = JSON.stringify;
  writeFileSync(
    PROJECT_FILE,
    [
      `name: ${PROJECT}`,
      `repo: ${q(TMP)}`,
      "github: example/owner-routes",
      `queue_file: ${q(join(TMP, "queue.md"))}`,
      `agents_dir: ${q(TMP)}`,
      `gates_dir: ${q(TMP)}`,
      `inbox_file: ${q(join(TMP, "inbox.md"))}`,
      `outbox_file: ${q(join(TMP, "outbox.md"))}`,
      `prompts_dir: ${q(join(TMP, "prompts"))}`,
      "read_only: false",
      "machines: {}",
      "dragons:",
      "  alpha:",
      "    name: Alpha",
      'dragon_start_cmd: ["true", "{dragon}", "{prompt_file}"]',
      'dragon_stop_cmd: ["true", "{dragon}"]',
      // A command whose effect a test can see: it writes the task to a file
      `agent_run_cmd: [${q(process.execPath)}, "-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", ${q(AGENT_RUN_FILE)}, "{task}"]`,
      "",
    ].join("\n"),
  );
  // The scheduler reads the global store: keep it in memory, out of data/lair.db
  getStore({ dbPath: ":memory:" });

  // Mock agents manager for bus routes
  const mockAgentsManager = (): AgentsManager => ({
    get: () => null,
    getStore: () => null,
  } as unknown as AgentsManager);

  const busOptions: BusRoutesOptions = {
    agents: mockAgentsManager(),
    dataDir: TMP,
    getConfig: (project: string) => {
      const config = loadProjectConfig(project);
      return { ...config, mail_dir: undefined, wake_file: undefined };
    },
    // The bus is on (busMode) for every project here: the routes' owner checks are what is tested
    mode: () => busMode,
    enabled: () => [],
    health: () => ({ mode: "on", received: 0, refused: [], refusedCount: 0, observations: { total: 0, matches: 0, mismatches: 0, recent: [] } }),
  };

  app = Fastify({ logger: false });
  // The owner's credential, as src/server/index.ts wires it; app.close() closes it
  const tokenPath = join(TMP, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  await registerControlRoutes(app, auth);
  await registerBusRoutes(app, auth, busOptions);
  await registerProcessRoutes(app, auth);
  await registerSettingsRoutes(app, auth);
  await registerSchedulerRoutes(app, auth);
  await registerFleetRoutes(app, auth);
  await app.ready();
  ownerToken = readFileSync(tokenPath, "utf-8").trim();
  ownerSession = auth.createSession(ownerToken)!.session;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  stopScheduler();
  closeStore();
  closeBusStores();
  resetBudgetManager();
  rmSync(PROJECT_FILE, { force: true });
  for (const file of existsSync(LOCAL_DIR) ? readdirSync(LOCAL_DIR) : []) {
    if (file.startsWith(`${PROJECT}.yaml.backup-`)) rmSync(join(LOCAL_DIR, file), { force: true });
  }
  rmSync(TMP, { recursive: true, force: true });
  rmSync(join(DATA, `${PROJECT}.db`), { force: true });
  if (createdLocalDir && readdirSync(LOCAL_DIR).length === 0) {
    rmSync(LOCAL_DIR, { recursive: true, force: true });
  }
});

/** Route the client helpers' fetch to the app, as the dashboard's same-origin page sends it. */
function browser(): void {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: input,
      headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER },
      payload: typeof init.body === "string" ? init.body : undefined,
    });
    return { status: res.statusCode, json: async () => res.json() };
  });
}

function post(url: string, payload?: Record<string, unknown>, headers: Record<string, string> = BROWSER) {
  return app.inject({
    method: "POST",
    url,
    headers: payload === undefined ? headers : { ...headers, "content-type": "application/json" },
    payload,
  });
}

function expectRefused(res: { statusCode: number; json: () => { error?: string } }): void {
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toContain("Only the owner can do this");
}

const p = `?project=${PROJECT}`;
/** The project's bus.consume as the bus routes see it */
let busMode: "off" | "observe" | "on" = "on";

describe("controls: commands and dragon start/stop", () => {
  it("refuses every command without the owner's session, and changes nothing", async () => {
    for (const [route, body] of [
      ["ask", { text: "status?" }],
      ["instruct", { text: "do it" }],
      ["tick", undefined],
      ["pause", undefined],
      ["resume", undefined],
      ["agent/run", { task: "refused" }],
      ["agent/stop", { agentId: "alpha" }],
      ["agent/release", { agentId: "alpha" }],
      ["gate/submit", { track: "feat/example" }],
      ["gate/stuck", { gateId: "20260101T000000Z-example-abcdef12-1" }],
      ["merge", { prNumber: 1, headSha: "a".repeat(40) }],
      ["dragon/start", { dragonId: "alpha", task: "refused", prompt: "p" }],
      ["dragon/stop", { dragonId: "alpha" }],
    ] as const) {
      expectRefused(await post(`/api/controls/${route}${p}`, body));
    }
    expect(existsSync(AGENT_RUN_FILE)).toBe(false);
    expect(existsSync(join(TMP, "inbox.md"))).toBe(false);
    expect(existsSync(join(TMP, "prompts", "refused-alpha.txt"))).toBe(false);
    // Reads stay open
    expect((await app.inject({ url: `/api/controls/status${p}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/controls/dragon/config${p}` })).statusCode).toBe(200);
  });

  it("lets the owner start a dragon and run a task through the dashboard's helpers", async () => {
    browser();
    const before = await startDragon(PROJECT, { dragonId: "alpha", task: "first", prompt: "go" });
    expect(before).toMatchObject({ success: false, error: expect.stringContaining("not signed in as the owner") });

    await signIn(ownerToken);
    const started = await startDragon(PROJECT, { dragonId: "alpha", task: "owner task", prompt: "go" });
    expect(started).toMatchObject({ success: true, data: { exitCode: 0 } });
    expect(readFileSync(join(TMP, "prompts", "owner-task-alpha.txt"), "utf-8")).toBe("go");

    const ran = await runCommand(PROJECT, "agent/run", { task: "nightly cleanup" });
    expect(ran).toMatchObject({ success: true, data: { exitCode: 0 } });
    expect(readFileSync(AGENT_RUN_FILE, "utf-8")).toBe("nightly cleanup");
  });
});

describe("bus: messages sent as the owner", () => {
  function unread(agent: string) {
    // Read from the server-owned bus store
    const store = getBusStore(PROJECT, TMP);
    const now = Date.now();
    return store.getUnreadMessages(agent, now).map((m) => ({
      from_id: m.fromId,
      to_id: m.toId,
      text: m.text,
    }));
  }

  it("refuses a message without the owner's session, and sends nothing", async () => {
    expectRefused(await post(`/api/bus/send${p}`, { to: "orchestrator", text: "refused" }));
    expect(unread("orchestrator")).toEqual([]);
    expect((await app.inject({ url: `/api/bus/board${p}` })).statusCode).toBe(200);
  });

  it("delivers the owner's message from the command bar's helper", async () => {
    browser();
    await signIn(ownerToken);
    const sent = await sendBusMessage(PROJECT, "worker-a", "rebase on main");
    expect(sent).toMatchObject({ success: true, data: { to: "worker-a" } });
    expect(unread("worker-a")).toMatchObject([{ from_id: "owner", to_id: "worker-a", text: "rebase on main" }]);
  });

  it("answers 404 for a project whose bus.consume is off, as without the bus, the consumers' status excepted", async () => {
    busMode = "off";
    try {
      for (const url of [`/api/bus/board${p}`, `/api/bus/messages/worker-a${p}`]) {
        const res = await app.inject({ url });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe(`the bus is off for ${PROJECT}: set bus.consume to observe or on (docs/configuration.md#fleet-bus)`);
      }
      expect((await post(`/api/bus/send${p}`, { to: "worker-a", text: "not sent" }, owner())).statusCode).toBe(404);
      expect(unread("worker-a").map((m) => m.text)).not.toContain("not sent");
      expect((await app.inject({ url: `/api/bus/consumers${p}` })).statusCode).toBe(200);
    } finally {
      busMode = "on";
    }
  });
});

describe("processes: start, stop and restart", () => {
  function supervisorSpies() {
    const supervisor = getSupervisor();
    vi.spyOn(supervisor, "has").mockReturnValue(true);
    vi.spyOn(supervisor, "isReadOnly").mockReturnValue(false);
    vi.spyOn(supervisor, "get").mockReturnValue(null);
    return {
      start: vi.spyOn(supervisor, "start").mockResolvedValue(undefined),
      stop: vi.spyOn(supervisor, "stop").mockResolvedValue(undefined),
      restart: vi.spyOn(supervisor, "restart").mockResolvedValue(undefined),
    };
  }

  it("refuses each action without the owner's session, before the supervisor is asked", async () => {
    const spies = supervisorSpies();
    for (const action of ["start", "stop", "restart"] as const) {
      expectRefused(await post(`/api/processes/api-server/${action}${p}`));
    }
    expect(spies.start).not.toHaveBeenCalled();
    expect(spies.stop).not.toHaveBeenCalled();
    expect(spies.restart).not.toHaveBeenCalled();
    expect((await app.inject({ url: `/api/processes${p}` })).statusCode).toBe(200);
  });

  it("starts and restarts a process for the owner through the Processes view's helper", async () => {
    const spies = supervisorSpies();
    browser();
    await signIn(ownerToken);
    await processAction(PROJECT, "api-server", "start");
    await processAction(PROJECT, "api-server", "restart");
    expect(spies.start).toHaveBeenCalledWith("api-server");
    expect(spies.restart).toHaveBeenCalledWith("api-server");
  });
});

describe("settings: machine tests", () => {
  it("refuses a machine test without the owner's session", async () => {
    expectRefused(await post(`/api/settings/test-machine${p}`, { machineId: "local" }));
  });

  it("tests a machine for the owner", async () => {
    const res = await post(`/api/settings/test-machine${p}`, { machineId: "local" }, owner());
    expect(res.statusCode).toBe(200);
    // This project has no machines
    expect(res.json()).toMatchObject({ success: false, error: "Machine not found: local" });
  });

  it("no longer serves the open read or the unvalidated rewrite of the old Settings view", async () => {
    // Reading and saving moved to src/server/settings/ (owner only, validated: settings.test.ts)
    const yaml = readFileSync(PROJECT_FILE, "utf-8");
    expect((await app.inject({ url: `/api/settings${p}` })).statusCode).toBe(404);
    expect((await post(`/api/settings${p}`, { read_only: true }, owner())).statusCode).toBe(404);
    expect(readFileSync(PROJECT_FILE, "utf-8")).toBe(yaml);
    expect(readdirSync(LOCAL_DIR).filter((f) => f.startsWith(`${PROJECT}.yaml.backup-`))).toEqual([]);
  });
});

describe("scheduler and tasks", () => {
  it("refuses scheduler controls and task changes without the owner's session", async () => {
    for (const url of ["/api/scheduler/start", "/api/scheduler/stop", "/api/scheduler/tick", "/api/tasks/t-1/cancel", "/api/tasks/t-1/retry"]) {
      expectRefused(await post(url));
    }
    expectRefused(await post("/api/tasks", { type: "custom", title: "Refused" }));
    expect(getScheduler().getState().running).toBe(false);
    expect(getStore().listTasks()).toEqual([]);
    expect((await app.inject({ url: "/api/scheduler/status" })).statusCode).toBe(200);
  });

  it("lets the owner create a task and stop the scheduler (no view sends these; the owner's browser can)", async () => {
    const created = await post("/api/tasks", { type: "custom", title: "Owner task" }, owner());
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ success: true, data: { title: "Owner task" } });
    expect(getStore().listTasks().map((t) => t.title)).toEqual(["Owner task"]);
    const stopped = await post("/api/scheduler/stop", undefined, owner());
    expect(stopped.json()).toMatchObject({ success: true, data: { stopped: true } });
  });
});

describe("fleet: machines, healing and budgets", () => {
  it("refuses every fleet change without the owner's session, and changes no budget", async () => {
    const budget = JSON.stringify(getBudgetManager().getConfig());
    expectRefused(await post("/api/fleet/machines", { name: "build", host: "198.51.100.10", user: "deploy" }));
    expectRefused(await app.inject({ method: "DELETE", url: "/api/fleet/machines/build", headers: BROWSER }));
    expectRefused(await post("/api/fleet/machines/build/test"));
    expectRefused(await post("/api/fleet/machines/build/install"));
    expectRefused(await app.inject({ method: "PATCH", url: "/api/fleet/healing/config", headers: BROWSER, payload: { enabled: false } }));
    expectRefused(await app.inject({ method: "PATCH", url: "/api/fleet/budget/config", headers: BROWSER, payload: { maxDailyCost: 1e9 } }));
    expectRefused(
      await app.inject({ method: "PUT", url: "/api/fleet/budget/providers", headers: BROWSER, payload: { provider: "example", dailyLimit: 1e9 } }),
    );
    expectRefused(await app.inject({ method: "DELETE", url: "/api/fleet/budget/providers/example", headers: BROWSER }));
    expectRefused(await post("/api/fleet/budget/providers/example/unpause"));
    expect(JSON.stringify(getBudgetManager().getConfig())).toBe(budget);
    expect((await app.inject({ url: "/api/fleet/budget" })).statusCode).toBe(200);
  });

  it("lets the owner change the budget (no view sends this; the owner's browser can)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/fleet/budget/config",
      headers: owner(),
      payload: { maxDailyCost: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(getBudgetManager().getConfig().maxDailyCost).toBe(42);
  });
});

/** localStorage for one origin (where the dashboard keeps its owner session). */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };
}
