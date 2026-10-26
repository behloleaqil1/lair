/**
 * Delivery acceptance tests.
 *
 * Only the system boundary is fake: FakeDocker answers docker and git argv
 * in the real output formats, its `http` answers health URLs, and FakeClock
 * stands in for time. Everything else is the real code: the config parser,
 * the compose parsers, the environment controller and the store. Tests
 * assert the argv that was sent and what those commands left behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { Event } from "../../shared/server-types.js";
import { EventBus } from "../core/event-bus.js";
import { FakeClock, FakeDocker, MIN, type FakeService } from "./fake-docker.js";
import { createDelivery, type Delivery } from "./service.js";
import { DeliveryStore } from "./store.js";
import type { EnvironmentController, RequestResult } from "./environment.js";
import type { Operation } from "./types.js";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const C = (...args: string[]) => ["docker", "compose", "-p", "shop-local", "-f", "./deploy/compose.yaml", ...args];
const UP = (service: string) => C("up", "-d", "--no-deps", service);

const ENV = {
  compose_files: ["./deploy/compose.yaml"],
  project_name: "shop-local",
  services: {
    db: { health: { type: "container" } },
    api: { health: { type: "http", url: "http://localhost:8080/health" }, build: true, paths: ["api/"] },
    web: { build: true, paths: ["web/"] },
  },
  start_order: ["db", "api", "web"],
  start_timeout_seconds: 60,
  crash_loop: { max_restarts: 3, window_minutes: 10 },
  deploy: { auto: true, ref: "main", health_timeout_minutes: 5 },
};

interface Harness {
  docker: FakeDocker;
  clock: FakeClock;
  store: DeliveryStore;
  delivery: Delivery;
  env: EnvironmentController;
  events: Event[];
}

const stores: DeliveryStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  overrides: Record<string, unknown> = {},
  options: { readOnly?: boolean; store?: DeliveryStore; docker?: FakeDocker; fake?: Record<string, FakeService> } = {},
): Harness {
  // options.docker: the same containers and images across a restart of Lair
  const docker =
    options.docker ??
    new FakeDocker("shop-local", options.fake ?? { db: { healthcheck: true }, api: { url: "http://localhost:8080/health" }, web: {} });
  const clock = new FakeClock();
  const store = options.store ?? new DeliveryStore(":memory:");
  if (!options.store) stores.push(store);
  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (event) => {
    events.push(event);
  });
  const config: ProjectConfig = {
    name: "Shop",
    repo: "/home/user/shop",
    github: "example/shop",
    queue_file: "/home/user/shop/work/queue.md",
    agents_dir: "/home/user/shop/work/agents",
    gates_dir: "/home/user/shop/work/gates",
    machines: {},
    read_only: options.readOnly ?? false,
    delivery: { enabled: true, environments: { local: { ...ENV, ...overrides } } },
  };
  const delivery = createDelivery({
    project: "shop",
    config,
    store,
    probes: { runner: docker, clock, http: docker.http },
    events: bus,
  });
  return { docker, clock, store, delivery, env: delivery.environment("local")!, events };
}

function started(result: RequestResult): Operation {
  if (!result.ok) throw new Error(`refused (${result.code}): ${result.error}`);
  return result.operation;
}

async function run(h: Harness, request: Parameters<EnvironmentController["request"]>[0]): Promise<Operation> {
  const op = started(h.env.request(request));
  await h.env.idle();
  return h.store.getOperation(op.id)!;
}

function skipped(op: Operation): { service?: string; detail?: string }[] {
  return op.steps.filter((s) => s.action === "skip").map((s) => ({ service: s.service, detail: s.detail }));
}

async function service(h: Harness, name: string) {
  return (await h.env.status()).services.find((s) => s.name === name)!;
}

// ============ UP AND DOWN ============

describe("Up and Down", () => {
  it("Up starts each service in start order with --no-deps, each healthy before the next", async () => {
    const h = setup();
    const op = await run(h, { kind: "up", by: "human" });

    expect(h.docker.mutations()).toEqual([UP("db"), UP("api"), UP("web")]);
    expect(op.status).toBe("succeeded");
    expect(op.steps.filter((s) => s.action === "wait").map((s) => [s.service, s.status])).toEqual([
      ["db", "succeeded"],
      ["api", "succeeded"],
      ["web", "succeeded"],
    ]);
    const status = await h.env.status();
    expect(status.services.map((s) => [s.name, s.state, s.health])).toEqual([
      ["db", "running", "healthy"],
      ["api", "running", "healthy"],
      ["web", "running", "none"],
    ]);
    expect(status.services[1].healthDetail).toBe("GET http://localhost:8080/health: 200");
    expect(h.events.map((e) => e.type)).toEqual(["delivery.started", "delivery.finished"]);
  });

  it("Up stops at a service that doesn't become healthy and starts nothing after it", async () => {
    const h = setup();
    h.docker.images.get(h.docker.imageOf("db")!)!.broken = true;
    const t0 = h.clock.now();

    const op = await run(h, { kind: "up", by: "human" });

    expect(h.docker.mutations()).toEqual([UP("db")]);
    expect(op).toMatchObject({ status: "failed" });
    expect(op.error).toContain("db: not healthy within 1 min (unhealthy: docker health check: unhealthy");
    expect(skipped(op)).toEqual([
      { service: "api", detail: "not started: db did not become healthy" },
      { service: "web", detail: "not started: db did not become healthy" },
    ]);
    expect(h.clock.now() - t0).toBe(60_000);
    // the failing service's last error lines are shown
    const db = await service(h, "db");
    expect(db.state).toBe("unhealthy");
    expect(db.lastErrorLines).toContain("curl: (7) Failed to connect to localhost port 8080");
    expect(db.lastErrorLines).toContain('FATAL: missing table "orders"');
  });

  it("reads the older Compose output (one JSON array) the same way", async () => {
    const h = setup();
    h.docker.arrayFormat = true;
    h.docker.running("db", "api", "web");
    await h.env.read();
    expect((await h.env.status()).services.map((s) => s.state)).toEqual(["running", "running", "running"]);
  });

  it("an environment Down stops the configured services (never compose down), leaves the rest, and holds them", async () => {
    // cache is in the compose project but not in the delivery config
    const h = setup({}, { fake: { db: { healthcheck: true }, api: { url: "http://localhost:8080/health" }, web: {}, cache: {} } });
    h.docker.running("db", "api", "web", "cache");
    const op = await run(h, { kind: "down", by: "human", reason: "end of day" });

    expect(h.docker.mutations()).toEqual([C("stop", "web", "api", "db")]);
    expect(op.status).toBe("succeeded");
    expect(h.docker.container("cache")!.state).toBe("running");
    expect(h.docker.containers.map((c) => [c.service, c.state])).toEqual([
      ["db", "exited"],
      ["api", "exited"],
      ["web", "exited"],
      ["cache", "running"],
    ]);
    const status = await h.env.status();
    expect(status.services.map((s) => [s.name, s.state, s.held?.source, s.held?.reason])).toEqual([
      ["db", "stopped", "environment", "end of day"],
      ["api", "stopped", "environment", "end of day"],
      ["web", "stopped", "environment", "end of day"],
    ]);
  });

  it("refuses a Down without a reason, and a second operation while one runs", async () => {
    const h = setup();
    expect(h.env.request({ kind: "down", by: "human", reason: "  " })).toMatchObject({ ok: false, code: 400 });
    started(h.env.request({ kind: "up", by: "human" }));
    expect(h.env.request({ kind: "restart", by: "human" })).toMatchObject({ ok: false, code: 409 });
    await h.env.idle();
    expect(h.docker.mutations()).toEqual([UP("db"), UP("api"), UP("web")]);
  });

  it("does nothing on a read_only project", async () => {
    const h = setup({}, { readOnly: true });
    expect(h.env.request({ kind: "up", by: "human" })).toEqual({ ok: false, code: 403, error: "the project is read_only" });
    await h.delivery.tick();
    expect(h.docker.mutations()).toEqual([]);
  });
});

// ============ HELD ============

describe("held: a service a human stopped is never started by Lair until released", () => {
  it("a per-service Down holds it at once, stops it, and an environment Up skips it", async () => {
    const h = setup();
    h.docker.running("db", "api", "web");

    const down = started(h.env.request({ kind: "down", service: "db", by: "human", reason: "restoring a dump by hand" }));
    // Held before the stop has even run
    expect(h.store.getHold("shop", "local", "db")).toMatchObject({ reason: "restoring a dump by hand", source: "service" });
    await h.env.idle();
    expect(h.store.getOperation(down.id)!.status).toBe("succeeded");
    expect(h.docker.mutations()).toEqual([C("stop", "db")]);
    expect(h.docker.container("db")!.state).toBe("exited");

    h.docker.calls = [];
    const up = await run(h, { kind: "up", by: "human" });
    expect(h.docker.mutations()).toEqual([UP("api"), UP("web")]);
    expect(h.docker.container("db")!.state).toBe("exited");
    expect(skipped(up)).toEqual([{ service: "db", detail: "held: restoring a dump by hand" }]);
    expect((await service(h, "db")).held).toMatchObject({ reason: "restoring a dump by hand" });
    expect(h.events.filter((e) => e.type === "delivery.held").map((e) => e.data.service)).toEqual(["db"]);
  });

  it("a held service can't be started, restarted or deployed by name until it is released", async () => {
    const h = setup();
    h.docker.running("db", "api", "web");
    await run(h, { kind: "down", service: "api", by: "human", reason: "profiling" });
    h.docker.calls = [];

    for (const kind of ["up", "restart", "deploy"] as const) {
      expect(h.env.request({ kind, service: "api", by: "human" })).toEqual({
        ok: false,
        code: 409,
        error: "service api is held (profiling): release it first",
      });
    }
    expect(h.docker.mutations()).toEqual([]);

    const release = await run(h, { kind: "release", service: "api", by: "human" });
    expect(release).toMatchObject({ kind: "release", status: "succeeded" });
    expect(h.store.getHold("shop", "local", "api")).toBeNull();
    await run(h, { kind: "up", service: "api", by: "human" });
    expect(h.docker.mutations()).toEqual([UP("api")]);
    expect(h.docker.healthy("api")).toBe(true);
  });

  it("an environment Up releases an environment Down's holds, but a service's own hold outlives it", async () => {
    const h = setup();
    h.docker.running("db", "api", "web");
    await run(h, { kind: "down", service: "db", by: "human", reason: "maintenance" });
    await run(h, { kind: "down", by: "human", reason: "end of day" });
    expect(h.store.holds("shop", "local").map((x) => [x.service, x.source, x.reason])).toEqual([
      ["db", "service", "maintenance"],
      ["api", "environment", "end of day"],
      ["web", "environment", "end of day"],
    ]);

    h.docker.calls = [];
    const up = await run(h, { kind: "up", by: "human" });
    expect(h.docker.mutations()).toEqual([UP("api"), UP("web")]);
    expect(skipped(up)).toEqual([{ service: "db", detail: "held: maintenance" }]);
    expect(h.store.holds("shop", "local").map((x) => x.service)).toEqual(["db"]);
  });

  it("a hold survives a restart of Lair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-delivery-"));
    dirs.push(dir);
    const path = join(dir, "delivery.db");

    const first = setup({}, { store: new DeliveryStore(path) });
    first.docker.running("db", "api", "web");
    await run(first, { kind: "down", service: "db", by: "human", reason: "disk check" });
    await first.delivery.stop();
    first.store.close();

    const store = new DeliveryStore(path);
    stores.push(store);
    const second = setup({}, { store });
    expect((await service(second, "db")).held).toMatchObject({ reason: "disk check", source: "service" });
    const up = await run(second, { kind: "up", by: "human" });
    expect(second.docker.mutations()).toEqual([UP("api"), UP("web")]);
    expect(skipped(up)).toEqual([{ service: "db", detail: "held: disk check" }]);
  });

  it("an operation cut off by a stop is marked interrupted when Lair starts again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-delivery-"));
    dirs.push(dir);
    const path = join(dir, "delivery.db");
    const store = new DeliveryStore(path);
    const op = store.createOperation({
      project: "shop",
      environment: "local",
      kind: "up",
      services: [],
      requestedBy: "human",
      status: "running",
      startedAt: "2026-03-02T11:00:00.000Z",
      steps: [],
    });
    store.close();
    const reopened = new DeliveryStore(path);
    stores.push(reopened);
    setup({}, { store: reopened });
    expect(reopened.getOperation(op.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("interrupted") });
  });
});

// ============ CRASH LOOP ============

describe("crash loop: a restart count rising within the window", () => {
  async function crashLoop(h: Harness): Promise<void> {
    h.docker.running("db", "api", "web");
    await h.delivery.tick(); // first sample: 0
    h.docker.crash("api", 2);
    h.clock.advance(2 * MIN);
    await h.delivery.tick();
    h.docker.crash("api", 2);
    h.clock.advance(2 * MIN);
    await h.delivery.tick();
  }

  it("marks the service crash-looping, with its last error lines, and emits delivery.crash_loop", async () => {
    const h = setup({ deploy: { auto: false } });
    await crashLoop(h);

    const loop = h.store.getCrashLoop("shop", "local", "api");
    expect(loop).toMatchObject({ container: "shop-local-api-1", restarts: 4, maxRestarts: 3, windowMinutes: 10 });
    expect(loop!.errorLines).toContain("Error: connect ECONNREFUSED localhost:5432");
    expect(loop!.evidence).toContain("2026-03-02T12:04:00.000Z restart count 4");
    expect(loop!.evidence).toContain("log: Error: connect ECONNREFUSED localhost:5432");
    const api = await service(h, "api");
    expect(api).toMatchObject({ state: "restarting", restartCount: 4 });
    expect(api.crashLoop).not.toBeNull();
    expect(api.lastErrorLines).toContain("Error: connect ECONNREFUSED localhost:5432");
    const event = h.events.find((e) => e.type === "delivery.crash_loop");
    expect(event?.data).toMatchObject({ project: "shop", environment: "local", service: "api", container: "shop-local-api-1", restarts: 4 });
    // reading never restarts anything
    expect(h.docker.mutations()).toEqual([]);
  });

  it("stops Lair's restarts: an environment Up or Restart skips it, until a human acts on the service itself", async () => {
    const h = setup({ deploy: { auto: false } });
    await crashLoop(h);
    h.docker.calls = [];

    const restart = await run(h, { kind: "restart", by: "human" });
    expect(h.docker.mutations()).toEqual([C("restart", "db"), C("restart", "web")]);
    expect(skipped(restart)[0].service).toBe("api");
    expect(skipped(restart)[0].detail).toContain("crash-looping since 2026-03-02T12:04:00.000Z (4 restarts in 10 min)");
    const up = await run(h, { kind: "up", by: "human" });
    expect(skipped(up).map((s) => s.service)).toEqual(["api"]);
    expect(h.docker.mutations()).not.toContainEqual(UP("api"));

    h.docker.calls = [];
    const own = await run(h, { kind: "restart", service: "api", by: "human" });
    expect(own.status).toBe("succeeded");
    // recreated, so the container gets the compose file's settings back (a playbook may have set restart=no)
    expect(own.steps.map((s) => s.action)).toEqual(["clear-crash-loop", "up", "wait"]);
    expect(h.docker.mutations()).toEqual([C("up", "-d", "--no-deps", "--force-recreate", "api")]);
    expect(h.store.getCrashLoop("shop", "local", "api")).toBeNull();
  });

  it("a steady count, or a count that drops when the container is recreated, is not a loop", async () => {
    const steady = setup();
    steady.docker.running("db", "api", "web");
    steady.docker.container("api")!.restartCount = 5;
    for (let i = 0; i < 3; i++) {
      await steady.delivery.tick();
      steady.clock.advance(2 * MIN);
    }
    expect(steady.store.crashLoops("shop")).toEqual([]);

    const recreated = setup();
    recreated.docker.running("db", "api", "web");
    recreated.docker.container("api")!.restartCount = 6;
    await recreated.delivery.tick();
    recreated.docker.containers = recreated.docker.containers.filter((c) => c.service !== "api");
    recreated.docker.running("api");
    recreated.clock.advance(2 * MIN);
    await recreated.delivery.tick();
    recreated.docker.crash("api", 1);
    recreated.clock.advance(2 * MIN);
    await recreated.delivery.tick();
    expect(recreated.store.crashLoops("shop")).toEqual([]);
  });

  it("a loop that ends by itself is cleared after a quiet window", async () => {
    const h = setup({ deploy: { auto: false } });
    await crashLoop(h);
    h.docker.container("api")!.state = "running";
    for (let i = 0; i < 6; i++) {
      h.clock.advance(2 * MIN);
      await h.delivery.tick();
    }
    expect(h.store.getCrashLoop("shop", "local", "api")).toBeNull();
    expect(h.events.map((e) => e.type)).toContain("delivery.crash_loop_cleared");
  });
});

// ============ DEPLOY AFTER A MERGE ============

describe("deploy after a merge", () => {
  async function merged(h: Harness, files: string[]): Promise<void> {
    h.docker.running("db", "api", "web");
    await h.delivery.tick(); // the first commit seen is what runs now
    expect(h.store.seenSha("shop", "local")).toBe(SHA1);
    h.docker.git.head = SHA2;
    h.docker.git.diffs.set(`${SHA1}..${SHA2}`, files);
    h.docker.calls = [];
  }

  it("tags the running image, rebuilds and rolls only the changed service, and waits for it to be healthy", async () => {
    const h = setup();
    await merged(h, ["api/src/orders.ts", "README.md"]);
    const before = h.docker.container("api")!.imageId;

    await h.delivery.tick();
    await h.delivery.idle();

    expect(h.docker.calls.filter((a) => a[0] === "git")).toEqual([
      ["git", "-C", "/home/user/shop", "rev-parse", "--verify", "--quiet", "main^{commit}"],
      ["git", "-C", "/home/user/shop", "diff", "--name-only", SHA1, SHA2],
    ]);
    expect(h.docker.mutations()).toEqual([
      ["docker", "tag", before, "shop-local-api:lair-previous"],
      C("build", "api"),
      C("up", "-d", "--no-deps", "--no-build", "api"),
    ]);
    const [op] = h.store.listOperations("shop");
    expect(op).toMatchObject({ kind: "deploy", requestedBy: "auto", sha: SHA2, services: ["api"], status: "succeeded" });
    expect(h.docker.container("api")!.imageId).not.toBe(before);
    expect(h.docker.healthy("api")).toBe(true);
    expect(h.docker.tags.get("shop-local-api:lair-previous")).toBe(before);
    expect(h.store.seenSha("shop", "local")).toBe(SHA2);

    // the same commit is not deployed twice
    h.docker.calls = [];
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.docker.mutations()).toEqual([]);
  });

  it("rolls back to the tagged image when the new one isn't healthy within health_timeout_minutes", async () => {
    const h = setup({ deploy: { auto: true, ref: "main", health_timeout_minutes: 2 } });
    await merged(h, ["api/src/orders.ts", "web/src/cart.tsx"]);
    const before = h.docker.container("api")!.imageId;
    h.docker.nextBuild.api = "broken";
    const t0 = h.clock.now();

    await h.delivery.tick();
    await h.delivery.idle();

    expect(h.docker.mutations()).toEqual([
      ["docker", "tag", before, "shop-local-api:lair-previous"],
      C("build", "api"),
      C("up", "-d", "--no-deps", "--no-build", "api"),
      ["docker", "tag", "shop-local-api:lair-previous", "shop-local-api"],
      C("up", "-d", "--no-deps", "--no-build", "--force-recreate", "api"),
    ]);
    // back on the previous image, and healthy
    expect(h.docker.container("api")!.imageId).toBe(before);
    expect(h.docker.healthy("api")).toBe(true);
    const elapsed = h.clock.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2 * MIN);
    expect(elapsed).toBeLessThan(3 * MIN);

    const [op] = h.store.listOperations("shop");
    expect(op.status).toBe("rolled_back");
    expect(op.error).toContain("api: not healthy within 2 min");
    expect(op.error).toContain("rolled back to shop-local-api:lair-previous");
    expect(op.steps.filter((s) => s.action === "wait").map((s) => s.status)).toEqual(["failed", "succeeded"]);
    // the later service is not deployed on top of a rolled-back one
    expect(skipped(op)).toEqual([{ service: "web", detail: "not deployed: api was not" }]);
  });

  it("a failed build changes nothing that runs", async () => {
    const h = setup();
    await merged(h, ["api/src/orders.ts"]);
    const before = h.docker.container("api")!.id;
    h.docker.nextBuild.api = "fail";

    await h.delivery.tick();
    await h.delivery.idle();

    expect(h.docker.mutations()).toEqual([
      ["docker", "tag", h.docker.container("api")!.imageId, "shop-local-api:lair-previous"],
      C("build", "api"),
    ]);
    expect(h.docker.container("api")!.id).toBe(before);
    expect(h.store.listOperations("shop")[0]).toMatchObject({
      status: "failed",
      error: "build of api failed; the running container was not touched",
    });
  });

  it("never deploys a held service", async () => {
    const h = setup();
    await merged(h, ["api/src/orders.ts"]);
    await run(h, { kind: "down", service: "api", by: "human", reason: "investigating a leak" });
    h.docker.calls = [];

    await h.delivery.tick();
    await h.delivery.idle();

    expect(h.docker.mutations()).toEqual([]);
    expect(h.docker.container("api")!.state).toBe("exited");
    const [op] = h.store.listOperations("shop");
    expect(op).toMatchObject({ kind: "deploy", requestedBy: "auto" });
    expect(skipped(op)).toEqual([{ service: "api", detail: "held: investigating a leak" }]);
  });

  it("never starts a stopped service, and never restarts a crash-looping one", async () => {
    const stopped = setup();
    await merged(stopped, ["web/src/cart.tsx"]);
    stopped.docker.container("web")!.state = "exited";
    await stopped.delivery.tick();
    await stopped.delivery.idle();
    expect(stopped.docker.mutations()).toEqual([]);
    expect(skipped(stopped.store.listOperations("shop")[0])).toEqual([
      { service: "web", detail: "not running: an automatic deploy never starts a stopped service" },
    ]);

    const looping = setup();
    looping.docker.running("db", "api", "web");
    await looping.delivery.tick();
    for (let i = 0; i < 2; i++) {
      looping.docker.crash("api", 2);
      looping.clock.advance(2 * MIN);
      await looping.delivery.tick();
    }
    expect(looping.store.getCrashLoop("shop", "local", "api")).not.toBeNull();
    looping.docker.git.head = SHA2;
    looping.docker.git.diffs.set(`${SHA1}..${SHA2}`, ["api/src/orders.ts"]);
    looping.docker.calls = [];
    await looping.delivery.tick();
    await looping.delivery.idle();
    expect(looping.docker.mutations()).toEqual([]);
    expect(skipped(looping.store.listOperations("shop")[0])[0].detail).toContain("crash-looping");
  });

  it("runs prepare_cmd with the merged commit first", async () => {
    const h = setup({ deploy: { auto: true, prepare_cmd: ["./bin/update-tree", "{sha}", "{ref}"] } });
    await merged(h, ["web/src/cart.tsx"]);
    await h.delivery.tick();
    await h.delivery.idle();
    const mutations = h.docker.mutations();
    expect(mutations[0]).toEqual(["./bin/update-tree", SHA2, "main"]);
    expect(mutations.slice(2)).toEqual([C("build", "web"), C("up", "-d", "--no-deps", "--no-build", "web")]);
    expect(h.store.listOperations("shop")[0].status).toBe("succeeded");
  });

  it("deploys nothing for a merge that touches no service's paths, or on a read_only project", async () => {
    const h = setup();
    await merged(h, ["docs/guide.md"]);
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.docker.mutations()).toEqual([]);
    expect(h.store.listOperations("shop")).toEqual([]);
    expect(h.store.seenSha("shop", "local")).toBe(SHA2);

    const ro = setup({}, { readOnly: true });
    ro.docker.running("db", "api", "web");
    await ro.delivery.tick();
    expect(ro.docker.calls.filter((a) => a[0] === "git")).toEqual([]);
    expect((await ro.env.status()).autoDeploy.blocked).toBe("the project is read_only");
  });

  it("a human deploy of one service uses the same tag, build, roll and health wait", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    const before = h.docker.container("web")!.imageId;
    const op = await run(h, { kind: "deploy", service: "web", by: "human" });
    expect(op.status).toBe("succeeded");
    expect(h.docker.mutations()).toEqual([
      ["docker", "tag", before, "shop-local-web:lair-previous"],
      C("build", "web"),
      C("up", "-d", "--no-deps", "--no-build", "web"),
    ]);
    expect(h.env.request({ kind: "deploy", service: "db", by: "human" })).toMatchObject({ ok: false, code: 400 });
  });
});

// ============ REVIEW FIXES ============

/** Let pending promises run until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

/** Running stack, first commit seen, then a merge to SHA2 that changed `files`. */
async function mergedTo(h: Harness, files: string[]): Promise<void> {
  h.docker.running("db", "api", "web");
  await h.delivery.tick();
  h.docker.git.head = SHA2;
  h.docker.git.diffs.set(`${SHA1}..${SHA2}`, files);
  h.docker.calls = [];
}

