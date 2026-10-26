/**
 * Watchdog lifecycle: ticks don't overlap, and stop() waits for the tick in
 * progress (the server closes the store right after).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { createWatchdog } from "./service.js";
import { WatchdogStore } from "./store.js";
import { NodeFileSystem, type CommandOutput, type ProcessInfo } from "./probes.js";

let dir: string | null = null;
let store: WatchdogStore | null = null;

afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  store = null;
  dir = null;
});

function blockedWatchdog() {
  dir = mkdtempSync(join(tmpdir(), "lair-watchdog-service-"));
  mkdirSync(join(dir, "agents"));
  const config: ProjectConfig = {
    name: "Demo",
    repo: dir,
    github: "example/demo",
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    watchdog: { enabled: true, agent_command: "agent-cli --agent {agent}" },
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listCalls = 0;
  store = new WatchdogStore(":memory:");
  const wd = createWatchdog({
    project: "demo",
    config,
    store,
    probes: {
      processes: {
        async list(): Promise<ProcessInfo[]> {
          listCalls++;
          await gate;
          return [];
        },
      },
      fs: new NodeFileSystem(),
      runner: { run: async (): Promise<CommandOutput> => ({ code: 0, stdout: "", stderr: "" }) },
      clock: { now: () => Date.parse("2026-03-02T12:00:00Z"), sleep: async () => {} },
    },
  });
  return { wd, release, listCalls: () => listCalls };
}

describe("Watchdog lifecycle", () => {
  it("shares a tick in progress instead of starting a second one", async () => {
    const { wd, release, listCalls } = blockedWatchdog();
    const first = wd.tick();
    const second = wd.tick();
    expect(second).toBe(first);
    release();
    await first;
    expect(listCalls()).toBe(1);
    expect(wd.lastTick?.findings).toBe(0);
  });

  it("stop() resolves only after the tick in progress has finished", async () => {
    const { wd, release } = blockedWatchdog();
    const tick = wd.tick();
    let stopped = false;
    const stopping = wd.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await expect(tick).resolves.toMatchObject({ findings: 0 });
    expect(store!.sloStatus("demo")).toHaveLength(9);
  });
});
