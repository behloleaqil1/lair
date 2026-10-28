/**
 * Security tests: `?project=` path traversal, dragonId validation (behind
 * the owner's session), the SSE CORS header and the removed budget-cost route.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { get as httpGet, type IncomingHttpHeaders } from "http";
import type { AddressInfo } from "net";
import {
  loadProjectConfig,
  getConfigPath,
  InvalidProjectError,
} from "../config.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerBusRoutes, type BusRoutesOptions } from "./bus.js";
import { registerControlRoutes, getPromptsDir } from "./controls.js";
import { registerFleetRoutes } from "./fleet.js";
import { registerProcessRoutes } from "./processes.js";
import { registerSchedulerRoutes } from "./scheduler.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentsManager } from "../agents/index.js";

const TMP = join(process.cwd(), "data", "test-project-guard");
const LOCAL_DIR = join(process.cwd(), "projects", "local");
const PROJECT = "lair-guard-test";
const PROJECT_FILE = join(LOCAL_DIR, `${PROJECT}.yaml`);

// A YAML file OUTSIDE projects/ that a traversal would load or overwrite
const OUTSIDE_FILE = join(TMP, "outside.yaml");
const OUTSIDE_YAML = [
  "name: outside",
  "repo: /nonexistent",
  "github: example/outside",
  "queue_file: /nonexistent/queue.md",
  "agents_dir: /nonexistent",
  "gates_dir: /nonexistent",
  "machines: {}",
  "",
].join("\n");
// From projects/local/ (checked first) this reaches data/test-project-guard/outside.yaml
const TRAVERSAL = "../../data/test-project-guard/outside";

let createdLocalDir = false;
// The owner's credential, as src/server/index.ts gives it to every route module
let auth: HumanAuth;
let ownerSession = "";

/** A browser on the dashboard signed in as the owner: the control POSTs need it */
function owner(): Record<string, string> {
  return { origin: "http://localhost:4777", "sec-fetch-site": "same-origin", [OWNER_SESSION_HEADER]: ownerSession };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  auth = HumanAuth.open({ tokenPath: join(TMP, "owner.token"), dbPath: ":memory:" });
  ownerSession = auth.createSession(readFileSync(join(TMP, "owner.token"), "utf-8").trim())!.session;
  if (!existsSync(LOCAL_DIR)) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    createdLocalDir = true;
  }
  writeFileSync(OUTSIDE_FILE, OUTSIDE_YAML);
  // A dragon that exists only in <agents_dir>/dragons.txt, not in the YAML map
  writeFileSync(join(TMP, "dragons.txt"), "bravo\tBravo\tunassigned\n");
  writeFileSync(
    PROJECT_FILE,
    [
      `name: ${PROJECT}`,
      `repo: ${JSON.stringify(TMP)}`,
      "github: example/guard-test",
      `queue_file: ${JSON.stringify(join(TMP, "queue.md"))}`,
      `agents_dir: ${JSON.stringify(TMP)}`,
      `gates_dir: ${JSON.stringify(TMP)}`,
      `prompts_dir: ${JSON.stringify(join(TMP, "prompts"))}`,
      "read_only: true",
      "machines: {}",
      "dragons:",
      "  alpha:",
      "    name: Alpha",
      'dragon_start_cmd: ["true", "{dragon}", "{prompt_file}"]',
      'dragon_stop_cmd: ["true", "{dragon}"]',
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  auth.close();
  rmSync(PROJECT_FILE, { force: true });
  rmSync(TMP, { recursive: true, force: true });
  rmSync(join(process.cwd(), "data", `${PROJECT}.db`), { force: true });
  if (createdLocalDir && readdirSync(LOCAL_DIR).length === 0) {
    rmSync(LOCAL_DIR, { recursive: true, force: true });
  }
});

// Mock agents manager for bus routes
function mockAgentsManager(): AgentsManager {
  return {
    get: () => null,
    getStore: () => null,
  } as unknown as AgentsManager;
}