describe("an environment that can't be read (docker missing, the daemon down)", () => {
  const ENOENT = "spawn docker ENOENT";

  it("before any good read: every service is unknown, and Up, Restart and Deploy wait (Down still holds)", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.broken = ENOENT;
    await h.delivery.tick();

    const status = await h.env.status();
    expect(status.error).toContain(ENOENT);
    expect(status.services.map((s) => [s.name, s.state, s.health])).toEqual([
      ["db", "unknown", "unknown"],
      ["api", "unknown", "unknown"],
      ["web", "unknown", "unknown"],
    ]);
    expect(status.services[0].healthDetail).toBe(`can't read the environment: docker compose ps exited -1: ${ENOENT}`);
    for (const kind of ["up", "restart", "deploy"] as const) {
      expect(h.env.request({ kind, by: "human" })).toMatchObject({ ok: false, code: 409 });
    }
    expect(h.env.request({ kind: "down", service: "api", by: "human", reason: "safe side" }).ok).toBe(true);
    await h.env.idle();
    expect(h.store.getHold("shop", "local", "api")).not.toBeNull();
  });

  it("after a good read: the last known 'running' is never shown beside the error", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    await h.delivery.tick();
    expect((await h.env.status()).services.map((s) => s.state)).toEqual(["running", "running", "running"]);

    h.docker.broken = ENOENT;
    await h.delivery.tick();
    const broken = await h.env.status();
    expect(broken.error).toContain(ENOENT);
    expect(broken.services.map((s) => s.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(broken.services.every((s) => s.containers.length === 0)).toBe(true);
    expect(broken.checkedAt).toBe("2026-03-02T12:00:00.000Z"); // the last good read

    h.docker.broken = null;
    await h.delivery.tick();
    const back = await h.env.status();
    expect(back.error).toBeNull();
    expect(back.services.map((s) => s.state)).toEqual(["running", "running", "running"]);
  });

  it("GET status never runs docker: before the first tick every service is 'not read yet'", async () => {
    const h = setup();
    const status = await h.env.status();
    expect(h.docker.calls).toEqual([]);
    expect(status.checkedAt).toBeNull();
    expect(status.services.map((s) => [s.state, s.healthDetail])).toEqual([
      ["unknown", "not read yet"],
      ["unknown", "not read yet"],
      ["unknown", "not read yet"],
    ]);
  });

  it("an older read that finishes last doesn't overwrite a newer one", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    const release = h.docker.delay((argv) => argv.includes("ps"));
    const older = h.env.read(); // its answer (web running) arrives late
    h.docker.container("web")!.state = "exited";
    await h.env.read();
    release();
    await older;
    expect((await service(h, "web")).state).toBe("stopped");
  });
});

