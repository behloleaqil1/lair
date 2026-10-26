/**
 * The delivery routes over HTTP, mounted as in src/server/index.ts: the root
 * guards, then registerDeliveryRoutes with a DeliveryManager whose only fake
 * is docker (and the clock). Requests are built by the Delivery view's own
 * helpers (src/client/delivery-api.ts), and the view's runDeliveryAction is
 * sent through the router too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ProjectConfig } from "../../shared/types.js";
import type { DeliveryProjectStatus, Operation } from "../../shared/delivery-types.js";
import { registerRootGuards } from "../root-guards.js";
import { FakeClock, FakeDocker } from "./fake-docker.js";
import { DeliveryManager } from "./service.js";
import { registerDeliveryRoutes } from "./routes.js";
import {
  deliveryActionBody,
  deliveryActionUrl,
  needsConfirmation,
  runDeliveryAction,
  type DeliveryAction,
} from "../../client/delivery-api.js";

// "example" is the project shipped in projects/, so the root ?project= guard knows it
const PROJECT = "example";
const BROWSER = { host: "127.0.0.1:4777", origin: "http://localhost:5173" };
const C = (...args: string[]) => ["docker", "compose", "-p", "shop-local", "-f", "./deploy/compose.yaml", ...args];

let app: FastifyInstance | null = null;
let manager: DeliveryManager | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await manager?.stop();
  app = null;
  manager = null;
});

function config(extra: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "Shop",
    repo: "/home/user/shop",
    github: "example/shop",
    queue_file: "/home/user/shop/work/queue.md",
    agents_dir: "/home/user/shop/work/agents",
    gates_dir: "/home/user/shop/work/gates",
    machines: {},
    delivery: {
      enabled: true,
      environments: {
        local: {
          compose_files: ["./deploy/compose.yaml"],
          project_name: "shop-local",
          services: {
            db: { health: { type: "container" } },
            api: { health: { type: "http", url: "http://localhost:8080/health" }, build: true },
          },
        },
      },
    },
    ...extra,
  };
}

async function build(project: ProjectConfig = config()) {
  const docker = new FakeDocker("shop-local", { db: { healthcheck: true }, api: { url: "http://localhost:8080/health" } });
  manager = new DeliveryManager({
    dbPath: ":memory:",
    probes: { runner: docker, clock: new FakeClock(), http: docker.http },
  });
  manager.load([{ name: PROJECT, config: project }]);
  app = Fastify();
  registerRootGuards(app);
  await registerDeliveryRoutes(app, manager, () => PROJECT);
  await app.ready();
  return { app, docker };
}

async function post(
  server: FastifyInstance,
  action: DeliveryAction,
  options: { service?: string; confirmed?: boolean; reason?: string; headers?: Record<string, string> } = {},
) {
  return server.inject({
    method: "POST",
    url: deliveryActionUrl({ project: PROJECT, environment: "local", service: options.service }, action),
    headers: { ...BROWSER, "content-type": "application/json", ...options.headers },
    payload: deliveryActionBody(action, { confirmed: options.confirmed, reason: options.reason }),
  });
}

async function status(server: FastifyInstance): Promise<DeliveryProjectStatus> {
  const res = await server.inject({ url: `/api/delivery/status?project=${PROJECT}`, headers: BROWSER });
  expect(res.statusCode).toBe(200);
  return res.json().data as DeliveryProjectStatus;
}

/** Poll GET /api/delivery/operations/:id until the operation has finished. */
async function finished(server: FastifyInstance, id: string): Promise<Operation> {
  for (let i = 0; i < 200; i++) {
    const res = await server.inject({ url: `/api/delivery/operations/${id}?project=${PROJECT}`, headers: BROWSER });
    expect(res.statusCode).toBe(200);
    const op = res.json().data as Operation;
    if (op.status !== "running") return op;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`operation ${id} did not finish`);
}