// Mock bus options for tests
function mockBusOptions(): BusRoutesOptions {
  return {
    agents: mockAgentsManager(),
    dataDir: TMP,
    getConfig: (project: string) => {
      const config = loadProjectConfig(project);
      return { ...config, mail_dir: undefined, wake_file: undefined };
    },
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerControlRoutes(app, auth);
  await registerBusRoutes(app, auth, mockBusOptions());
  await registerSettingsRoutes(app, auth);
  await registerFleetRoutes(app, auth);
  await app.ready();
  return app;
}

describe("project name validation (config loader)", () => {
  it("loads a known project", () => {
    expect(loadProjectConfig(PROJECT).name).toBe(PROJECT);
  });

  it.each([TRAVERSAL, "../example", "/etc/passwd", ".hidden", "a/b", "no-such-project"])(
    "rejects %s",
    (name) => {
      expect(() => loadProjectConfig(name)).toThrow(InvalidProjectError);
      expect(() => getConfigPath(name)).toThrow(InvalidProjectError);
    },
  );
});

describe("project name validation (routes)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ["POST", "/api/settings/test-machine"],
    ["GET", "/api/controls/status"],
    ["GET", "/api/controls/inbox"],
    ["GET", "/api/controls/dragon/config"],
    ["GET", "/api/bus/board"],
    ["GET", "/api/bus/events"],
    ["POST", "/api/bus/send"],
  ] as const)("%s %s rejects a traversal project with 400", async (method, url) => {
    const res = await app.inject({
      method,
      url,
      query: { project: TRAVERSAL },
      ...(method === "POST" ? { payload: { to: "x", text: "y" } } : {}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it("has no unvalidated rewrite left that could overwrite or back up a YAML outside projects/", async () => {
    // POST /api/settings is gone; saving goes through src/server/settings/ (owner only, validated)
    const res = await app.inject({
      method: "POST",
      url: "/api/settings",
      query: { project: TRAVERSAL },
      payload: { read_only: false },
    });
    expect(res.statusCode).toBe(404);
    expect(readFileSync(OUTSIDE_FILE, "utf-8")).toBe(OUTSIDE_YAML);
    expect(readdirSync(TMP).filter((f) => f.includes(".backup-"))).toEqual([]);
  });

  it("rejects a missing project with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/controls/status" });
    expect(res.statusCode).toBe(400);
  });

  it("still serves the global audit log without a project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/controls/audit" });
    expect(res.statusCode).toBe(200);
  });

  it("accepts a known project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/controls/dragon/config",
      query: { project: PROJECT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});

