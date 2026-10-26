/**
 * Process termination tests with real child processes.
 *
 * `child.killed` turns true as soon as SIGTERM is delivered, so code that
 * checked it before sending SIGKILL never escalated. These children ignore
 * SIGTERM to prove SIGKILL is sent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { createServer, type Server, type AddressInfo } from "net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { ManagedProcess } from "./managed-process.js";
import { executeLocalGate } from "./remote-gate.js";
import type { ProcessConfig } from "../../shared/process-types.js";

const IGNORE_SIGTERM =
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processConfig(command: string[]): ProcessConfig {
  return {
    id: "stubborn",
    name: "stubborn",
    command,
    restart: "never",
    restartDelay: 1000,
    maxRestarts: 0,
    backoffMultiplier: 2,
    maxBackoff: 1000,
    logMaxLines: 100,
    autostart: false,
  };
}

describe("ManagedProcess.stop", () => {
  it(
    "sends SIGKILL when the child ignores SIGTERM",
    async () => {
      const mp = new ManagedProcess(
        processConfig([process.execPath, "-e", IGNORE_SIGTERM]),
      );
      const ready = new Promise<void>((resolve) => {
        mp.on("log", (_id: string, line: { text: string }) => {
          if (line.text === "ready") resolve();
        });
      });
      await mp.start();
      await ready;
      const pid = mp.getState().pid!;

      const started = Date.now();
      await mp.stop(300);

      expect(isAlive(pid)).toBe(false);
      expect(mp.getState().exitSignal).toBe("SIGKILL");
      // Without escalation stop() only returned at the 5s absolute timeout
      expect(Date.now() - started).toBeLessThan(3000);
    },
    15000,
  );
});

describe("executeLocalGate timeout", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lair-kill-"));
    writeFileSync(join(dir, "stubborn.js"), IGNORE_SIGTERM);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "escalates to SIGKILL when the gate ignores SIGTERM",
    async () => {
      const gate = executeLocalGate(process.execPath, join(dir, "stubborn.js"), "x", {
        timeout: 1500,
        killGraceMs: 200,
      });
      const result = await gate.promise;
      expect(result.stdout).toContain("ready");
      expect(result.timedOut).toBe(true);
      expect(isAlive(gate.pid)).toBe(false);
    },
    15000,
  );
});

describe("ManagedProcess tcp health check", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    "works under real ESM (no CommonJS require)",
    () => {
      // vitest provides `require`, plain Node ESM does not: run under tsx
      const dir = mkdtempSync(join(tmpdir(), "lair-tcp-"));
      try {
        const modUrl = pathToFileURL(join(process.cwd(), "src/server/services/managed-process.ts")).href;
        const script = join(dir, "check.mts");
        writeFileSync(
          script,
          [
            `import { ManagedProcess } from ${JSON.stringify(modUrl)};`,
            "const mp = new ManagedProcess({ id: 'x', name: 'x', command: ['true'], restart: 'never',",
            "  restartDelay: 1, maxRestarts: 0, backoffMultiplier: 1, maxBackoff: 1, logMaxLines: 10, autostart: false });",
            `const result = await mp["checkTcp"]({ type: "tcp", host: "127.0.0.1", port: ${port}, timeout: 2000, interval: 1000 });`,
            "console.log(JSON.stringify(result));",
          ].join("\n"),
        );
        const out = execFileSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [script], {
          encoding: "utf-8",
          timeout: 20000,
        });
        expect(JSON.parse(out.trim())).toEqual({ isHealthy: true, reason: "" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("connects to a listening port", async () => {
    const mp = new ManagedProcess(processConfig(["true"]));
    const check = (
      mp as unknown as {
        checkTcp(config: object): Promise<{ isHealthy: boolean; reason: string }>;
      }
    ).checkTcp({ type: "tcp", host: "127.0.0.1", port, timeout: 2000, interval: 1000 });
    await expect(check).resolves.toEqual({ isHealthy: true, reason: "" });
  });
});