describe("merges are never lost, and a service left behind comes again", () => {
  it("a human operation started while git diff runs leaves the merge for the next tick", async () => {
    const h = setup();
    await mergedTo(h, ["api/src/orders.ts"]);
    h.docker.onRun = (argv) => {
      if (argv[0] === "git" && argv[3] === "diff") {
        h.docker.onRun = undefined;
        started(h.env.request({ kind: "restart", service: "web", by: "human" }));
      }
    };
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.store.listOperations("shop").map((o) => o.kind)).toEqual(["restart"]);
    expect(h.store.seenSha("shop", "local")).toBe(SHA1);

    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.store.listOperations("shop")[0]).toMatchObject({ kind: "deploy", sha: SHA2, services: ["api"], status: "succeeded" });
    expect(h.docker.mutations()).toContainEqual(C("build", "api"));
    expect(h.store.seenSha("shop", "local")).toBe(SHA2);
  });

  it("a failed git diff leaves the merge for the next tick", async () => {
    const h = setup();
    await mergedTo(h, ["api/src/orders.ts"]);
    const files = h.docker.git.diffs.get(`${SHA1}..${SHA2}`)!;
    h.docker.git.diffs.delete(`${SHA1}..${SHA2}`);
    await h.delivery.tick();
    expect(h.delivery.lastError).toContain("git diff");
    expect(h.store.seenSha("shop", "local")).toBe(SHA1);

    h.docker.git.diffs.set(`${SHA1}..${SHA2}`, files);
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.store.listOperations("shop")[0]).toMatchObject({ kind: "deploy", sha: SHA2, status: "succeeded" });
  });

  it("a rolled-back service shows as behind, and the next merge deploys it even if it didn't touch it", async () => {
    const h = setup({ deploy: { auto: true, ref: "main", health_timeout_minutes: 1 } });
    await mergedTo(h, ["api/src/orders.ts"]);
    h.docker.nextBuild.api = "broken";
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.store.listOperations("shop")[0].status).toBe("rolled_back");
    expect(await service(h, "api")).toMatchObject({ deployedSha: SHA1, behind: true });
    expect(await service(h, "web")).toMatchObject({ deployedSha: SHA1, behind: false });

    // SHA2..SHA3 changes only web, but api is still at SHA1, so it comes along
    const SHA3 = "3".repeat(40);
    h.docker.git.head = SHA3;
    h.docker.git.diffs.set(`${SHA1}..${SHA3}`, ["api/src/orders.ts", "web/src/cart.tsx"]);
    h.docker.calls = [];
    await h.delivery.tick();
    await h.delivery.idle();
    expect(h.store.listOperations("shop")[0]).toMatchObject({
      kind: "deploy",
      sha: SHA3,
      services: ["api", "web"],
      status: "succeeded",
    });
    expect(h.docker.mutations()).toContainEqual(C("build", "api"));
    expect(h.docker.mutations()).toContainEqual(C("build", "web"));
    expect(await service(h, "api")).toMatchObject({ deployedSha: SHA3, behind: false });
  });

  it("runs fetch_cmd before reading deploy.ref (Lair itself never fetches)", async () => {
    const FETCH = ["git", "-C", "/home/user/shop", "fetch", "--quiet", "origin", "main"];
    const h = setup({ deploy: { auto: true, ref: "origin/main", fetch_cmd: FETCH } });
    h.docker.running("db", "api", "web");
    await h.delivery.tick();
    expect(h.docker.calls.filter((a) => a[0] === "git")).toEqual([
      FETCH,
      ["git", "-C", "/home/user/shop", "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
    ]);
    // command_timeout_seconds (300), not build_timeout_seconds: ticks are serial
    const fetch = h.docker.calls.findIndex((a) => a[3] === "fetch");
    expect(h.docker.options[fetch]?.timeoutMs).toBe(300_000);
  });
});

