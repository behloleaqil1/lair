/**
 * Live config reload, through the production code: a real projects/ dir
 * watched by the reloader as src/server/index.ts wires it (serverModules),
 * the real delivery and watchdog managers, and real file writes. Only
 * docker (FakeDocker) and the clock are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { loadProjectConfig } from "../config.js";
import { EventBus } from "../core/event-bus.js";
import { FakeClock, FakeDocker } from "../delivery/fake-docker.js";
import { DeliveryManager } from "../delivery/service.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { WatchdogManager } from "../watchdog/service.js";
import { problemText } from "../../client/server-controls";
import { ConfigReloader, fingerprint, serverModules, type ReloadableModule } from "./index.js";
import { UNREAD_KEYS } from "./modules.js";

const DEBOUNCE_MS = 200;
const quiet = { log: () => undefined, warn: () => undefined };

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const watchdog = (interval: number) => ({ enabled: true, interval_seconds: interval });
const delivery = (interval: number, enabled = true) => ({
  enabled,
  interval_seconds: interval,
  environments: {
    local: { compose_files: ["./deploy/compose.yaml"], project_name: "shop-local", services: { web: null } },
  },
});

interface Blocks {
  watchdog?: unknown;
  delivery?: unknown;
  [key: string]: unknown;
}

interface SetupOptions {
  deliveryDb?: (root: string) => string;
  /** Start from projects/local/shop.yaml, with a public projects/shop.yaml of these blocks beside it */
  publicBeside?: Blocks;
  /** Runs after the modules loaded the file, before the watcher starts */
  beforeWatch?: (write: (b: Blocks | string) => void) => void;
}

async function setup(blocks: Blocks, options: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "lair-reload-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "local"), { recursive: true });
  mkdirSync(join(root, "agents"));
  const publicFile = join(projects, "shop.yaml");
  const localFile = join(projects, "local", "shop.yaml");
  const file = options.publicBeside ? localFile : publicFile;
  const yaml = (b: Blocks) =>
    stringify({
      name: "Shop",
      repo: root,
      github: "example/shop",
      queue_file: join(root, "queue.md"),
      agents_dir: join(root, "agents"),
      gates_dir: join(root, "gates"),
      inbox_file: join(root, "inbox.md"),
      machines: {},
      ...b,
    });
  const writeTo = (path: string, b: Blocks | string) => writeFileSync(path, typeof b === "string" ? b : yaml(b));
  const write = (b: Blocks | string) => writeTo(file, b);
  write(blocks);
  if (options.publicBeside) writeTo(publicFile, options.publicBeside);

  const docker = new FakeDocker("shop-local", { web: {} });
  const clock = new FakeClock();
  const deliveries = new DeliveryManager({
    dbPath: options.deliveryDb?.(root) ?? ":memory:",
    probes: { runner: docker, clock, http: docker.http },
  });
  const watchdogs = new WatchdogManager({
    dbPath: ":memory:",
    probes: { processes: { list: async () => [] }, fs: new NodeFileSystem(), runner: docker, clock },
    services: deliveries,
  });
  const initial = [{ name: "shop", config: loadProjectConfig("shop", projects) }];
  deliveries.load(initial);
  watchdogs.load(initial);
  deliveries.start();
  watchdogs.start();
  options.beforeWatch?.(write);

  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (event) => {
    events.push(event);
  });
  const reloader = new ConfigReloader({
    modules: serverModules({ delivery: deliveries, watchdogs }),
    initial,
    projectsDir: projects,
    debounceMs: DEBOUNCE_MS,
    events: bus,
    cwd: root,
    log: quiet,
  });
  reloader.start();
  await reloader.ready();
  cleanup = async () => {
    await reloader.stop();
    await watchdogs.stop();
    await deliveries.stop();
    rmSync(root, { recursive: true, force: true });
  };
  const reloads = (module?: string) =>
    events.filter((e) => e.type === "config.reloaded" && (module === undefined || e.data.module === module));
  return {
    root,
    write,
    writeTo,
    publicFile,
    localFile,
    docker,
    deliveries,
    watchdogs,
    reloader,
    events,
    reloads,
  };
}

