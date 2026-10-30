/**
 * Infrastructure monitor acceptance tests.
 *
 * Only the system boundary is fake: a CommandRunner that answers machine
 * probes and requeue commands, a Clock, and a FileSystem. The tests run the
 * real module through InfraMonitorManager: config parsing, probes, job
 * tracking, detectors, notices, and act/observe modes.
 *
 * Each acceptance test FAILS on github/main because the infra-monitor module
 * does not exist there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import { InfraMonitorManager, type ProjectEntry } from "./service.js";
import { InfraMonitorStore } from "./store.js";
import type { CommandOutput, InfraMonitorProbes, FileEntry, FileSystem } from "./probes.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;

class FakeClock {
  t = NOW;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface ProbeWorld {
  /** Machine reachability: machine id -> true (up) or false (down) */
  machines: Record<string, boolean>;
  /** Probe error messages per machine */
  probeErrors: Record<string, string>;
  /** Requeue results: gate id -> { code, stderr } */
  requeue: Record<string, { code: number; stderr: string }>;
  /** Callback on requeue */
  onRequeue?: (gate: string, fromLane: string, toLane: string) => void;
}

class FakeRunner {
  calls: { argv: string[]; timeoutMs?: number }[] = [];

  constructor(private world: ProbeWorld) {}

  async run(
    argv: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CommandOutput> {
    this.calls.push({ argv: [...argv], timeoutMs: options.timeoutMs });

    const [cmd, ...args] = argv;

    // probe-<machine>
    if (cmd.startsWith("probe-")) {
      const machine = cmd.slice(6);
      const up = this.world.machines[machine] ?? true;
      if (up) {
        return { code: 0, stdout: "ok", stderr: "" };
      } else {
        return {
          code: 1,
          stdout: "",
          stderr: this.world.probeErrors[machine] ?? "connection refused",
        };
      }
    }

    // requeue <gate> <from_lane> <to_lane>
    if (cmd === "requeue") {
      const [gate, fromLane, toLane] = args;
      this.world.onRequeue?.(gate, fromLane, toLane);
      const result = this.world.requeue[gate] ?? { code: 0, stderr: "" };
      return { code: result.code, stdout: "", stderr: result.stderr };
    }

    return { code: 127, stdout: "", stderr: `unknown command: ${cmd}` };
  }
}

/** A fake file system for the gate queue */
class FakeFileSystem implements FileSystem {
  private files = new Map<string, { content: string; ctimeMs: number; mtimeMs: number }>();

  addFile(path: string, content: string, ctimeMs = NOW, mtimeMs = NOW): void {
    this.files.set(path, { content, ctimeMs, mtimeMs });
  }

  removeFile(path: string): void {
    this.files.delete(path);
  }

  stat(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number; ctimeMs: number } | null {
    const file = this.files.get(path);
    if (file) {
      return { isFile: true, isDirectory: false, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs };
    }
    // Check if it's a directory (any file has this as a prefix)
    for (const p of this.files.keys()) {
      if (p.startsWith(path + "/")) {
        return { isFile: false, isDirectory: true, mtimeMs: NOW, ctimeMs: NOW };
      }
    }
    return null;
  }

  readdir(dir: string): FileEntry[] {
    const entries: FileEntry[] = [];
    const seen = new Set<string>();
    for (const [path, data] of this.files) {
      if (path.startsWith(dir + "/")) {
        const rest = path.slice(dir.length + 1);
        const name = rest.split("/")[0];
        if (!seen.has(name)) {
          seen.add(name);
          const isFile = !rest.includes("/");
          entries.push({
            name,
            isFile,
            isDirectory: !isFile,
            mtimeMs: data.mtimeMs,
            ctimeMs: data.ctimeMs,
          });
        }
      }
    }
    return entries;
  }