describe("stops, interrupted deploys and a human taking over", () => {
  it("a deploy interrupted by a stop is rolled back, as a recover operation, when Lair starts again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-delivery-"));
    dirs.push(dir);
    const path = join(dir, "delivery.db");
    const first = setup({}, { store: new DeliveryStore(path) });
    await mergedTo(first, ["api/src/orders.ts"]);
    const before = first.docker.container("api")!.imageId;
    first.docker.nextBuild.api = "broken";
    // stop Lair while the deploy waits for the new container to be healthy
    let rolled = false;
    let stopping: Promise<void> | undefined;
    first.docker.onRun = (argv) => {
      if (argv.includes("--no-build")) rolled = true;
      else if (rolled && !stopping && argv.includes("ps")) stopping = first.delivery.stop();
    };
    await first.delivery.tick();
    await until(() => stopping !== undefined);
    await stopping;
    const [interrupted] = first.store.listOperations("shop");
    expect(interrupted).toMatchObject({ kind: "deploy", status: "interrupted" });
    // left on the image nobody saw healthy
    expect(first.docker.container("api")!.imageId).not.toBe(before);
    first.store.close();

    const store = new DeliveryStore(path);
    stores.push(store);
    const second = setup({}, { store, docker: first.docker });
    second.docker.onRun = undefined;
    second.docker.calls = [];
    await second.delivery.tick();
    await second.delivery.idle();

    const [recovery] = second.store.listOperations("shop");
    expect(recovery).toMatchObject({ kind: "recover", requestedBy: "auto", services: ["api"], status: "rolled_back" });
    expect(second.docker.mutations()).toEqual([
      ["docker", "tag", "shop-local-api:lair-previous", "shop-local-api"],
      C("up", "-d", "--no-deps", "--no-build", "--force-recreate", "api"),
    ]);
    expect(second.docker.container("api")!.imageId).toBe(before);
    expect(second.docker.healthy("api")).toBe(true);
    expect(second.store.getOperation(interrupted.id)!.recoveredBy).toBe(recovery.id);
    expect(await service(second, "api")).toMatchObject({ behind: true });

    // the commit is tried once more on the next tick (the build works this time)
    second.docker.calls = [];
    await second.delivery.tick();
    await second.delivery.idle();
    expect(second.store.listOperations("shop")[0]).toMatchObject({ kind: "deploy", sha: SHA2, services: ["api"], status: "succeeded" });
    expect(second.docker.mutations()).toContainEqual(C("build", "api"));
    expect(await service(second, "api")).toMatchObject({ deployedSha: SHA2, behind: false });

    // and only once: recovery and retry are done
    second.docker.calls = [];
    await second.delivery.tick();
    await second.delivery.idle();
    expect(second.docker.mutations()).toEqual([]);
  });

  it("a stop kills a build in progress instead of waiting for it", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    h.docker.hangBuilds = true;
    const op = started(h.env.request({ kind: "deploy", service: "api", by: "human" }));
    await until(() => h.docker.calls.some((a) => a.includes("build")));

    await h.delivery.stop(); // returns only because the build is killed

    const build = h.docker.calls.findIndex((a) => a.includes("build"));
    expect(h.docker.options[build]?.signal?.aborted).toBe(true);
    expect(h.store.getOperation(op.id)).toMatchObject({ status: "interrupted" });
    expect(h.docker.mutations().some((a) => a.includes("--no-build"))).toBe(false);

    // the killed build left api on its old image: nothing to recover after a restart
    const again = setup({ deploy: { auto: false } }, { store: h.store, docker: h.docker });
    h.docker.calls = [];
    await again.delivery.tick();
    await again.delivery.idle();
    expect(h.docker.mutations()).toEqual([]);
    expect(h.store.getOperation(op.id)!.recoveredBy).toBe("nothing to recover");
    expect(h.store.listOperations("shop").map((o) => o.kind)).toEqual(["deploy"]);
  });

  it("a Down during a deploy holds and stops the service at once, and the rollback doesn't start it again", async () => {
    const h = setup();
    await mergedTo(h, ["api/src/orders.ts"]);
    const before = h.docker.container("api")!.imageId;
    h.docker.nextBuild.api = "broken";
    let rolled = false;
    let down: RequestResult | undefined;
    h.docker.onRun = (argv) => {
      if (argv.includes("--no-build")) rolled = true;
      else if (rolled && !down && argv.includes("ps")) {
        down = h.env.request({ kind: "down", service: "api", by: "human", reason: "stop it now" });
      }
    };
    await h.delivery.tick();
    await until(() => down !== undefined);
    await h.delivery.idle();

    expect(down).toMatchObject({ ok: true });
    const mutations = h.docker.mutations();
    expect(mutations).toContainEqual(C("stop", "api"));
    expect(mutations).toContainEqual(["docker", "tag", "shop-local-api:lair-previous", "shop-local-api"]);
    expect(mutations).not.toContainEqual(C("up", "-d", "--no-deps", "--no-build", "--force-recreate", "api"));
    expect(h.docker.container("api")!.state).toBe("exited");
    // a later Up starts the image that ran before the deploy
    expect(h.docker.imageOf("api")).toBe(before);
    const deploy = h.store.listOperations("shop").find((o) => o.kind === "deploy")!;
    expect(deploy.status).toBe("rolled_back");
    expect(deploy.error).toContain("not started (held)");
  });

  it("a human Up of a crash-looping service recreates it, undoing a playbook's restart=no", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    await h.delivery.tick();
    for (let i = 0; i < 2; i++) {
      h.docker.crash("api", 2);
      h.clock.advance(2 * MIN);
      await h.delivery.tick();
    }
    // what the watchdog's crash_loop playbook runs
    await h.docker.run(["docker", "update", "--restart=no", "shop-local-api-1"]);
    expect(h.docker.container("api")).toMatchObject({ restartPolicy: "no", state: "exited" });
    h.docker.calls = [];

    const op = await run(h, { kind: "up", service: "api", by: "human" });

    expect(op.status).toBe("succeeded");
    expect(h.docker.mutations()).toEqual([C("up", "-d", "--no-deps", "--force-recreate", "api")]);
    expect(h.docker.container("api")).toMatchObject({ restartPolicy: "unless-stopped", state: "running", restartCount: 0 });
  });
});