describe("live config reload", () => {
  it("reloads the module whose block changed, and leaves the others running", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;

    h.write({ watchdog: watchdog(120), delivery: delivery(30) });
    await waitFor("the watchdog reload", () => h.watchdogs.get("shop") !== oldWatchdog);
    await h.reloader.settled();

    const watchdogNow = h.watchdogs.get("shop")!;
    expect(watchdogNow.settings.intervalSeconds).toBe(120);
    expect(watchdogNow.running).toBe(true);
    expect(oldWatchdog.running).toBe(false);
    // Delivery's block did not change: the same instance, still running
    expect(h.deliveries.get("shop")).toBe(oldDelivery);
    expect(oldDelivery.running).toBe(true);
    expect(h.reloads().map((e) => e.data)).toEqual([{ project: "shop", file: "projects/shop.yaml", module: "watchdog" }]);
    expect(h.reloader.status()).toMatchObject({ watching: true, problems: [], recent: [{ module: "watchdog" }] });
  });

  it("reloads only delivery when only its block changed", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;

    h.write({ watchdog: watchdog(60), delivery: delivery(45) });
    await waitFor("the delivery reload", () => h.deliveries.get("shop") !== oldDelivery);
    await h.reloader.settled();

    expect(h.deliveries.get("shop")!.settings.intervalSeconds).toBe(45);
    expect(h.deliveries.get("shop")!.running).toBe(true);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(oldWatchdog.running).toBe(true);
    expect(h.reloads().map((e) => e.data.module)).toEqual(["delivery"]);
  });

  it("keeps the old config running on an invalid change, says why, and takes the fixed file", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;

    // The watchdog's own parser refuses it
    h.write({ watchdog: watchdog(1), delivery: delivery(30) });
    await waitFor("the problem", () => h.reloader.status().problems.length > 0);
    await h.reloader.settled();
    const [problem] = h.reloader.status().problems;
    expect(problem).toMatchObject({ project: "shop", file: "projects/shop.yaml", previousRunning: true });
    expect(problem.error).toContain("watchdog.interval_seconds");
    expect(problemText(problem)).toBe(
      `projects/shop.yaml has an error; the previous config is still running: ${problem.error}`,
    );
    expect(h.events.filter((e) => e.type === "config.invalid").map((e) => e.data)).toEqual([
      { project: "shop", file: "projects/shop.yaml", error: problem.error, previousRunning: true },
    ]);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(oldWatchdog.running).toBe(true);
    expect(oldWatchdog.settings.intervalSeconds).toBe(60);
    expect(h.reloads()).toEqual([]);

    // Not YAML at all
    h.write("name: Shop\nwatchdog: [\n");
    await waitFor("the YAML error", () => h.events.filter((e) => e.type === "config.invalid").length === 2);
    expect(h.reloader.status().problems).toHaveLength(1);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);

    // Fixed: the problem is gone and the new config runs
    h.write({ watchdog: watchdog(90), delivery: delivery(30) });
    await waitFor("the reload", () => h.watchdogs.get("shop") !== oldWatchdog);
    await h.reloader.settled();
    expect(h.reloader.status().problems).toEqual([]);
    expect(h.watchdogs.get("shop")!.settings.intervalSeconds).toBe(90);
  });

  it("reloads once for rapid successive writes, with the last one", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;

    for (const interval of [61, 62, 63, 64, 65]) {
      h.write({ watchdog: watchdog(interval), delivery: delivery(30) });
      await sleep(30);
    }
    await waitFor("the reload", () => h.watchdogs.get("shop") !== oldWatchdog);
    await sleep(DEBOUNCE_MS * 3);
    await h.reloader.settled();

    expect(h.reloads()).toHaveLength(1);
    expect(h.watchdogs.get("shop")!.settings.intervalSeconds).toBe(65);
  });

  it("waits for delivery's operation in progress before starting the new config, and never overlaps", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const old = h.deliveries.get("shop")!;
    const env = old.environment("local")!;
    const isUp = (argv: string[]) => argv.includes("up");
    const release = h.docker.delay(isUp);
    const started = env.request({ kind: "up", by: "human" });
    if (!started.ok) throw new Error(started.error);
    await waitFor("docker compose up", () => h.docker.calls.some(isUp));
    const upOptions = h.docker.options[h.docker.calls.findIndex(isUp)];

    h.write({ watchdog: watchdog(60), delivery: delivery(40) });
    await waitFor("the drain", () => !old.running);
    // A second change while the first reload waits: applied after it, never beside it
    h.write({ watchdog: watchdog(60), delivery: delivery(45) });
    await sleep(DEBOUNCE_MS * 3);

    // Still draining: the old instance answers, refuses new operations, and its command is not killed
    const store = h.deliveries.getStore()!;
    expect(h.deliveries.get("shop")).toBe(old);
    expect(store.getOperation(started.operation.id)!.status).toBe("running");
    const refused = env.request({ kind: "restart", by: "human" });
    expect(refused).toMatchObject({ ok: false, code: 409 });
    expect(refused.ok ? "" : refused.error).toContain("reloading");
    expect(upOptions?.signal?.aborted).toBe(false);
    expect(h.reloads()).toEqual([]);

    release();
    await waitFor("the new config", () => h.deliveries.get("shop")?.settings.intervalSeconds === 45);
    await h.reloader.settled();

    // The operation ran to the end on the old config; nothing marked it interrupted
    expect(store.getOperation(started.operation.id)!.status).toBe("succeeded");
    expect(h.reloads("delivery")).toHaveLength(2);
    expect(h.deliveries.get("shop")!.running).toBe(true);
    expect(h.reloads("watchdog")).toEqual([]);
  });

  it("starts the previous config again when the new one can't start, so nothing is half-started", async () => {
    // Delivery's store can't be opened: its directory is a file
    const h = await setup(
      { watchdog: watchdog(60), delivery: delivery(30, false) },
      {
        deliveryDb: (root) => {
          writeFileSync(join(root, "blocker"), "");
          return join(root, "blocker", "delivery.db");
        },
      },
    );
    const oldWatchdog = h.watchdogs.get("shop")!;
    expect(h.deliveries.get("shop")).toBeUndefined();

    h.write({ watchdog: watchdog(60), delivery: delivery(30, true) });
    await waitFor("the problem", () => h.reloader.status().problems.length > 0);
    await h.reloader.settled();

    const [problem] = h.reloader.status().problems;
    expect(problem.previousRunning).toBe(true);
    expect(problem.error).toMatch(/^delivery could not start with the new config \([\s\S]+\); it runs its previous config again$/);
    expect(h.deliveries.get("shop")).toBeUndefined();
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(h.reloads()).toEqual([]);
  });

  it("a save back to the old config while a reload runs is applied after it (the file wins)", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const old = h.deliveries.get("shop")!;
    const isUp = (argv: string[]) => argv.includes("up");
    const release = h.docker.delay(isUp);
    const started = old.environment("local")!.request({ kind: "up", by: "human" });
    if (!started.ok) throw new Error(started.error);
    await waitFor("docker compose up", () => h.docker.calls.some(isUp));

    // Save A: delivery drains for as long as the operation runs
    h.write({ watchdog: watchdog(60), delivery: delivery(40) });
    await waitFor("the drain", () => !old.running);
    // Save the original back while A is still being applied
    h.write({ watchdog: watchdog(60), delivery: delivery(30) });
    await sleep(DEBOUNCE_MS * 3);
    release();
    await waitFor("two reloads", () => h.reloads("delivery").length === 2);
    await h.reloader.settled();

    // What runs is what the file says, not A
    expect(h.deliveries.get("shop")!.settings.intervalSeconds).toBe(30);
    expect(h.deliveries.get("shop")!.running).toBe(true);
    expect(h.reloader.status().problems).toEqual([]);
  });

  it("deleting projects/local/x.yaml does not apply the public projects/x.yaml: the previous config keeps running", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) }, { publicBeside: { watchdog: watchdog(300) } });
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;

    rmSync(h.localFile);
    await waitFor("the problem", () => h.reloader.status().problems.length > 0);
    await h.reloader.settled();
    expect(h.reloader.status().problems).toEqual([
      expect.objectContaining({
        project: "shop",
        file: "projects/local/shop.yaml",
        previousRunning: true,
        error:
          "the file was removed, so projects/shop.yaml would apply instead; Lair keeps running the previous config until it restarts",
      }),
    ]);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(oldWatchdog.settings.intervalSeconds).toBe(60);
    expect(h.deliveries.get("shop")).toBe(oldDelivery);
    expect(h.reloads()).toEqual([]);

    // Put back: it runs again, and a change to it is taken
    h.writeTo(h.localFile, { watchdog: watchdog(90), delivery: delivery(30) });
    await waitFor("the reload", () => h.watchdogs.get("shop") !== oldWatchdog);
    await h.reloader.settled();
    expect(h.reloader.status().problems).toEqual([]);
    expect(h.watchdogs.get("shop")!.settings.intervalSeconds).toBe(90);
  });

  it("a new projects/local/x.yaml does not take over from the running projects/x.yaml until a restart", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;

    h.writeTo(h.localFile, { watchdog: watchdog(300), delivery: delivery(30) });
    await waitFor("the problem", () => h.reloader.status().problems.length > 0);
    await h.reloader.settled();
    expect(h.reloader.status().problems).toEqual([
      expect.objectContaining({
        file: "projects/shop.yaml",
        error: "projects/local/shop.yaml now takes its place; Lair keeps running projects/shop.yaml until it restarts",
      }),
    ]);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(h.reloads()).toEqual([]);
  });

  it("a removed project file keeps the previous config running and says so", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;

    rmSync(h.publicFile);
    await waitFor("the problem", () => h.reloader.status().problems.length > 0);
    await h.reloader.settled();
    const [problem] = h.reloader.status().problems;
    expect(problem).toMatchObject({ file: "projects/shop.yaml", previousRunning: true });
    expect(problemText(problem)).toBe(
      "projects/shop.yaml has an error; the previous config is still running: the file was removed; Lair keeps running the previous config until it restarts",
    );
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);
    expect(oldWatchdog.running).toBe(true);
    expect(h.deliveries.get("shop")).toBe(oldDelivery);
    expect(oldDelivery.running).toBe(true);
    expect(h.reloads()).toEqual([]);
  });

  it("sees a change made between the startup load and the watcher being ready", async () => {
    const h = await setup(
      { watchdog: watchdog(60), delivery: delivery(30) },
      { beforeWatch: (write) => write({ watchdog: watchdog(75), delivery: delivery(30) }) },
    );
    await waitFor("the reload", () => h.watchdogs.get("shop")?.settings.intervalSeconds === 75);
    await h.reloader.settled();
    expect(h.reloads().map((e) => e.data.module)).toEqual(["watchdog"]);
  });

  it("reloads nothing for keys no module reads, and every module for one they may read", async () => {
    const h = await setup({ watchdog: watchdog(60), delivery: delivery(30) });
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;

    h.write({ watchdog: watchdog(60), delivery: delivery(30), merge_bar: { required_steps: ["lint"], require_review: true } });
    await sleep(DEBOUNCE_MS * 3);
    await h.reloader.settled();
    expect(h.reloads()).toEqual([]);
    expect(h.watchdogs.get("shop")).toBe(oldWatchdog);

    h.write({ watchdog: watchdog(60), delivery: delivery(30), read_only: true });
    await waitFor("both reloads", () => h.reloads().length === 2);
    await h.reloader.settled();
    expect(h.reloads().map((e) => e.data.module).sort()).toEqual(["delivery", "watchdog"]);
    expect(h.deliveries.get("shop")).not.toBe(oldDelivery);
    expect(h.deliveries.get("shop")!.readOnly).toBe(true);
  });
});

