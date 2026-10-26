/**
 * The local executor's real system boundary: the process spawner (argv, no
 * shell, timeout, abort) and the capacity readings it waits on.
 */
import { describe, expect, it } from "vitest";
import {
  ProcessSpawner,
  SystemCapacityProbe,
  capacityProblem,
  parseDarwinPressureLevel,
  parseMeminfoAvailableMb,
  parsePsiPressure,
  parseVmStatAvailableMb,
} from "./local.js";
import type { LocalSettings } from "../project-pipelines.js";

const NODE = process.execPath;
const env = { PATH: process.env.PATH ?? "" };

describe("ProcessSpawner", () => {
  const spawner = new ProcessSpawner(200);

  it("runs an argv without a shell and reports exit code and output", async () => {
    const result = await spawner.run(
      [NODE, "-e", "process.stdout.write(process.argv[1]); process.stderr.write('warn'); process.exit(3)", "$(echo hi); ls"],
      { cwd: process.cwd(), env, timeoutMs: 20_000 },
    );
    expect(result).toMatchObject({ exitCode: 3, stdout: "$(echo hi); ls", stderr: "warn", timedOut: false });
  });

  it("kills a step that runs past its timeout", async () => {
    const started = Date.now();
    const result = await spawner.run([NODE, "-e", "setTimeout(() => {}, 30000)"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("stops a step when the run is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await spawner.run([NODE, "-e", "setTimeout(() => {}, 30000)"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(15_000);
  });

  it("reports a program that does not exist instead of throwing", async () => {
    const result = await spawner.run(["lair-test-no-such-program"], { cwd: process.cwd(), env, timeoutMs: 5000 });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("capacity", () => {
  const settings: LocalSettings = {
    maxParallel: 1,
    minFreeRamMb: 1024,
    maxLoadPerCore: 1.5,
    capacityRetrySeconds: 30,
    workdir: "worktree",
  };
  const ok = { cores: 4, load1: 1, totalRamMb: 8192, freeRamMb: 4096, memoryPressure: "normal" as const };

  it("refuses to start under memory pressure, low free RAM or high load", () => {
    expect(capacityProblem(ok, settings)).toBeNull();
    expect(capacityProblem({ ...ok, memoryPressure: "warn" }, settings)).toBe("memory pressure is warn");
    expect(capacityProblem({ ...ok, freeRamMb: 512 }, settings)).toBe(
      "free RAM 512 MB is below min_free_ram_mb (1024)",
    );
    expect(capacityProblem({ ...ok, load1: 8 }, settings)).toBe(
      "load 8.00 on 4 cores is above max_load_per_core (1.5)",
    );
    expect(capacityProblem({ ...ok, memoryPressure: "unknown" }, settings)).toBeNull();
  });

  it("reads Linux and macOS memory figures", () => {
    expect(parseMeminfoAvailableMb("MemTotal:  16384000 kB\nMemAvailable:    2048000 kB\n")).toBe(2000);
    expect(parseMeminfoAvailableMb("MemTotal: 1 kB\n")).toBeNull();
    expect(parsePsiPressure("some avg10=1.50 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00")).toBe("normal");
    expect(parsePsiPressure("some avg10=25.00 avg60=0.00 avg300=0.00 total=1")).toBe("warn");
    expect(parsePsiPressure("some avg10=75.00 avg60=0.00 avg300=0.00 total=1")).toBe("critical");
    const vmStat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                            200000.",
      "Pages inactive:                           50000.",
      "Pages speculative:                         4000.",
      "Pages purgeable:                            000.",
    ].join("\n");
    expect(parseVmStatAvailableMb(vmStat)).toBe(((10000 + 50000 + 4000) * 16384) / (1024 * 1024));
    expect(parseVmStatAvailableMb("nothing here")).toBeNull();
    expect(parseDarwinPressureLevel("1\n")).toBe("normal");
    expect(parseDarwinPressureLevel("2")).toBe("warn");
    expect(parseDarwinPressureLevel("4")).toBe("critical");
  });

  it("measures this machine", async () => {
    const sample = await new SystemCapacityProbe().sample();
    expect(sample.cores).toBeGreaterThan(0);
    expect(sample.totalRamMb).toBeGreaterThan(0);
    expect(sample.freeRamMb).toBeGreaterThan(0);
    expect(["normal", "warn", "critical", "unknown"]).toContain(sample.memoryPressure);
  });
});