describe("deploy edge cases", () => {
  it("a human environment Deploy skips held services instead of refusing", async () => {
    const h = setup({ deploy: { auto: false } });
    h.docker.running("db", "api", "web");
    await run(h, { kind: "down", service: "api", by: "human", reason: "profiling" });
    const webImage = h.docker.container("web")!.imageId;
    h.docker.calls = [];

    const op = await run(h, { kind: "deploy", by: "human" });

    expect(op.status).toBe("succeeded");
    expect(skipped(op)).toEqual([{ service: "api", detail: "held: profiling" }]);
    expect(h.docker.mutations()).toEqual([
      ["docker", "tag", webImage, "shop-local-web:lair-previous"],
      C("build", "web"),
      C("up", "-d", "--no-deps", "--no-build", "web"),
    ]);
  });

  it("refuses to deploy a service that shares its image with another one", async () => {
    const h = setup(
      { deploy: { auto: false }, services: { api: { build: true }, worker: { build: true } }, start_order: ["api", "worker"] },
      { fake: { api: { imageRef: "example/app" }, worker: { imageRef: "example/app" } } },
    );
    h.docker.running("api", "worker");
    const op = await run(h, { kind: "deploy", service: "api", by: "human" });
    expect(op.status).toBe("failed");
    expect(op.error).toBe(
      "services api and worker share the image example/app: a rollback of one would move the other's image too, so Lair doesn't deploy it",
    );
    expect(h.docker.mutations()).toEqual([]);
  });

  it("redacts credentials in stored commands and in the log lines it shows", async () => {
    const secret = ["s3cr3t", "value"].join("-");
    const remote = `https://deploy:${secret}@git.example.com/shop.git`;
    const h = setup({ deploy: { auto: true, prepare_cmd: ["git", "-C", "/home/user/shop", "pull", remote, "{sha}"] } });
    await mergedTo(h, ["api/src/orders.ts"]);
    h.docker.crash("db", 1, `FATAL: cannot connect to postgres://shop:${secret}@db:5432/shop`);
    h.docker.crash("db", 1, `DB_PASSWORD=${secret} denied`);

    await h.delivery.tick();
    await h.delivery.idle();

    const stored = JSON.stringify(h.store.listOperations("shop"));
    expect(stored).not.toContain(secret);
    expect(stored).toContain("https://***:***@git.example.com/shop.git");
    const db = await service(h, "db");
    expect(JSON.stringify(db)).not.toContain(secret);
    expect(db.lastErrorLines).toContain("FATAL: cannot connect to postgres://***:***@db:5432/shop");
    expect(db.lastErrorLines).toContain("DB_PASSWORD=*** denied");
  });

  it("matches a held service's container by the names last read: after a restart, with a custom container_name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-delivery-"));
    dirs.push(dir);
    const path = join(dir, "delivery.db");
    const fake = { db: { healthcheck: true }, api: { url: "http://localhost:8080/health", containerName: "orders-api" }, web: {} };
    const first = setup({ deploy: { auto: false } }, { store: new DeliveryStore(path), fake });
    first.docker.running("db", "api", "web");
    await first.delivery.tick();
    await run(first, { kind: "down", service: "api", by: "human", reason: "debugging" });
    await first.delivery.stop();
    first.store.close();

    const store = new DeliveryStore(path);
    stores.push(store);
    const second = setup({ deploy: { auto: false } }, { store, docker: first.docker });
    expect(second.delivery.heldReason("orders-api")).toBe(
      "container orders-api is service api of delivery environment local, held by a human: debugging",
    );
    expect(second.delivery.heldReason("shop-local-db-1")).toBeNull();
  });
});