describe("UNREAD_KEYS", () => {
  /** The modules' code and the helpers they read a project config with */
  const SOURCES = [
    ...["watchdog", "delivery", "gates", "review", "agents", "triage", "placement", "cloud", "planner", "tracker"].map((d) => join("src", "server", d)),
    join("src", "server", "services", "adapters.ts"),
    join("src", "server", "services", "dragon-registry.ts"),
  ];
  const files = (path: string): string[] =>
    statSync(path).isDirectory()
      ? readdirSync(path).flatMap((f) => (f === "testing" ? [] : files(join(path, f))))
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];

  it("lists only keys no module reads", () => {
    const code = SOURCES.flatMap(files).map((f) => [f, readFileSync(f, "utf-8")] as const);
    expect(code.length).toBeGreaterThan(20);
    const reads: string[] = [];
    for (const key of UNREAD_KEYS) {
      const access = new RegExp(`(config|project)\\??\\.${key}\\b|\\[["']${key}["']\\]`);
      for (const [file, text] of code) if (access.test(text)) reads.push(`${key} in ${file}`);
    }
    expect(reads).toEqual([]);
  });
});

describe("fingerprint", () => {
  const modules = serverModules({
    delivery: new DeliveryManager({ dbPath: ":memory:" }),
    watchdogs: new WatchdogManager({ dbPath: ":memory:" }),
  });
  const owned = new Set(modules.flatMap((m) => m.blocks));
  const [deliveryModule, watchdogModule] = modules;
  const base: Record<string, unknown> = {
    name: "Shop",
    repo: "/r",
    watchdog: { enabled: true, mode: "observe" },
    delivery: { enabled: false },
  };
  const fp = (m: ReloadableModule, config: Record<string, unknown>, keys: ReadonlySet<string> = owned) =>
    fingerprint(m, config as unknown as ProjectConfig, keys);

  it("ignores key order and other modules' blocks", () => {
    const reordered = { delivery: { enabled: false }, watchdog: { mode: "observe", enabled: true }, repo: "/r", name: "Shop" };
    expect(fp(watchdogModule, reordered)).toBe(fp(watchdogModule, base));
    expect(fp(watchdogModule, { ...base, delivery: { enabled: true } })).toBe(fp(watchdogModule, base));
    expect(fp(deliveryModule, { ...base, delivery: { enabled: true } })).not.toBe(fp(deliveryModule, base));
  });

  it("changes for every module when a key no module owns changes", () => {
    for (const m of modules) {
      expect(fp(m, { ...base, read_only: true })).not.toBe(fp(m, base));
    }
  });

  it("covers the blocks a module reads besides its own (agents reads watchdog)", () => {
    const [agents] = serverModules({ agents: {} as never });
    const all = new Set(["agents", "watchdog"]);
    expect(fp(agents, { ...base, watchdog: { enabled: false } }, all)).not.toBe(fp(agents, base, all));
    expect(fp(watchdogModule, { ...base, agents: { enabled: true } }, all)).toBe(fp(watchdogModule, base, all));
  });
});