  read(path: string, maxBytes = 65536): string | null {
    const file = this.files.get(path);
    if (!file) return null;
    return file.content.slice(0, maxBytes);
  }
}

// ============ TEST HELPERS ============

function baseConfig(gatesDir: string): ProjectConfig {
  return {
    name: "TestProject",
    repo: "/tmp/test-repo",
    github: "example/test",
    queue_file: "/tmp/queue.md",
    agents_dir: "/tmp/agents",
    gates_dir: gatesDir,
    machines: {
      workstation: {
        name: "Workstation",
        type: "local",
        runners: ["heavy"],
      },
      laptop: {
        name: "Laptop",
        type: "ssh",
        host: "192.168.1.10",
        user: "dev",
        key: "~/.ssh/id_rsa",
        runners: ["light"],
      },
    },
  };
}

function enabledConfig(gatesDir: string, mode: "observe" | "act" = "observe"): ProjectConfig {
  return {
    ...baseConfig(gatesDir),
    infra_monitor: {
      enabled: true,
      mode,
      interval_seconds: 60,
      down_threshold_seconds: 120,
      probe_cmd: ["probe-{machine}"],
      probe_timeout_seconds: 5,
      requeue_cmd: ["requeue", "{gate}", "{from_lane}", "{to_lane}"],
      requeue_timeout_seconds: 10,
    },
  };
}

// ============ TESTS ============

describe("InfraMonitor", () => {
  let tempDir: string;
  let gatesDir: string;
  let clock: FakeClock;
  let world: ProbeWorld;
  let runner: FakeRunner;
  let fs: FakeFileSystem;
  let events: EventBus;
  let manager: InfraMonitorManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "infra-monitor-test-"));
    gatesDir = join(tempDir, "gates");
    mkdirSync(join(gatesDir, "queue"), { recursive: true });
    mkdirSync(join(gatesDir, "results"), { recursive: true });

    clock = new FakeClock();
    world = {
      machines: { workstation: true, laptop: true },
      probeErrors: {},
      requeue: {},
    };
    runner = new FakeRunner(world);
    fs = new FakeFileSystem();
    events = new EventBus();

    const probes: InfraMonitorProbes = {
      runner,
      clock,
      fs,
    };

