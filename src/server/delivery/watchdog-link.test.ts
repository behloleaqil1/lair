/**
 * Delivery and the watchdog wired as in src/server/index.ts (the
 * WatchdogManager gets the DeliveryManager as `services`): the watchdog's
 * crash_loop detector turns the crash loops delivery marked into breaches
 * that its crash_loop playbook acts on or escalates, and a held service's
 * container is left alone by the detector and refused by the act guard.
 * Only docker and the clock are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { WatchdogManager } from "../watchdog/service.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { FakeClock, FakeDocker, MIN } from "./fake-docker.js";
import { DeliveryManager } from "./service.js";

const STOP_RESTARTS = ["docker", "update", "--restart=no", "{container}"];
const ACT = {
  mode: "act",
  actions: { stop_container_restarts: STOP_RESTARTS },
  playbooks: { crash_loop: { act: true } },
};
const UPDATE = ["docker", "update", "--restart=no", "shop-local-api-1"];

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function setup(watchdog: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "lair-delivery-watchdog-"));
  mkdirSync(join(dir, "agents"));
  const docker = new FakeDocker("shop-local", { db: { healthcheck: true }, api: {}, web: {} });
  const clock = new FakeClock();
  const config: ProjectConfig = {
    name: "Shop",
    repo: dir,
    github: "example/shop",
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    inbox_file: join(dir, "inbox.md"),
    delivery: {
      enabled: true,
      environments: {
        local: {
          compose_files: ["./deploy/compose.yaml"],
          project_name: "shop-local",
          services: { db: null, api: { build: true, paths: ["api/"] }, web: null },
          crash_loop: { max_restarts: 3, window_minutes: 10 },
        },
      },
    },
    watchdog: { enabled: true, ...watchdog },
  };
  const delivery = new DeliveryManager({ dbPath: ":memory:", probes: { runner: docker, clock, http: docker.http } });
  delivery.load([{ name: "shop", config }]);
  const watchdogs = new WatchdogManager({
    dbPath: ":memory:",
    probes: { processes: { list: async () => [] }, fs: new NodeFileSystem(), runner: docker, clock },
    services: delivery,
  });
  watchdogs.load([{ name: "shop", config }]);
  cleanup = async () => {
    await watchdogs.stop();
    await delivery.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  const project = delivery.get("shop")!;
  return {
    docker,
    clock,
    delivery: project,
    env: project.environment("local")!,
    wd: watchdogs.get("shop")!,
    store: watchdogs.getStore()!,
    inbox: join(dir, "inbox.md"),
  };
}

type Harness = ReturnType<typeof setup>;

/** api's restart count rises by 4 within 4 minutes, over three delivery ticks */
async function deliveryMarksCrashLoop(h: Harness): Promise<void> {
  h.docker.running("db", "api", "web");
  await h.delivery.tick();
  for (let i = 0; i < 2; i++) {
    h.docker.crash("api", 2);
    h.clock.advance(2 * MIN);
    await h.delivery.tick();
  }
  expect(h.delivery.crashLoops()).toMatchObject([{ container: "shop-local-api-1", service: "api", restarts: 4 }]);
}

