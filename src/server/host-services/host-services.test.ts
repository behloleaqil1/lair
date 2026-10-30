/**
 * Host services acceptance tests.
 *
 * Only the system boundary is fake: a CommandRunner that answers the probe
 * and start commands; and a Clock. Every test runs the real module through
 * HostServicesManager: config parsing, probes, starts with backoff, lane
 * holds, decisions, and the status.
 *
 * Coverage (from the brief):
 * - A probe fails then passes after `start`: service recovery
 * - Lanes are held then released: neededBy lanes
 * - A start that keeps failing -> one decision: max attempts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import type { DecisionProducer, DecisionResolution, RaiseDecisionInput, WithdrawInput } from "../decisions/types.js";
import { parseHostServicesConfig } from "./config.js";
import {
  HostServices,
  HostServicesManager,
  type HostServicesOptions,
  type ProjectEntry,
} from "./service.js";
import { HostServicesStore } from "./store.js";
import type { CommandOutput, CommandRunner, Clock, HostServicesProbes, RunOptions } from "./probes.js";
import type { HostServicesSettings, LaneHold, ServiceStatus } from "./types.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SEC = 1_000;

class FakeClock implements Clock {
  t = NOW;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    return Promise.resolve();
  }
}


interface ServiceWorld {
  /** Service name -> { up: boolean; startWorks: boolean } */
  services: Map<string, { up: boolean; startWorks: boolean }>;
}

class FakeRunner implements CommandRunner {
  calls: { argv: string[]; timeoutMs?: number }[] = [];

  constructor(
    private world: ServiceWorld,
    private clock: FakeClock,
  ) {}

  async run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    this.calls.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    const [cmd] = argv;
    const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): CommandOutput => ({ code: 1, stdout: "", stderr });

    if (cmd?.startsWith("probe-")) {
      const service = cmd.slice("probe-".length);
      const state = this.world.services.get(service);
      return state?.up ? ok("ok") : fail("service down");
    }
    if (cmd?.startsWith("start-")) {
      const service = cmd.slice("start-".length);
      const state = this.world.services.get(service);
      if (state?.startWorks) {
        state.up = true;
        return ok("started");
      }
      return fail("start failed");
    }
    return fail(`unknown command: ${cmd}`);
  }

  probeCalls(): string[][] {
    return this.calls.filter((c) => c.argv[0]?.startsWith("probe-")).map((c) => c.argv);
  }

  startCalls(): string[][] {
    return this.calls.filter((c) => c.argv[0]?.startsWith("start-")).map((c) => c.argv);
  }
}


/** A fake decision producer that tracks raises and withdraws. */
class FakeDecisions implements DecisionProducer {
  raised: RaiseDecisionInput[] = [];
  withdrawn: { id: string; input: WithdrawInput }[] = [];
  private nextId = 1;

  async raise(input: RaiseDecisionInput): Promise<{ created: boolean; decision: { id: string } }> {
    this.raised.push(input);
    const id = `decision-${this.nextId++}`;
    return { created: true, decision: { id } };
  }

  async withdraw(id: string, input: WithdrawInput): Promise<void> {
    this.withdrawn.push({ id, input });
  }

  onResolved(module: string, callback: (r: DecisionResolution) => void): () => void {
    return () => {};
  }
}

// ============ HELPERS ============

function makeConfig(
  services: { name: string; probe: string[]; start: string[]; neededBy: string[] }[],
  machineId = "workstation",
  overrides: Partial<ProjectConfig["host_services"]> = {},
): ProjectConfig {
  return {
    name: "test-project",
    repo: "/tmp/test-repo",
    github: "example/test",
    queue_file: "/tmp/queue.md",
    agents_dir: "/tmp/agents",
    gates_dir: "/tmp/gates",
    host_services: {
      enabled: true,
      mode: "act",
      interval_seconds: 60,
      probe_timeout_seconds: 5,
      start_timeout_seconds: 10,
      start_delay_seconds: 1,
      max_start_attempts: 3,
      machines: {
        [machineId]: services.map((s) => ({
          name: s.name,
          probe: s.probe,
          start: s.start,
          needed_by: s.neededBy,
        })),
      },
      ...overrides,
    },
  };
}


