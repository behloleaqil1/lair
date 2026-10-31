import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../watchdog/probes.js";
import { ProcessSnapshot } from "./probes.js";
import { commandFingerprint, commandMatches, findTaskProcess, reconcileRun, runPromptFileName } from "./reconcile.js";
import type { AgentRun } from "./types.js";

const proc = (pid: number, command: string): ProcessInfo => ({ pid, ppid: 1, elapsedSeconds: 60, argv: command.split(" "), command });

describe("command fingerprints", () => {
  const argv = ["/opt/agents/start.sh", "--agent", "worker-a", "--prompt", "/srv/prompts/feat-login-worker-a-0a1b2c3d.txt"];
  const fingerprint = commandFingerprint(argv);

  it("match the command line as ps shows it, and the same after an interpreter (a script)", () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(commandMatches(fingerprint, argv.join(" "))).toBe(true);
    expect(commandMatches(fingerprint, `/bin/bash ${argv.join(" ")}`)).toBe(true);
    expect(commandMatches(fingerprint, `/usr/bin/env -S bash -e ${argv.join(" ")}`)).toBe(true);
  });

  it("don't match another command, or the same one with other arguments", () => {
    expect(commandMatches(fingerprint, "unrelated-daemon --serve")).toBe(false);
    expect(commandMatches(fingerprint, argv.join(" ").replace("worker-a --prompt", "worker-b --prompt"))).toBe(false);
    expect(commandMatches(fingerprint, argv.slice(0, 3).join(" "))).toBe(false);
  });
});

describe("findTaskProcess", () => {
  const dir = "/srv/prompts";
  const file = (task: string, agent: string) => `${dir}/${runPromptFileName(task, agent, "0a1b2c3d-1111-2222-3333-444455556666")}`;
  const agents = ["worker-a", "worker-b"];
  const list = [
    proc(10, `agent-cli run --prompt ${file("feat-login-v2", "worker-a")}`),
    proc(11, `agent-cli run --prompt ${file("feat-login", "worker-b")} --model model-a`),
  ];

  it("finds the process that holds one of the task's run prompt files, of any agent", () => {
    expect(file("feat-login", "worker-b")).toBe(`${dir}/feat-login-worker-b-0a1b2c3d.txt`);
    expect(findTaskProcess(list, dir, "feat-login", agents, new Set())?.pid).toBe(11);
    expect(findTaskProcess(list, dir, "feat-login-v2", agents, new Set())?.pid).toBe(10);
  });

  it("ignores another task's files (even one that starts with the task's name), and the pids it is told to", () => {
    expect(findTaskProcess(list, dir, "feat-login", agents, new Set([11]))).toBeNull();
    expect(findTaskProcess(list, dir, "feat-search", agents, new Set())).toBeNull();
    expect(findTaskProcess(list, "/elsewhere", "feat-login", agents, new Set())).toBeNull();
    expect(findTaskProcess(list, dir, "feat-login", [], new Set())).toBeNull();
  });
});

describe("reconcileRun", () => {
  const NOW = Date.parse("2026-03-02T12:00:00.000Z");
  const self = { pid: 100, startedAt: NOW - 3_600_000 };
  const argv = ["agent-cli", "run", "--prompt", "/srv/prompts/feat-login-worker-a-0a1b2c3d.txt"];
  /** A run started 10 minutes ago as pid 5001 */
  const run = (fields: Partial<AgentRun> = {}): AgentRun =>
    ({ pid: 5001, pgid: 5001, pidStartedAt: NOW - 600_000, commandFingerprint: commandFingerprint(argv), ...fields }) as AgentRun;
  const reading = (elapsedSeconds: number, command = argv.join(" ")) => [
    { pid: 5001, ppid: 1, elapsedSeconds, argv: command.split(" "), command },
  ];
  const snap = (list: ProcessInfo[], takenAt = NOW, spreadMs = 0) => new ProcessSnapshot(list, takenAt, self, 5, spreadMs);

  it("adopts a pid that started with the run and runs its command", () => {
    expect(reconcileRun(run(), snap(reading(600)), false)).toEqual({
      kind: "adopted",
      evidence: "pid 5001 is running (started 2026-03-02T11:50:00.000Z): its start time and command match (process group 5001)",
      commandDiffers: false,
    });
    // A config reload: this server process started it
    expect(reconcileRun(run(), snap(reading(600)), true)).toMatchObject({
      kind: "adopted",
      commandDiffers: false,
      evidence: expect.stringContaining("this server process started it"),
    });
  });

  it("adopts on pid and start time when the command line differs, and says so", () => {
    const verdict = reconcileRun(run(), snap(reading(600, "agent-cli: worker-a (renamed)")), false);
    expect(verdict).toMatchObject({ kind: "adopted", commandDiffers: true });
    expect(verdict.kind === "adopted" ? verdict.evidence : "").toContain(
      "its start time matches (process group 5001); its command line differs from the one it was started with",
    );
    // A run recorded before fingerprints were kept: pid and start time alone
    const legacy = reconcileRun(run({ commandFingerprint: undefined, pgid: undefined }), snap(reading(600, "anything")), false);
    expect(legacy).toMatchObject({ kind: "adopted", commandDiffers: false });
    expect(legacy.kind === "adopted" ? legacy.evidence : "").toContain("recorded without its process group and command");
  });

  it("is lost when its pid started at another time (reused), and gone when nothing runs under it", () => {
    expect(reconcileRun(run(), snap(reading(60)), false)).toMatchObject({
      kind: "lost",
      reason: expect.stringContaining("pid 5001 is a different process now"),
    });
    expect(reconcileRun(run(), snap([]), false)).toEqual({ kind: "gone", reason: "pid 5001 is not running" });
    expect(reconcileRun(run({ pid: undefined }), snap(reading(600)), false)).toEqual({ kind: "gone", reason: "no pid was recorded" });
  });

  it("counts start times from when the reading was taken: an old or slow reading still adopts the live process", () => {
    // Read 9 s before it is used (older than the 6 s tolerance): elapsed 591 s then
    expect(reconcileRun(run(), snap(reading(591), NOW - 9_000), false).kind).toBe("adopted");
    // The same reading counted from the time it is used would put the start 9 s late
    expect(reconcileRun(run(), snap(reading(591), NOW), false).kind).toBe("lost");
    // ps took 30 s to answer and read the elapsed times as it started: a start up to 30 s earlier still matches
    expect(reconcileRun(run(), snap(reading(570), NOW, 30_000), false).kind).toBe("adopted");
    expect(reconcileRun(run(), snap(reading(570), NOW, 0), false).kind).toBe("lost");
    // ... but never a later one: a process that started after the run's is not the run's
    expect(reconcileRun(run(), snap(reading(560), NOW, 30_000), false).kind).toBe("lost");
  });
});
