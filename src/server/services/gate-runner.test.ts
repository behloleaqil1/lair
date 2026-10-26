/**
 * Gate runner tests: gate request files are written by agents and untrusted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GateRunner } from "./gate-runner.js";

describe("GateRunner.readQueuedRequests", () => {
  let dir: string;
  let runner: GateRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lair-gate-queue-"));
    runner = new GateRunner({ enabled: true }, dir, join(dir, "results"), {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRequest(name: string, data: unknown): void {
    writeFileSync(join(dir, name), JSON.stringify(data));
  }

  it("reads a well-formed request", () => {
    writeRequest("heavy.1.abc.req", {
      worktree: "/w",
      envVars: { BACKEND_TESTS: "x" },
    });
    const [req] = runner.readQueuedRequests();
    expect(req.id).toBe("abc");
    expect(req.envVars).toEqual({ BACKEND_TESTS: "x" });
  });

  it("skips requests whose env var names are not identifiers", () => {
    writeRequest("heavy.1.bad.req", {
      worktree: "/w",
      envVars: { "X=1;touch /tmp/pwned;Y": "v" },
    });
    writeRequest("light.2.loader.req", {
      worktree: "/w",
      envVars: { LD_PRELOAD: "/tmp/evil.so" },
    });
    writeRequest("light.3.nonstring.req", { worktree: "/w", envVars: { A: 1 } });
    writeRequest("remote.4.badtree.req", { worktree: ["/w"] });
    expect(runner.readQueuedRequests()).toEqual([]);
  });
});