describe("delivery over HTTP: Up -> status -> Down", () => {
  it("brings the environment up and down through the routes", async () => {
    const { app, docker } = await build();

    // GET status never runs docker: before the first tick nothing is known
    const unread = await status(app);
    expect(unread).toMatchObject({ project: PROJECT, enabled: true, readOnly: false });
    expect(unread.environments[0].services.map((s) => [s.name, s.state, s.healthDetail])).toEqual([
      ["db", "unknown", "not read yet"],
      ["api", "unknown", "not read yet"],
    ]);
    expect(docker.calls).toEqual([]);

    await manager!.get(PROJECT)!.tick();
    const before = await status(app);
    expect(before.environments[0].services.map((s) => [s.name, s.state, s.healthDetail])).toEqual([
      ["db", "stopped", "no container"],
      ["api", "stopped", "no container"],
    ]);

    const up = await post(app, "up");
    expect(up.statusCode).toBe(202);
    expect(up.json().data).toMatchObject({ kind: "up", environment: "local", requestedBy: "human" });
    const upDone = await finished(app, up.json().data.id);
    expect(upDone.status).toBe("succeeded");
    expect(docker.mutations()).toEqual([C("up", "-d", "--no-deps", "db"), C("up", "-d", "--no-deps", "api")]);

    const running = await status(app);
    expect(running.environments[0].services.map((s) => [s.name, s.state, s.health, s.restartCount])).toEqual([
      ["db", "running", "healthy", 0],
      ["api", "running", "healthy", 0],
    ]);
    expect(running.environments[0].operation).toBeNull();

    // Down must be confirmed and give a reason
    expect((await post(app, "down")).statusCode).toBe(400);
    const noReason = await post(app, "down", { confirmed: true });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe("a reason is required to take services down");
    expect(docker.mutations()).toHaveLength(2);

    const down = await post(app, "down", { confirmed: true, reason: "end of day" });
    expect(down.statusCode).toBe(202);
    expect((await finished(app, down.json().data.id)).status).toBe("succeeded");
    expect(docker.mutations().slice(2)).toEqual([C("stop", "api", "db")]);

    const after = await status(app);
    expect(after.environments[0].services.map((s) => [s.name, s.state, s.held?.source, s.held?.reason])).toEqual([
      ["db", "stopped", "environment", "end of day"],
      ["api", "stopped", "environment", "end of day"],
    ]);

    const ops = await app.inject({ url: `/api/delivery/operations?project=${PROJECT}&environment=local`, headers: BROWSER });
    expect(ops.json().data.map((o: Operation) => [o.kind, o.status])).toEqual([
      ["down", "succeeded"],
      ["up", "succeeded"],
    ]);
  });

  it("holds a service with a per-service Down, refuses to start it by name, and releases it", async () => {
    const { app, docker } = await build();
    await finished(app, (await post(app, "up")).json().data.id);

    const down = await post(app, "down", { service: "db", confirmed: true, reason: "restoring a dump" });
    expect(down.statusCode).toBe(202);
    await finished(app, down.json().data.id);
    expect(docker.mutations().at(-1)).toEqual(C("stop", "db"));

    const refused = await post(app, "up", { service: "db" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("service db is held (restoring a dump): release it first");

    const release = await post(app, "release", { service: "db" });
    expect(release.statusCode).toBe(200);
    expect(release.json().data).toMatchObject({ kind: "release", status: "succeeded" });
    expect((await status(app)).environments[0].services[0].held).toBeNull();
  });

  it("the Delivery view's runDeliveryAction calls the real routes", async () => {
    const { app, docker } = await build();
    const server = app;
    vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const res = await server.inject({ method: "POST", url, headers: { ...BROWSER, ...init.headers }, payload: init.body });
      return { status: res.statusCode, json: async () => res.json() };
    });

    const up = await runDeliveryAction({ project: PROJECT, environment: "local" }, "up");
    await finished(app, up.id);
    expect(docker.mutations()).toEqual([C("up", "-d", "--no-deps", "db"), C("up", "-d", "--no-deps", "api")]);

    const restart = await runDeliveryAction({ project: PROJECT, environment: "local", service: "api" }, "restart", {
      confirmed: needsConfirmation("restart"),
    });
    await finished(app, restart.id);
    expect(docker.mutations().at(-1)).toEqual(C("restart", "api"));

    await expect(
      runDeliveryAction({ project: PROJECT, environment: "local", service: "api" }, "down", { confirmed: true }),
    ).rejects.toThrow("a reason is required");
  });
});

describe("delivery routes: guards and validation", () => {
  it("refuses cross-site requests and foreign Host headers before running anything", async () => {
    const { app, docker } = await build();
    const crossSite = await post(app, "up", { headers: { origin: "http://attacker.example" } });
    expect(crossSite.statusCode).toBe(403);
    const rebinding = await post(app, "up", { headers: { host: "attacker.example:4777" } });
    expect(rebinding.statusCode).toBe(403);
    expect(docker.calls).toEqual([]);
  });

  it("refuses unknown projects, environments, services and actions, and unexpected body keys", async () => {
    const { app, docker } = await build();
    const send = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: "POST", url, headers: { ...BROWSER, "content-type": "application/json" }, payload });

    expect((await send("/api/delivery/environments/local/up?project=nope")).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/up?project=..%2Fx")).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/staging/up")).statusCode).toBe(404);
    expect((await send("/api/delivery/environments/..%2F..%2Fetc/up")).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/services/cache/up")).statusCode).toBe(404);
    expect((await send("/api/delivery/environments/local/services/-rf/up")).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/nuke")).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/up", { cmd: "rm -rf /" })).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/up", { services: ["api"] })).statusCode).toBe(400);
    expect((await send("/api/delivery/environments/local/restart")).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/delivery/operations/not-an-id", headers: BROWSER })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: "/api/delivery/operations/00000000-0000-4000-8000-000000000000", headers: BROWSER }))
        .statusCode,
    ).toBe(404);
    expect(docker.calls).toEqual([]);
  });

  it("answers 403 to every action on a read_only project", async () => {
    const { app, docker } = await build(config({ read_only: true }));
    for (const action of ["up", "down", "restart", "deploy"] as const) {
      const res = await post(app, action, { confirmed: true, reason: "x" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("the project is read_only");
    }
    expect(docker.mutations()).toEqual([]);
    expect((await status(app)).readOnly).toBe(true);
  });

  it("reports a project without delivery, and one with an invalid delivery block", async () => {
    const off = await build(config({ delivery: undefined }));
    expect(await status(off.app)).toMatchObject({ enabled: false, errors: [], environments: [] });
    expect((await post(off.app, "up")).statusCode).toBe(404);
    await off.app.close();
    await manager?.stop();

    const broken = await build(config({ delivery: { enabled: true, environments: { local: { project_name: "x" } } } }));
    const s = await status(broken.app);
    expect(s.enabled).toBe(false);
    expect(s.errors.join("; ")).toContain("delivery.environments.local.compose_files");
  });

  it("registers actions as POST only", async () => {
    const { app } = await build();
    expect(app.hasRoute({ method: "GET", url: "/api/delivery/status" })).toBe(true);
    const get = await app.inject({ url: "/api/delivery/environments/local/up", headers: BROWSER });
    expect(get.statusCode).toBe(404);
  });
});
