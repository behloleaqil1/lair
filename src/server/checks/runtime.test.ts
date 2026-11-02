/**
 * The checks module's production boundaries, for real: the process spawner
 * (process group, timeout, rolling output tail, kill), the guard runner, the
 * async bounded filesystem, git against a real remote, the time-bounded
 * selector pattern, the agents-store run check, and the manager end to end
 * (routes, bus token, git, a real command writing JUnit XML).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import { ProcessSpawner } from "../gates/executors/local.js";
import {
  ChecksManager,
  ChecksProcessSpawner,
  ChecksGuardRunner,
  NodeChecksFs,
  RepoGit,
  agentRunIsActive,
  checkEnvironment,
} from "./manager.js";
import { shaOnPushedBranch } from "./git.js";
import { matchesWithin, parseChecksConfig, validateSelector } from "./config.js";
import { registerChecksRoutes } from "./routes.js";
import { getBusStore, closeBusStores } from "../bus/store.js";
import { hashBusToken, newBusToken } from "../bus/tokens.js";
import { AgentsStore } from "../agents/store.js";
import type { AgentRun } from "../agents/types.js";
import type { ProjectConfig } from "../../shared/types.js";

const NODE = process.execPath;
const POSIX = process.platform !== "win32";

// Real processes and git: generous limits for a loaded CI machine (no test waits on a fixed delay)
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lair-checks-runtime-"));
});

afterAll(() => {
  closeBusStores();
  rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

function commit(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `change ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

/** Whether a process still runs (a zombie counts as gone) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** Wait for a condition the system makes true (not a fixed sleep): polls until `deadlineMs` */
async function until(condition: () => boolean, deadlineMs = 10_000): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