describe("a Down racing a start never leaves the held service running", () => {
  const same = (a: string[], b: string[]) => a.join(" ") === b.join(" ");

  it("a Down that lands while the deploy's roll is starting the service stops it again", async () => {
    const h = setup();
    await mergedTo(h, ["api/src/orders.ts"]);
    const ROLL = C("up", "-d", "--no-deps", "--no-build", "api");
    // the roll's `up` starts the container only when released: after the Down's stop
    const release = h.docker.delay((a) => same(a, ROLL), { effect: "on release" });
    await h.delivery.tick();
    await until(() => h.docker.calls.some((a) => same(a, ROLL)));

    expect(h.env.request({ kind: "down", service: "api", by: "human", reason: "now" }).ok).toBe(true);
    await until(() => h.docker.calls.some((a) => same(a, C("stop", "api"))));
    expect(h.docker.container("api")!.state).toBe("exited");
    release();
    await h.delivery.idle();

    expect(h.docker.container("api")!.state).toBe("exited");
    const deploy = h.store.listOperations("shop").find((o) => o.kind === "deploy")!;
    expect(deploy.steps.filter((s) => s.action === "stop").map((s) => s.argv)).toEqual([C("stop", "api")]);
  });

  it("a Down that lands while an Up is starting the service stops it again, and the Up goes on", async () => {
    const h = setup({ deploy: { auto: false } });
    const release = h.docker.delay((a) => same(a, UP("api")), { effect: "on release" });
    started(h.env.request({ kind: "up", by: "human" }));
    await until(() => h.docker.calls.some((a) => same(a, UP("api"))));

    expect(h.env.request({ kind: "down", service: "api", by: "human", reason: "now" }).ok).toBe(true);
    await until(() => h.docker.calls.some((a) => same(a, C("stop", "api"))));
    release();
    await h.env.idle();

    expect(h.docker.container("api")!.state).toBe("exited");
    expect(h.docker.container("web")!.state).toBe("running");
  });
});

describe("a deploy by hand", () => {
  it("counts as deployed at the latest commit seen, so a service it fixed is no longer behind", async () => {
    const h = setup({ deploy: { auto: true, ref: "main", health_timeout_minutes: 1 } });
    await mergedTo(h, ["api/src/orders.ts"]);
    h.docker.nextBuild.api = "broken";
    await h.delivery.tick();
    await h.delivery.idle();
    expect(await service(h, "api")).toMatchObject({ deployedSha: SHA1, behind: true });

    const op = await run(h, { kind: "deploy", service: "api", by: "human" });

    expect(op.status).toBe("succeeded");
    expect(await service(h, "api")).toMatchObject({ deployedSha: SHA2, behind: false });
  });
});
