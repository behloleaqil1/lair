import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ExecFileRunner,
  NodeFileSystem,
  PS_ARGV,
  PsProcessTable,
  parseElapsed,
  parsePsOutput,
  type CommandOutput,
  type CommandRunner,
} from "./probes.js";

describe("parseElapsed", () => {
  it.each([
    ["00:05", 5],
    ["12:34", 754],
    ["01:02:03", 3723],
    ["2-03:04:05", 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
  ])("%s is %i seconds", (value, seconds) => {
    expect(parseElapsed(value)).toBe(seconds);
  });

  it("rejects other text", () => {
    expect(parseElapsed("ELAPSED")).toBeNull();
    expect(parseElapsed("5")).toBeNull();
  });
});

describe("parsePsOutput", () => {
  it("parses pid, ppid, elapsed time and the command line", () => {
    const out = [
      "    1     0  3-01:00:00 /sbin/init",
      "  4242     1       45:10 agent-cli run --agent worker-a --model m",
      "  4243  4242       00:01 ps -A -ww -o pid=,ppid=,etime=,args=",
      "garbage",
      "",
    ].join("\n");
    expect(parsePsOutput(out)).toEqual([
      { pid: 1, ppid: 0, elapsedSeconds: 3 * 86400 + 3600, argv: ["/sbin/init"], command: "/sbin/init" },
      {
        pid: 4242,
        ppid: 1,
        elapsedSeconds: 2710,
        argv: ["agent-cli", "run", "--agent", "worker-a", "--model", "m"],
        command: "agent-cli run --agent worker-a --model m",
      },
      {
        pid: 4243,
        ppid: 4242,
        elapsedSeconds: 1,
        argv: ["ps", "-A", "-ww", "-o", "pid=,ppid=,etime=,args="],
        command: "ps -A -ww -o pid=,ppid=,etime=,args=",
      },
    ]);
  });
});

describe("PsProcessTable", () => {
  it("runs ps with an argv array and parses its output", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(argv): Promise<CommandOutput> {
        calls.push(argv);
        return { code: 0, stdout: "  7  1  00:10 sleep 100\n", stderr: "" };
      },
    };
    const procs = await new PsProcessTable(runner).list();
    expect(calls).toEqual([PS_ARGV]);
    expect(procs.map((p) => p.pid)).toEqual([7]);
  });

  it("throws when ps fails, so detectors report an error instead of 'no processes'", async () => {
    const runner: CommandRunner = {
      async run(): Promise<CommandOutput> {
        return { code: 1, stdout: "", stderr: "ps: not found" };
      },
    };
    await expect(new PsProcessTable(runner).list()).rejects.toThrow("ps failed");
  });
});

describe("ExecFileRunner", () => {
  it("returns -1 for an empty argv or a program that does not exist", async () => {
    const runner = new ExecFileRunner(5000);
    expect((await runner.run([])).code).toBe(-1);
    const missing = await runner.run(["lair-test-no-such-program-x9"]);
    expect(missing.code).toBe(-1);
    expect(missing.stderr).toContain("ENOENT");
  });

  it("never uses a shell: shell syntax in an argument stays literal", async () => {
    const out = await new ExecFileRunner(5000).run([process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(echo hi); rm -rf x"]);
    expect(out).toEqual({ code: 0, stdout: "$(echo hi); rm -rf x", stderr: "" });
  });

  it("reports a non-zero exit code", async () => {
    const out = await new ExecFileRunner(5000).run([process.execPath, "-e", "process.exit(3)"]);
    expect(out.code).toBe(3);
  });

  it("kills the command when the signal aborts, long before its timeout", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const running = new ExecFileRunner(60_000).run([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    const out = await running;
    expect(out.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("NodeFileSystem", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads a tail, stats, lists, and returns null or [] for missing paths", () => {
    dir = mkdtempSync(join(tmpdir(), "lair-probes-"));
    const fs = new NodeFileSystem();
    writeFileSync(join(dir, "a.log"), "0123456789");
    expect(fs.read(join(dir, "a.log"))).toBe("0123456789");
    expect(fs.read(join(dir, "a.log"), 4)).toBe("6789");
    expect(fs.read(join(dir, "missing"))).toBeNull();
    expect(fs.stat(join(dir, "missing"))).toBeNull();
    expect(fs.stat(dir)?.isDirectory).toBe(true);
    expect(fs.list(dir)).toEqual(["a.log"]);
    expect(fs.list(join(dir, "missing"))).toEqual([]);
    fs.append(join(dir, "a.log"), "!");
    expect(fs.read(join(dir, "a.log"))).toBe("0123456789!");
  });
});