function makeProbes(world: ServiceWorld, clock: FakeClock): HostServicesProbes {
  return { runner: new FakeRunner(world, clock), clock };
}

function createService(
  config: ProjectConfig,
  world: ServiceWorld,
  clock: FakeClock,
  events?: EventBus,
): { service: HostServices; probes: HostServicesProbes } {
  const parsed = parseHostServicesConfig(config.host_services);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const probes = makeProbes(world, clock);
  const service = new HostServices({
    project: config.name,
    config,
    settings: parsed.settings,
    store: new HostServicesStore(),
    probes,
    events,
  });
  return { service, probes };
}

// ============ TESTS ============

describe("host-services", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config parsing", () => {
    it("parses a valid config", () => {
      const result = parseHostServicesConfig({
        enabled: true,
        mode: "act",
        machines: {
          workstation: [
            { name: "docker", probe: ["docker", "info"], start: ["open", "-a", "Docker"], needed_by: ["heavy", "light"] },
          ],
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.enabled).toBe(true);
        expect(result.settings.mode).toBe("act");
        expect(result.settings.machines.size).toBe(1);
        const services = result.settings.machines.get("workstation");
        expect(services).toHaveLength(1);
        expect(services?.[0]?.name).toBe("docker");
        expect(services?.[0]?.neededBy).toEqual(["heavy", "light"]);
      }
    });

    it("uses defaults", () => {
      const result = parseHostServicesConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settings.enabled).toBe(false);
        expect(result.settings.mode).toBe("observe");
        expect(result.settings.intervalSeconds).toBe(60);
        expect(result.settings.maxStartAttempts).toBe(3);
      }
    });


    it("rejects duplicate service names on one machine", () => {
      const result = parseHostServicesConfig({
        enabled: true,
        machines: {
          workstation: [
            { name: "docker", probe: ["probe-docker"], start: ["start-docker"], needed_by: [] },
            { name: "docker", probe: ["probe-docker"], start: ["start-docker"], needed_by: [] },
          ],
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain('host_services.machines.workstation: duplicate service name "docker"');
      }
    });

    it("rejects enabled with no machines", () => {
      const result = parseHostServicesConfig({ enabled: true, machines: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain("host_services is enabled but no machines have services configured");
      }
    });
  });

  describe("probing and recovery", () => {
    it("a probe fails then passes after start", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: true }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]);
      const { service, probes } = createService(config, world, clock);
      const runner = probes.runner as FakeRunner;

      await service.tick();

      expect(runner.probeCalls().length).toBeGreaterThanOrEqual(1);
      expect(runner.startCalls()).toHaveLength(1);
      expect(runner.startCalls()[0]).toEqual(["start-docker"]);
      const statuses = service.getServiceStatuses("workstation");
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.state).toBe("up");
    });


    it("does not start in observe mode", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: true }]]) };
      const config = makeConfig(
        [{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: [] }],
        "workstation",
        { mode: "observe" },
      );
      const { service, probes } = createService(config, world, clock);
      const runner = probes.runner as FakeRunner;

      await service.tick();

      expect(runner.probeCalls().length).toBeGreaterThanOrEqual(1);
      expect(runner.startCalls()).toHaveLength(0);
      const statuses = service.getServiceStatuses("workstation");
      expect(statuses[0]?.state).toBe("down");
    });

    it("does not start in read_only project", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: true }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: [] }]);
      config.read_only = true;
      const { service, probes } = createService(config, world, clock);
      const runner = probes.runner as FakeRunner;

      await service.tick();

      expect(runner.startCalls()).toHaveLength(0);
      expect(service.actBlocked).toBe("the project is read_only");
    });
  });


  describe("lane holds", () => {
    it("holds lanes when service is down, releases when up", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const config = makeConfig([
        { name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy", "light"] },
      ]);
      const { service } = createService(config, world, clock);

      await service.tick();

      const holds = service.getHeldLanes();
      expect(holds).toHaveLength(2);
      const laneNames = holds.map((h) => h.lane).sort();
      expect(laneNames).toEqual(["heavy", "light"]);
      expect(service.isLaneHeld("heavy").held).toBe(true);
      expect(service.isLaneHeld("other").held).toBe(false);

      world.services.set("docker", { up: true, startWorks: true });
      await service.tick();

      expect(service.getHeldLanes()).toHaveLength(0);
      expect(service.isLaneHeld("heavy").held).toBe(false);
    });

    it("reports hold reason", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]);
      const { service } = createService(config, world, clock);

      await service.tick();

      const holdCheck = service.isLaneHeld("heavy");
      expect(holdCheck.held).toBe(true);
      expect(holdCheck.reason).toContain("docker");
      expect(holdCheck.reason).toContain("workstation");
    });
  });


  describe("decisions on persistent failure", () => {
    it("raises one decision after max start attempts", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]);
      const { service } = createService(config, world, clock);
      const decisions = new FakeDecisions();
      service.useDecisions(decisions);

      await service.tick(); // attempt 1
      expect(decisions.raised).toHaveLength(0);
      await service.tick(); // attempt 2
      expect(decisions.raised).toHaveLength(0);
      await service.tick(); // attempt 3
      expect(decisions.raised).toHaveLength(0);
      await service.tick(); // after max attempts, decision raised
      expect(decisions.raised).toHaveLength(1);
      expect(decisions.raised[0]?.title).toContain("docker");
      expect(decisions.raised[0]?.title).toContain("workstation");
      expect(decisions.raised[0]?.title).toContain("down");

      await service.tick();
      await service.tick();
      expect(decisions.raised).toHaveLength(1);
    });

    it("withdraws decision when service recovers", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]);
      const { service } = createService(config, world, clock);
      const decisions = new FakeDecisions();
      service.useDecisions(decisions);

      for (let i = 0; i < 5; i++) await service.tick();
      expect(decisions.raised).toHaveLength(1);

      world.services.set("docker", { up: true, startWorks: true });
      await service.tick();

      expect(decisions.withdrawn).toHaveLength(1);
      expect(decisions.withdrawn[0]?.input.reason).toContain("up");
    });
  });


  describe("events", () => {
    it("emits host-service.down on outage", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: [] }]);
      const events = new EventBus();
      const emitted: unknown[] = [];
      events.on("host-service.down", (e) => emitted.push(e));
      const { service } = createService(config, world, clock, events);

      await service.tick();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ project: "test-project", machine: "workstation", service: "docker" });
    });

    it("emits host-service.up on recovery", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: true }]]) };
      const config = makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: [] }]);
      const events = new EventBus();
      const emitted: unknown[] = [];
      events.on("host-service.up", (e) => emitted.push(e));
      const { service } = createService(config, world, clock, events);

      await service.tick();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ project: "test-project", machine: "workstation", service: "docker" });
    });
  });


  describe("HostServicesManager", () => {
    it("loads multiple projects", () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: true, startWorks: true }]]) };
      const probes = makeProbes(world, clock);
      const manager = new HostServicesManager({ probes });

      const entries: ProjectEntry[] = [
        { name: "project-a", config: makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]) },
        { name: "project-b", config: makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["light"] }]) },
      ];

      manager.load(entries);

      expect(manager.get("project-a")).toBeDefined();
      expect(manager.get("project-b")).toBeDefined();
      const statusA = manager.status("project-a");
      expect(statusA.enabled).toBe(true);
    });

    it("reports held lanes across all projects", async () => {
      const clock = new FakeClock();
      const world: ServiceWorld = { services: new Map([["docker", { up: false, startWorks: false }]]) };
      const probes = makeProbes(world, clock);
      const manager = new HostServicesManager({ probes });

      const entries: ProjectEntry[] = [
        { name: "project-a", config: makeConfig([{ name: "docker", probe: ["probe-docker"], start: ["start-docker"], neededBy: ["heavy"] }]) },
      ];
      manager.load(entries);
      manager.start();

      const service = manager.get("project-a");
      await service?.tick();

      const allHolds = manager.getAllHeldLanes();
      expect(allHolds.get("project-a")).toHaveLength(1);

      const check = manager.isLaneHeld("project-a", "heavy");
      expect(check.held).toBe(true);

      await manager.stop();
    });
  });
});