describe("dragon start/stop validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses a start or stop without the owner's session, before writing any prompt file", async () => {
    for (const action of ["start", "stop"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/controls/dragon/${action}`,
        query: { project: PROJECT },
        headers: { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" },
        payload: { dragonId: "alpha", task: "no owner", prompt: "p" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("not signed in as the owner");
    }
    expect(existsSync(join(TMP, "prompts", "no-owner-alpha.txt"))).toBe(false);
  });

  it("rejects an unknown dragonId before writing any prompt file", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/start",
      query: { project: PROJECT },
      // Without validation this wrote <repo>/work/escape.txt
      payload: { dragonId: "x/../../../escape", task: "t", prompt: "p" },
    });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(TMP, "work", "escape.txt"))).toBe(false);
    expect(existsSync(join(TMP, "work"))).toBe(false);
  });

  it("rejects an unknown dragonId on stop", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/stop",
      query: { project: PROJECT },
      payload: { dragonId: "not-configured" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("writes the prompt for a configured dragon into prompts_dir", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/start",
      query: { project: PROJECT },
      payload: { dragonId: "alpha", task: "my task", prompt: "do it" },
    });
    // The project is read-only, so the start command itself is refused
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(TMP, "prompts", "my-task-alpha.txt"), "utf-8")).toBe("do it");
  });

  it("accepts a dragon listed only in dragons.txt on stop", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/stop",
      query: { project: PROJECT },
      payload: { dragonId: "bravo" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("accepts a dragon listed only in dragons.txt on start", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/start",
      query: { project: PROJECT },
      payload: { dragonId: "bravo", task: "txt task", prompt: "go" },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(TMP, "prompts", "txt-task-bravo.txt"), "utf-8")).toBe("go");
  });

  it("refuses a digit-first dragonId that the registry would never list", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/stop",
      query: { project: PROJECT },
      payload: { dragonId: "1-agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid dragonId");
  });

  it("names an unknown dragon in the error", async () => {
    const res = await app.inject({
      method: "POST",
      headers: owner(),
      url: "/api/controls/dragon/start",
      query: { project: PROJECT },
      payload: { dragonId: "charlie", task: "t", prompt: "p" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Unknown dragon: charlie");
  });

  it("lists the YAML and the dragons.txt dragons in dragon/config", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/controls/dragon/config",
      query: { project: PROJECT },
    });
    expect(res.statusCode).toBe(200);
    const { dragons } = res.json().data;
    // Exactly the ids start/stop accept
    expect(Object.keys(dragons).sort()).toEqual(["alpha", "bravo"]);
    expect(dragons.alpha.name).toBe("Alpha");
    expect(dragons.bravo).toMatchObject({ id: "bravo", name: "Bravo", model: "", machine: "" });
  });

  it("defaults prompts_dir to data/prompts, not a repo-specific layout", () => {
    const config = { repo: "/some/repo" } as ProjectConfig;
    expect(getPromptsDir(config)).toBe(resolve("data", "prompts"));
  });
});

describe("removed budget-cost route", () => {
  it("POST /api/fleet/budget/cost does not exist", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/fleet/budget/cost",
        payload: { provider: "claude", cost: 1e9 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("bus SSE CORS", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = Fastify({ logger: false, forceCloseConnections: true });
    await app.register(cors, { origin: ["http://localhost:5173"] });
    await registerBusRoutes(app, auth, mockBusOptions());
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  function sse(origin?: string): Promise<{ status?: number; headers: IncomingHttpHeaders }> {
    return new Promise((resolveResponse, reject) => {
      const req = httpGet(
        {
          host: "127.0.0.1",
          port,
          path: `/api/bus/events?project=${PROJECT}`,
          headers: origin ? { Origin: origin } : {},
        },
        (res) => {
          resolveResponse({ status: res.statusCode, headers: res.headers });
          req.destroy();
        },
      );
      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
    });
  }

  it("does not send a wildcard Access-Control-Allow-Origin", async () => {
    const { status, headers } = await sse();
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a foreign origin outright", async () => {
    const { status, headers } = await sse("http://evil.example");
    expect(status).toBe(403);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps the app's CORS header for the dashboard origin", async () => {
    const { status, headers } = await sse("http://localhost:5173");
    expect(status).toBe(200);
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});

describe("cross-site browser requests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerControlRoutes(app, auth);
    await registerSettingsRoutes(app, auth);
    await registerProcessRoutes(app, auth);
    await registerSchedulerRoutes(app, auth);
    await registerFleetRoutes(app, auth);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // A no-CORS "simple" POST from any web page reaches the server without a
  // preflight; the browser still sends its Origin.
  it.each([
    "/api/controls/tick",
    "/api/controls/pause",
    "/api/processes/anything/restart",
    "/api/scheduler/stop",
    "/api/fleet/budget/providers/claude/unpause",
  ])("refuses POST %s from a foreign origin", async (url) => {
    const res = await app.inject({
      method: "POST",
      url,
      query: { project: PROJECT },
      headers: { origin: "http://evil.example", "content-type": "text/plain" },
      payload: "x",
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a DNS-rebinding Host header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/controls/status",
      query: { project: PROJECT },
      headers: { host: "attacker.example:4777" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the dashboard origin and loopback hosts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/controls/status",
      query: { project: PROJECT },
      headers: { origin: "http://localhost:5173", host: "localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
  });
});
