import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../watchdog/probes.js";
import { commandFingerprint, commandMatches, findTaskProcess, runPromptFileName } from "./reconcile.js";

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