    manager = new InfraMonitorManager({ probes, events });
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("configuration", () => {
    it("is off by default (no project sets infra_monitor.enabled)", () => {
      const entry: ProjectEntry = {
        name: "TestProject",
        config: baseConfig(gatesDir),
      };
      manager.load([entry]);
      const started = manager.start();

      expect(started).toEqual([]);
      const status = manager.status("TestProject");
      expect(status.enabled).toBe(false);
      expect(status.running).toBe(false);
    });

    it("starts when enabled: true", () => {
      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      const started = manager.start();

      expect(started).toEqual(["TestProject"]);
      const status = manager.status("TestProject");
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.mode).toBe("observe");
    });

    it("reports config errors without crashing", () => {
      const entry: ProjectEntry = {
        name: "TestProject",
        config: {
          ...baseConfig(gatesDir),
          infra_monitor: {
            enabled: true,
            interval_seconds: 5, // Too low, must be >= 10
          },
        },
      };
      manager.load([entry]);
      const started = manager.start();

      expect(started).toEqual([]);
      const status = manager.status("TestProject");
      expect(status.enabled).toBe(false);
      expect(status.lastError).toContain("interval_seconds");
    });
  });

  describe("job whose machine stops -> one notice", () => {
    it("raises a notice when a machine goes down while a job runs on it", async () => {
      // Setup: a job running on the laptop
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();

      // First tick: both machines up, job tracked
      const monitor = manager.get("TestProject")!;
      await monitor.tick();

      let status = monitor.status();
      expect(status.monitoredJobs).toHaveLength(1);
      expect(status.monitoredJobs[0].id).toBe("20260302T110000Z-fix-abc-101");
      expect(status.monitoredJobs[0].machine).toBe("laptop");
      expect(status.activeNotices).toHaveLength(0);

      // Laptop goes down
      world.machines.laptop = false;
      world.probeErrors.laptop = "Connection timed out";

      // Second tick: laptop is down but threshold not reached
      clock.advance(MIN);
      await monitor.tick();
      status = monitor.status();
      expect(status.machineStates.find((m) => m.id === "laptop")?.reachable).toBe(false);
      expect(status.activeNotices).toHaveLength(0);

      // Third tick: threshold reached (120s default)
      clock.advance(MIN);
      await monitor.tick();
      status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].finding.type).toBe("job_machine_down");
      expect(status.activeNotices[0].finding.summary).toContain("20260302T110000Z-fix-abc-101");
      expect(status.activeNotices[0].finding.summary).toContain("laptop");
    });

    it("raises only one notice per finding (deduplication)", async () => {
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      // First tick
      await monitor.tick();

      // Machine goes down
      world.machines.laptop = false;

      // Wait for threshold
      clock.advance(3 * MIN);
      await monitor.tick();

      let status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      const firstNoticeId = status.activeNotices[0].id;

      // Additional ticks should not raise more notices
      clock.advance(MIN);
      await monitor.tick();
      clock.advance(MIN);
      await monitor.tick();

      status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].id).toBe(firstNoticeId);
    });
  });

  describe("duplicate slot -> one notice", () => {
    it("detects duplicate runner slots", async () => {
      // Two runners claiming the heavy lane
      fs.addFile(join(gatesDir, "queue/runner-heavy.pid"), "1001");
      fs.addFile(join(gatesDir, "queue/runner-heavy-2.pid"), "1002");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      await monitor.tick();

      const status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].finding.type).toBe("duplicate_slot");
      expect(status.activeNotices[0].finding.summary).toContain("heavy");
      expect(status.activeNotices[0].finding.summary).toContain("2 runners");
    });
  });

  describe("dead runner while jobs queued -> one notice", () => {
    it("raises a notice when a runner machine is down while jobs are queued", async () => {
      // Queued job on the light lane (laptop)
      fs.addFile(join(gatesDir, "queue/light.1.20260302T110000Z-fix-abc-101.req"), "");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      // First tick: laptop up
      await monitor.tick();
      expect(monitor.status().activeNotices).toHaveLength(0);

      // Laptop goes down
      world.machines.laptop = false;

      // Wait for threshold
      clock.advance(3 * MIN);
      await monitor.tick();

      const status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].finding.type).toBe("dead_runner");
      expect(status.activeNotices[0].finding.summary).toContain("light");
      expect(status.activeNotices[0].finding.summary).toContain("queued job");
    });
  });

  describe("act mode: requeue", () => {
    it("requeues a job when its machine is down in act mode", async () => {
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const requeueCalls: string[] = [];
      world.onRequeue = (gate, from, to) => requeueCalls.push(`${gate}:${from}->${to}`);

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir, "act"),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      // First tick
      await monitor.tick();

      // Machine goes down
      world.machines.laptop = false;

      // Wait for threshold and tick
      clock.advance(3 * MIN);
      await monitor.tick();

      expect(requeueCalls).toHaveLength(1);
      expect(requeueCalls[0]).toContain("20260302T110000Z-fix-abc-101");

      const status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].requeued).toBe(true);
      expect(status.activeNotices[0].requeueResult).toBe("moved");
    });

    it("does not requeue in observe mode", async () => {
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const requeueCalls: string[] = [];
      world.onRequeue = (gate, from, to) => requeueCalls.push(`${gate}:${from}->${to}`);

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir, "observe"),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      await monitor.tick();
      world.machines.laptop = false;
      clock.advance(3 * MIN);
      await monitor.tick();

      // Notice is raised but no requeue
      expect(requeueCalls).toHaveLength(0);
      const status = monitor.status();
      expect(status.activeNotices).toHaveLength(1);
      expect(status.activeNotices[0].requeued).toBe(false);
    });
  });

  describe("notice lifecycle", () => {
    it("clears notices when the problem is resolved", async () => {
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      // First tick
      await monitor.tick();

      // Machine goes down, threshold reached
      world.machines.laptop = false;
      clock.advance(3 * MIN);
      await monitor.tick();

      expect(monitor.status().activeNotices).toHaveLength(1);

      // Machine comes back up
      world.machines.laptop = true;
      clock.advance(MIN);
      await monitor.tick();

      // Notice should be cleared (problem resolved)
      // Note: the job is still running, machine is back, so no more finding
      expect(monitor.status().activeNotices).toHaveLength(0);
    });

    it("clears job notices when the job finishes", async () => {
      fs.addFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"), "12345");

      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();
      const monitor = manager.get("TestProject")!;

      await monitor.tick();
      world.machines.laptop = false;
      clock.advance(3 * MIN);
      await monitor.tick();

      expect(monitor.status().activeNotices).toHaveLength(1);

      // Job finishes (file removed)
      fs.removeFile(join(gatesDir, "queue/light.0.20260302T110000Z-fix-abc-101.req.run"));
      clock.advance(MIN);
      await monitor.tick();

      expect(monitor.status().monitoredJobs).toHaveLength(0);
      expect(monitor.status().activeNotices).toHaveLength(0);
    });
  });

  describe("config reload", () => {
    it("reloads when config changes", async () => {
      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir, "observe"),
      };
      manager.load([entry]);
      manager.start();

      let status = manager.status("TestProject");
      expect(status.mode).toBe("observe");

      // Reload with act mode
      await manager.reloadProject({
        name: "TestProject",
        config: enabledConfig(gatesDir, "act"),
      });

      status = manager.status("TestProject");
      expect(status.mode).toBe("act");
    });

    it("stops when disabled on reload", async () => {
      const entry: ProjectEntry = {
        name: "TestProject",
        config: enabledConfig(gatesDir),
      };
      manager.load([entry]);
      manager.start();

      expect(manager.status("TestProject").running).toBe(true);

      // Reload with disabled config
      await manager.reloadProject({
        name: "TestProject",
        config: baseConfig(gatesDir),
      });

      expect(manager.status("TestProject").running).toBe(false);
      expect(manager.status("TestProject").enabled).toBe(false);
    });
  });
});