describe("delivery's crash loops feed the watchdog's crash_loop playbook", () => {
  it("act: the playbook stops the container's restarts with the configured command", async () => {
    const h = setup(ACT);
    await deliveryMarksCrashLoop(h);
    h.docker.calls = [];

    await h.wd.tick();

    expect(h.docker.calls).toEqual([UPDATE]);
    expect(h.docker.container("api")).toMatchObject({ restartPolicy: "no", state: "exited" });
    const [breach, ...others] = h.store.listBreaches("shop");
    expect(others).toEqual([]);
    expect(breach).toMatchObject({ detector: "crash_loop", key: "crash_loop:shop-local-api-1", status: "open" });
    expect(breach.summary).toContain("Service api (delivery environment local): container shop-local-api-1 restarted 4 times");
    expect(breach.evidence).toContain("log: Error: connect ECONNREFUSED localhost:5432");
    expect(breach.vars).toEqual({ container: "shop-local-api-1", restarts: "4" });
    const [run] = h.store.listRuns("shop");
    expect(run).toMatchObject({ playbookId: "crash_loop", mode: "act", status: "succeeded", outcome: "acted" });
    expect(run.steps.map((s) => `${s.type}:${s.status}`)).toEqual(["diagnose:succeeded", "act:succeeded", "verify:succeeded"]);
    expect(run.steps[1].command?.argv).toEqual(UPDATE);
    expect(h.store.sloStatus("shop").find((s) => s.detector === "crash_loop")?.state).toBe("breached");
  });

  it("observe: escalates once to the inbox with the last error lines and the command it would run", async () => {
    const h = setup({ actions: { stop_container_restarts: STOP_RESTARTS } });
    await deliveryMarksCrashLoop(h);
    h.docker.calls = [];

    await h.wd.tick();
    await h.wd.tick();

    expect(h.docker.calls).toEqual([]);
    const inbox = readFileSync(h.inbox, "utf-8");
    expect(inbox.split("\n").filter((line) => line.startsWith("- OWNER? "))).toHaveLength(1);
    expect(inbox).toContain("(crash_loop). Not acting: watchdog.mode is observe.");
    expect(inbox).toContain("  - evidence: log: Error: connect ECONNREFUSED localhost:5432");
    expect(inbox).toContain("  - would run: docker update --restart=no shop-local-api-1");
  });

  it("the breach closes once delivery's mark is gone", async () => {
    const h = setup(ACT);
    await deliveryMarksCrashLoop(h);
    await h.wd.tick();
    // a human restarts the service by name: delivery clears the mark
    const restart = h.env.request({ kind: "restart", service: "api", by: "human" });
    expect(restart.ok).toBe(true);
    await h.env.idle();
    await h.wd.tick();
    expect(h.store.listBreaches("shop")[0]).toMatchObject({ status: "resolved", resolution: "cleared" });
  });
});

describe("the watchdog leaves a held service alone", () => {
  it("a crash loop on a held service is not reported, and no command runs on it", async () => {
    const h = setup(ACT);
    await deliveryMarksCrashLoop(h);
    expect(h.env.request({ kind: "down", service: "api", by: "human", reason: "reading its logs" }).ok).toBe(true);
    await h.env.idle();
    h.docker.calls = [];

    await h.wd.tick();

    expect(h.docker.calls).toEqual([]);
    expect(h.store.listBreaches("shop")).toEqual([]);
    expect(h.store.sloStatus("shop").find((s) => s.detector === "crash_loop")?.detail).toBe(
      "held, left alone: shop-local-api-1",
    );
  });

  it("a held service's container listed in watchdog.containers is not even inspected", async () => {
    const h = setup({ ...ACT, containers: [{ name: "shop-local-api-1" }] });
    h.docker.running("db", "api", "web");
    expect(h.env.request({ kind: "down", service: "api", by: "human", reason: "reading its logs" }).ok).toBe(true);
    await h.env.idle();
    h.docker.calls = [];

    for (let i = 0; i < 3; i++) {
      await h.wd.tick();
      h.clock.advance(2 * MIN);
    }

    expect(h.docker.calls).toEqual([]);
    expect(h.store.listBreaches("shop")).toEqual([]);
  });

  it("the act guard refuses when the service is held between the diagnose and the act step", async () => {
    // The watchdog samples the container itself here (watchdog.containers);
    // delivery has not read the environment yet, so the container is
    // matched to its service by Compose's naming
    const h = setup({ ...ACT, containers: [{ name: "shop-local-api-1", max_restarts: 3, window_minutes: 10 }] });
    h.docker.running("db", "api", "web");
    await h.wd.tick();
    h.docker.crash("api", 2);
    h.clock.advance(2 * MIN);
    await h.wd.tick();
    h.docker.crash("api", 2);
    h.clock.advance(2 * MIN);

    // inspect #1 of this tick detects the loop; #2 is the playbook's diagnose
    let inspects = 0;
    h.docker.onRun = (argv) => {
      if (argv[1] === "inspect" && ++inspects === 2) {
        h.env.request({ kind: "down", service: "api", by: "human", reason: "taking over by hand" });
      }
    };
    await h.wd.tick();
    await h.env.idle();

    expect(h.docker.calls).not.toContainEqual(UPDATE);
    const [run] = h.store.listRuns("shop");
    expect(run.steps.map((s) => `${s.type}:${s.status}`)).toEqual(["diagnose:succeeded", "act:failed", "verify:skipped"]);
    expect(run.steps[1].error).toBe(
      "refused: container shop-local-api-1 is service api of delivery environment local, held by a human: taking over by hand",
    );
    expect(run.steps[1].command).toBeUndefined();
  });
});