describe("the real spawner", () => {
  it("keeps a rolling tail of the output (1 MB per stream), not a growing buffer", async () => {
    const spawner = new ChecksProcessSpawner();
    const script = `const chunk = "x".repeat(65536); for (let i = 0; i < 48; i++) process.stdout.write(chunk); process.stdout.write("END-MARKER"); process.exitCode = 1;`;

    const result = await spawner.spawn([NODE, "-e", script], { cwd: tmp, env: { CHECK_ID: "0000000000000001" }, timeoutMs: 60_000 });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.length).toBe(1024 * 1024);
    expect(result.stdout.endsWith("END-MARKER")).toBe(true);
  });

  it.runIf(POSIX)("a timeout stops the whole process group and reports timedOut", async () => {
    const spawner = new ChecksProcessSpawner();
    const pidFile = join(tmp, "grandchild.pid");
    const grandchild = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
    const script = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;

    const result = await spawner.spawn([NODE, "-e", script], { cwd: tmp, env: { CHECK_ID: "0000000000000002" }, timeoutMs: 3000 });

    expect(result.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf-8"));
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("kill(checkId) stops a running check", async () => {
    const spawner = new ChecksProcessSpawner();
    const run = spawner.spawn([NODE, "-e", "setInterval(() => {}, 1000)"], { cwd: tmp, env: { CHECK_ID: "0000000000000003" }, timeoutMs: 60_000 });
    spawner.kill("0000000000000003");

    const result = await run;
    expect(result.killed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("strips Lair's tokens from the command's environment", async () => {
    const spawner = new ChecksProcessSpawner(new ProcessSpawner(), { ...process.env, GH_TOKEN: "secret", LAIR_BUS_TOKEN: "lairbus_x", KEEP_ME: "yes" });
    const script = `process.stdout.write([process.env.GH_TOKEN ?? "none", process.env.LAIR_BUS_TOKEN ?? "none", process.env.KEEP_ME, process.env.CHECK_SHA].join(","))`;

    const result = await spawner.spawn([NODE, "-e", script], { cwd: tmp, env: { CHECK_ID: "0000000000000004", CHECK_SHA: "abc" }, timeoutMs: 60_000 });

    expect(result.stdout).toBe("none,none,yes,abc");
    expect(checkEnvironment({ PATH: "/bin", GITHUB_TOKEN: "t", LAIR_OPS_TOKEN: "o" }, { X: "1" })).toEqual({ PATH: "/bin", X: "1" });
  });

  it("the guard runner reports the exit code and output, and a timeout as timedOut", async () => {
    const guard = new ChecksGuardRunner();
    const refused = await guard.run([NODE, "-e", "process.stderr.write('over budget'); process.exitCode = 1"], tmp, 30_000);
    expect(refused).toEqual({ exitCode: 1, output: "over budget", timedOut: false });

    const hung = await guard.run([NODE, "-e", "setInterval(() => {}, 1000)"], tmp, 500);
    expect(hung.timedOut).toBe(true);
  });
});

describe("the real filesystem", () => {
  it("reads at most maxBytes, lists, creates and removes directories, all async", async () => {
    const fs = new NodeChecksFs();
    const dir = join(tmp, "fs", "nested");
    await fs.mkdir(dir);
    const big = join(dir, "big.xml");
    writeFileSync(big, "y".repeat(3 * 1024 * 1024));

    expect((await fs.readFile(big, 1024))?.length).toBe(1024);
    expect(await fs.readFile(join(dir, "missing.xml"), 1024)).toBeNull();
    expect(await fs.readFile(big, 0)).toBeNull();
    expect(await fs.readDir(dir)).toEqual(["big.xml"]);
    expect(await fs.readDir(join(tmp, "nope"))).toBeNull();

    await fs.remove(join(tmp, "fs"));
    expect(existsSync(join(tmp, "fs"))).toBe(false);
    await fs.remove(join(tmp, "fs")); // missing: no error
  });
});

describe("git: the sha must be on the branch as pushed", () => {
  let remote: string;
  let work: string;
  let server: string;
  let pushed: string;

  beforeAll(() => {
    remote = join(tmp, "remote.git");
    work = join(tmp, "work");
    server = join(tmp, "server");
    git(tmp, "init", "-q", "--bare", remote);
    mkdirSync(work);
    git(work, "init", "-q");
    git(work, "remote", "add", "origin", remote);
    commit(work, "a.txt", "a");
    pushed = commit(work, "b.txt", "b");
    git(work, "push", "-q", "origin", "HEAD:refs/heads/feat-search");
    git(tmp, "clone", "-q", remote, server);
  });

  it("accepts a pushed sha and its ancestors, refuses an unpushed sha, an unknown branch and a sha of another branch", async () => {
    const repo = new RepoGit(work);
    expect(await shaOnPushedBranch(repo, pushed, "feat-search", "origin")).toEqual({ ok: true });
    expect(await shaOnPushedBranch(repo, git(work, "rev-parse", "HEAD~1"), "feat-search", "origin")).toEqual({ ok: true });

    const local = commit(work, "c.txt", "c");
    const unpushed = await shaOnPushedBranch(repo, local, "feat-search", "origin");
    expect(unpushed).toEqual({ ok: false, reason: 'sha is not on branch "feat-search" as pushed to origin' });

    const unknown = await shaOnPushedBranch(repo, pushed, "feat-nothing", "origin");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain('branch "feat-nothing" could not be fetched from origin');

    git(work, "push", "-q", "origin", `${local}:refs/heads/feat-other`);
    const elsewhere = await shaOnPushedBranch(repo, local, "feat-search", "origin");
    expect(elsewhere.ok).toBe(false);
  });

  it("fetches a stale remote-tracking ref (a push from another clone) and then accepts the sha", async () => {
    const newer = commit(work, "d.txt", "d");
    git(work, "push", "-q", "origin", `${newer}:refs/heads/feat-search`);

    // The server's clone has neither the commit nor the new tip
    expect(await shaOnPushedBranch(new RepoGit(server), newer, "feat-search", "origin")).toEqual({ ok: true });
    expect(git(server, "rev-parse", "refs/remotes/origin/feat-search")).toBe(newer);
  });

  it("a remote that does not exist is a refusal, not a pass", async () => {
    const result = await shaOnPushedBranch(new RepoGit(work), pushed, "feat-search", "nowhere");
    expect(result.ok).toBe(false);
  });
});

describe("the selector pattern is time-bounded", () => {
  it("interrupts a pattern that backtracks without end and refuses the selector", () => {
    expect(matchesWithin("^[A-Za-z]+$", "TestA", 100)).toBe(true);
    expect(matchesWithin("^[A-Za-z]+$", "Test1", 100)).toBe(false);
    expect(matchesWithin("^(a+)+$", "a".repeat(28) + "!", 50)).toBe("timeout");

    const result = validateSelector(["a".repeat(28) + "!"], { pattern: "^(a+)+$", max_count: 10, max_length: 1000 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("took longer than");
  });

  it("a remote name is validated like any argv value", () => {
    expect(parseChecksConfig({ k: { command: ["./x"], remote: "-upload-pack=evil" } }).ok).toBe(false);
    const parsed = parseChecksConfig({ k: { command: ["./x"] } });
    expect(parsed.ok && parsed.config.kinds.get("k")?.remote).toBe("origin");
  });
});

function agentRun(over: Partial<AgentRun>): AgentRun {
  return {
    id: "run-1", project: "demo", task: "feat-search", agent: "worker-a", prompt: "do the task", chainId: "run-1",
    attempt: 1, profileIndex: 0, profile: { adapter: "generic", provider: "local" }, sessionId: "s-1", sessionMode: "new",
    sameSessionRestarts: 0, freshSessions: 0, startRetries: 0, launchFailures: 0, state: "running", detail: "",
    requestedAt: 0, notBefore: 0, logOffset: 0, ...over,
  } as AgentRun;
}

describe("the agents store decides whether a run is active", () => {
  it("only a running run of this project and agent is active", () => {
    const agents = new AgentsStore(":memory:");
    agents.insertRun(agentRun({ id: "r-running" }));
    agents.insertRun(agentRun({ id: "r-done", state: "completed" }));
    agents.insertRun(agentRun({ id: "r-stopping", state: "stopping" }));
    agents.insertRun(agentRun({ id: "r-other", project: "other" }));

    expect(agentRunIsActive(agents, "demo", "r-running", "worker-a")).toBe(true);
    expect(agentRunIsActive(agents, "demo", "r-running", "worker-b")).toBe(false);
    expect(agentRunIsActive(agents, "demo", "r-done", "worker-a")).toBe(false);
    expect(agentRunIsActive(agents, "demo", "r-stopping", "worker-a")).toBe(false);
    expect(agentRunIsActive(agents, "demo", "r-other", "worker-a")).toBe(false);
    expect(agentRunIsActive(agents, "demo", "r-missing", "worker-a")).toBe(false);
    expect(agentRunIsActive(null, "demo", "r-running", "worker-a")).toBe(false);
    agents.close();
  });
});

describe("the manager end to end", () => {
  it("runs a real command for a real token on a pushed sha, reads its JUnit failures, and stops cleanly", async () => {
    const root = join(tmp, "e2e");
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    const data = join(root, "data");
    mkdirSync(repo, { recursive: true });
    git(root, "init", "-q", "--bare", remote);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", remote);
    const sha = commit(repo, "app.txt", "app");
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/feat-search");
    // The project's check command: writes JUnit XML to CHECK_OUTPUT_DIR, exits 1 when a test fails
    writeFileSync(
      join(repo, "run-check.cjs"),
      `const { writeFileSync } = require("fs");
const { join } = require("path");
const [sha, tests] = process.argv.slice(2);
const names = tests.split(" ");
const failing = names.filter((n) => n.includes("Failing"));
const cases = names.map((n) => failing.includes(n) ? '<testcase name="' + n + '"><failure message="no"/></testcase>' : '<testcase name="' + n + '"/>').join("");
writeFileSync(join(process.env.CHECK_OUTPUT_DIR, "results.xml"), '<testsuite name="s">' + cases + '</testsuite>');
console.log("checked " + sha + " on " + process.env.CHECK_BRANCH);
process.exitCode = failing.length > 0 ? 1 : 0;
`,
    );
    const base = { github: "", queue_file: "", agents_dir: "", gates_dir: "", machines: {} };
    const kind = { command: [NODE, "run-check.cjs", "{sha}", "{tests}"], parse: { junit_path: "results.xml" } };
    const agents = new AgentsStore(":memory:");
    const manager = new ChecksManager({
      dbPath: data,
      outputDir: join(data, "checks-output"),
      isRunActive: (project, runId, agent) => agentRunIsActive(agents, project, runId, agent),
    });
    manager.load([
      { name: "demo", config: { ...base, name: "demo", repo, checks: { unit: kind } } as ProjectConfig },
      { name: "broken", config: { ...base, name: "broken", repo, checks: { "Bad Name": kind } } as ProjectConfig },
      { name: "plain", config: { ...base, name: "plain", repo } as ProjectConfig },
    ]);
    expect(manager.enabled()).toEqual(["demo"]);
    expect(manager.status()).toContainEqual(expect.objectContaining({ project: "broken", enabled: false, problem: expect.stringContaining("kind name") }));
    expect(manager.start()).toEqual(["demo"]);

    const app = Fastify();
    await registerChecksRoutes(app, { manager, defaultProject: () => "demo", dataDir: data });
    await app.ready();
    agents.insertRun(agentRun({ id: "run-e2e" }));
    const token = newBusToken();
    getBusStore("demo", data).issueToken("worker-a", "run-e2e", hashBusToken(token), Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const check = async (tests: string[], over: Record<string, unknown> = {}) => {
      const created = await app.inject({ method: "POST", url: "/api/checks", headers, payload: { kind: "unit", sha, branch: "feat-search", tests, ...over } });
      if (created.statusCode !== 201) return { status: created.statusCode, error: JSON.parse(created.body).error as string };
      const id = JSON.parse(created.body).data.id as string;
      const res = await app.inject({ method: "GET", url: `/api/checks/${id}?wait=60`, headers });
      return { id, ...JSON.parse(res.body).data };
    };

    try {
      const pass = await check(["OrderTest", "PaymentTest"]);
      expect(pass).toMatchObject({ status: "pass", failingTests: [] });
      expect(pass.logTail).toContain(`checked ${sha} on feat-search`);

      const fail = await check(["OrderTest", "RefundFailingTest"]);
      expect(fail).toMatchObject({ status: "fail", failingTests: ["RefundFailingTest"] });
      expect(existsSync(join(data, "checks-output", "demo", fail.id, "results.xml"))).toBe(true);

      const unpushed = await check(["OrderTest"], { sha: commit(repo, "local.txt", "local") });
      expect(unpushed.status).toBe(403);
      expect(unpushed.error).toContain("sha is not on branch");
    } finally {
      await manager.stop();
      await app.close();
      agents.close();
    }
    expect(manager.get("demo")).toBeUndefined();
  });
});
