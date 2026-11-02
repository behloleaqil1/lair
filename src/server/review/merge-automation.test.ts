/**
 * The merge gate's "any of" groups, the pre-merge check (merge.check_cmd)
 * and the automatic merge (merge.auto), through ReviewManager and the real
 * policy, signed-gate verification, store and local merge executor. Only
 * the git host's API, git, the clock and the check's process spawner are
 * stand-ins; the gate results are really signed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { GateResult, SignedGateResult } from "../../shared/policy-types.js";
import { generateNodeKeyPair, signGateResult } from "../gates/signature.js";
import { MAX_AUTO_GATE_READS, ReviewManager, autoMergeDecisionKey, type ReviewService } from "./service.js";
import { parseReviewConfig } from "./config.js";
import {
  CHECK_OUTPUT_BYTES,
  expandCheckCommand,
  plainLine,
  systemCheckRunner,
  type CheckOutput,
  type CheckRunOptions,
  type CheckRunner,
} from "./check.js";
import type { FetchLike } from "./github.js";
import type { DecisionRequest } from "./ports.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MINUTE = 60_000;
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const NODE = generateNodeKeyPair("gates-1");

const README: FakeFile = {
  filename: "docs/usage.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n # Usage\n-Old text\n+New text",
};

const managers: ReviewManager[] = [];
let dir: string | null = null;

afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** The check's process spawner: records each argv and its options, and answers as `reply` says. */
class FakeSpawner implements CheckRunner {
  calls: { argv: string[]; options: CheckRunOptions }[] = [];
  reply: (argv: string[]) => CheckOutput | Promise<CheckOutput> = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

  async run(argv: string[], options: CheckRunOptions): Promise<CheckOutput> {
    this.calls.push({ argv: [...argv], options });
    return this.reply(argv);
  }
}

let resultCount = 0;

/** A gate result signed by NODE (or `key`), at `sha`, finished `minutes` after 11:00. */
function signed(
  sha: string,
  pipelineId = "backend",
  status: "passed" | "failed" = "passed",
  options: { minutes?: number; key?: ReturnType<typeof generateNodeKeyPair> } = {},
): SignedGateResult {
  const start = Date.parse("2026-03-02T11:00:00.000Z") + (options.minutes ?? 0) * MINUTE;
  const result: GateResult = {
    id: `${pipelineId}-${sha.slice(0, 8)}-${++resultCount}`,
    pipelineId,
    commitSha: sha,
    branch: "agent/worker-a/change",
    projectId: "demo",
    nodeId: "gates-1",
    status,
    steps: [
      {
        name: "test",
        status: status === "passed" ? "passed" : "failed",
        exitCode: status === "passed" ? 0 : 1,
        durationMs: 5000,
        startedAt: new Date(start).toISOString(),
        completedAt: new Date(start + 5000).toISOString(),
      },
    ],
    selectedSteps: ["test"],
    durationMs: 5000,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(start + 5000).toISOString(),
    pipelineVersion: "1",
  };
  const key = options.key ?? NODE;
  return signGateResult(result, key.privateKey, key.publicKey);
}

interface Repo {
  remote: FakeRemote;
  base: string;
  head: string;
}

/** A host with main at `base` and PR #3 (green tier: docs) at `head`, one commit ahead. */
function repo(pull: { title?: string; message?: string; labels?: string[] } = {}): Repo {
  dir ??= mkdtempSync(join(tmpdir(), "lair-review-merge-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  const head = remote.commit([base], AGENT, pull.message ?? "change");
  remote.openPull({
    number: 3,
    title: pull.title ?? "A change",
    headRef: "agent/worker-a/change",
    headSha: head,
    files: [README],
    labels: pull.labels ?? [],
  });
  return { remote, base, head };
}

function projectConfig(review: Record<string, unknown>): ProjectConfig {
  return {
    name: "demo",
    repo: "/home/user/demo",
    github: "example-org/demo",
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: false,
    review,
  };
}

interface Rig extends Repo {
  manager: ReviewManager;
  service: ReviewService;
  clock: FakeClock;
  spawner: FakeSpawner;
  decisions: DecisionRequest[];
  /** One scan of open PRs, as the server's timer runs it */
  scan(): Promise<void>;
}

function boot(
  at: Repo,
  merge: Record<string, unknown> = {},
  options: { dbPath?: string; env?: NodeJS.ProcessEnv; fetch?: FetchLike; reviewers?: Record<string, unknown>; review?: Record<string, unknown> } = {},
): Rig {
  const clock = new FakeClock(NOW);
  const spawner = new FakeSpawner();
  const decisions: DecisionRequest[] = [];
  const manager = new ReviewManager({
    dbPath: options.dbPath ?? ":memory:",
    clock,
    git: new FakeGit(at.remote),
    fetch: options.fetch ?? fakeGitHubApi(at.remote),
    env: options.env ?? {},
    cwd: dir!,
    autoRequestMs: 0,
    checks: spawner,
    decisions: {
      async raise(request) {
        decisions.push(request);
        return { id: `decision-${decisions.length}`, channel: "inbox" };
      },
    },
  });
  managers.push(manager);
  manager.load([
    {
      name: "demo",
      config: projectConfig({
        enabled: true,
        authors: { branch_pattern: "agent/{agent}/**" },
        // Docs are green and need no review here, so a test's PR is ready once its gate passes
        reviewers: options.reviewers ?? { green: [] },
        merge: {
          gate: {
            source: "signed",
            required: ["backend"],
            node_keys: { "gates-1": NODE.publicKey },
            pipeline_versions: { backend: "1", docs: "1", lint: "1" },
          },
          method: "local",
          local_strategy: "ff-only",
          work_dir: join(dir!, "work"),
          ...merge,
        },
        ...options.review,
      }),
    },
  ]);
  const service = manager.get("demo");
  if (!service) throw new Error(`reviews are off: ${manager.info("demo").errors.join("; ")}`);
  return { ...at, manager, service, clock, spawner, decisions, scan: () => manager.requestOpenPullRequests() };
}

function condition(status: { conditions: { id: string; ok: boolean; detail: string }[] }, id: string) {
  return status.conditions.find((c) => c.id === id)!;
}

// ============ M3: any of ============

describe("gate requirements: any of", () => {
  const anyOf = { gate: { source: "signed", required: [{ any_of: ["backend", "docs"] }], node_keys: { "gates-1": NODE.publicKey }, pipeline_versions: { backend: "1", docs: "1", lint: "1" } } };

  it("is satisfied by any one passed, signed result at the head among its pipelines", async () => {
    const { service, head } = boot(repo(), anyOf);
    const before = await service.status(3);
    expect(before.gate).toEqual([expect.objectContaining({ name: "any of (backend, docs)", status: "missing" })]);
    expect(before.reasons).toContain(
      `Gate at head: any of (backend, docs): missing at ${head.slice(0, 7)} (no signed result at this commit for any of them)`,
    );

    service.addGateResult(signed(head, "docs"));
    const after = await service.status(3);
    expect(after.gate).toEqual([expect.objectContaining({ name: "any of (backend, docs)", status: "passed", sha: head })]);
    expect(after.gate[0].detail).toMatch(/^docs: signed result docs-/);
    expect(condition(after, "gate")).toMatchObject({ ok: true, detail: `any of (backend, docs) passed at ${head.slice(0, 7)}` });
    expect(after.canMerge).toBe(true);
  });

  it("is not satisfied by a failed result, and the reason names the group and each pipeline", async () => {
    const { service, head } = boot(repo(), anyOf);
    service.addGateResult(signed(head, "backend", "failed"));
    const status = await service.status(3);
    expect(status.gate[0]).toMatchObject({ name: "any of (backend, docs)", status: "failed" });
    const reason = status.reasons.find((r) => r.startsWith("Gate at head:"))!;
    expect(reason).toContain(`any of (backend, docs): failed at ${head.slice(0, 7)}`);
    expect(reason).toContain("backend failed (Gate backend-");
    expect(reason).toContain("docs missing");
    expect(status.canMerge).toBe(false);
  });

  it("is not satisfied by a pass at another commit, nor by a pass a newer failure of the same pipeline replaced", async () => {
    const { service, base, head } = boot(repo(), anyOf);
    // A pass at main's commit says nothing about the PR's head
    service.addGateResult(signed(base, "docs"));
    expect((await service.status(3)).gate[0]).toMatchObject({ status: "missing", sha: head });

    // The newest trustworthy result of a pipeline decides: an older pass doesn't count
    service.addGateResult(signed(head, "docs", "passed", { minutes: 0 }));
    service.addGateResult(signed(head, "docs", "failed", { minutes: 10 }));
    const status = await service.status(3);
    expect(status.gate[0]).toMatchObject({ status: "failed" });
    expect(status.canMerge).toBe(false);

    // A pass signed with a key review doesn't trust is refused, and is no pass either
    expect(() => service.addGateResult(signed(head, "backend", "passed", { key: generateNodeKeyPair("gates-1") }))).toThrow(
      "does not verify",
    );
    expect((await service.status(3)).gate[0]).toMatchObject({ status: "failed" });
  });

  it("keeps the ALL-of meaning of plain entries next to a group", async () => {
    const { service, head } = boot(repo(), {
      gate: { ...anyOf.gate, required: ["lint", { any_of: ["backend", "docs"] }] },
    });
    service.addGateResult(signed(head, "docs"));
    const one = await service.status(3);
    expect(one.gate.map((g) => [g.name, g.status])).toEqual([
      ["lint", "missing"],
      ["any of (backend, docs)", "passed"],
    ]);
    expect(condition(one, "gate").detail).toBe(`lint: missing at ${head.slice(0, 7)} (no signed result at this commit)`);
    expect(one.canMerge).toBe(false);

    service.addGateResult(signed(head, "lint"));
    const both = await service.status(3);
    expect(condition(both, "gate")).toMatchObject({ ok: true, detail: `lint, any of (backend, docs) passed at ${head.slice(0, 7)}` });
    expect(both.canMerge).toBe(true);
  });

  it("refuses an empty group or one with other keys in the config", () => {
    const errorsOf = (required: unknown[]) => {
      const parsed = parseReviewConfig(
        { enabled: true, merge: { gate: { ...anyOf.gate, required } } },
        { github: "example-org/demo" },
      );
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errorsOf([{ any_of: [] }])[0]).toContain("review.merge.gate.required.0.any_of");
    expect(errorsOf([{ any_of: ["backend"], all_of: ["docs"] }])[0]).toContain("all_of");
    expect(errorsOf([42])[0]).toBe("review.merge.gate.required.0: use a pipeline id or {any_of: [pipeline ids]}");
    expect(errorsOf(["backend", { any_of: ["docs", "lint"] }])).toEqual([]);
  });
});

// ============ M5: the pre-merge check ============

describe("merge.check_cmd", () => {
  const CHECK = ["/opt/checks/migration-order", "--pr", "{pr}", "--head={head}", "{base}", "{repo}"];

  it("runs after the policy allows the merge: an argv with its placeholders, Lair's minimal environment, then the merge", async () => {
    const rig = boot(repo(), { check_cmd: CHECK }, {
      env: { PATH: "/usr/bin:/bin", HOME: "/home/user", GITHUB_TOKEN: "ghp_not_for_the_check", LAIR_OWNER_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y" },
    });
    const { service, spawner, remote, head } = rig;

    // The policy refuses first (no gate yet): the check doesn't run
    const early = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(early).toMatchObject({ merged: false, refusedBy: "policy" });
    expect(spawner.calls).toEqual([]);

    service.addGateResult(signed(head));
    const merged = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(merged.merged).toBe(true);
    expect(spawner.calls).toEqual([
      {
        argv: ["/opt/checks/migration-order", "--pr", "3", `--head=${head}`, "main", "example-org/demo"],
        options: { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: "/home/user" }, timeoutMs: 300_000, maxOutputBytes: CHECK_OUTPUT_BYTES },
      },
    ]);
    expect(remote.branches.get("main")).toBe(head);
  });

  it("refuses the merge when it exits non-zero, quoting its first lines (plain), and publishes nothing", async () => {
    const { service, spawner, remote, base, head } = boot(repo(), { check_cmd: CHECK });
    service.addGateResult(signed(head));
    const esc = String.fromCharCode(27);
    spawner.reply = () => ({
      code: 3,
      stdout: `${esc}[31mmigration V12 is already on main${esc}[0m\n\n  rename it to V13\n${"x".repeat(500)}\nfourth\nfifth\nsixth\n`,
      stderr: "from stderr\n",
      timedOut: false,
    });
    const refused = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(refused.merged).toBe(false);
    expect(refused.refusedBy).toBe("check");
    expect(refused.reasons).toEqual([
      `Pre-merge check: check_cmd exited 3: migration V12 is already on main | rename it to V13 | ${"x".repeat(197)}... | fourth | fifth`,
    ]);
    expect(remote.branches.get("main")).toBe(base);
    expect(remote.pulls.get(3)).toMatchObject({ state: "open", merged: false });
    expect(service.listMerges()).toEqual([]);
  });

  it("refuses the merge when it times out", async () => {
    const { service, spawner, remote, base, head } = boot(repo(), { check_cmd: CHECK, check_timeout_seconds: 5 });
    service.addGateResult(signed(head));
    spawner.reply = () => ({ code: null, stdout: "still checking\n", stderr: "", timedOut: true });
    const refused = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(refused).toMatchObject({ merged: false, refusedBy: "check" });
    expect(refused.reasons).toEqual(["Pre-merge check: check_cmd did not finish within 5 s: still checking"]);
    expect(spawner.calls[0].options.timeoutMs).toBe(5000);
    expect(remote.branches.get("main")).toBe(base);
  });

  it("refuses a value that isn't its placeholder's shape, or would start an option, before anything runs", async () => {
    // A default branch whose name would be read as an option
    const at = repo();
    const evil = "--upload-pack=touch-pwned";
    at.remote.branches.set(evil, at.base);
    at.remote.pulls.get(3)!.baseRef = evil;
    const { service, spawner, remote, head } = boot(at, { check_cmd: CHECK }, { review: { default_branch: evil } });
    service.addGateResult(signed(head));
    expect((await service.status(3)).canMerge).toBe(true);
    const refused = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(refused).toMatchObject({ merged: false, refusedBy: "check" });
    expect(refused.reasons).toEqual([
      `Pre-merge check: {base} would be "${evil}", which is not a branch name: check_cmd was not run`,
    ]);
    expect(spawner.calls).toEqual([]);
    expect(remote.pulls.get(3)).toMatchObject({ state: "open", merged: false });

    // Every placeholder is checked, and only the ones the command uses
    const values = { pr: 3, head: "a".repeat(40), base: "main", repo: "example-org/demo" };
    expect(expandCheckCommand(["/bin/check", "{head}"], { ...values, head: "HEAD~1" })).toEqual({
      error: '{head} would be "HEAD~1", which is not a full commit sha: check_cmd was not run',
    });
    expect(expandCheckCommand(["/bin/check", "--repo={repo}"], { ...values, repo: "-o/x" })).toMatchObject({
      error: expect.stringContaining("{repo} would be"),
    });
    expect(expandCheckCommand(["/bin/check", "{base}"], { ...values, base: "main\n--force" })).toMatchObject({
      error: expect.stringContaining('{base} would be "main --force"'),
    });
    expect(expandCheckCommand(["/bin/check", "{base}"], { ...values, base: "a/../b" })).toMatchObject({ error: expect.any(String) });
    expect(expandCheckCommand(["/bin/check", "{pr}"], { ...values, base: "--unused" })).toEqual({ argv: ["/bin/check", "3"] });
  });

  it("is a config error with an unknown placeholder, or a placeholder as the program", () => {
    const errorsOf = (check_cmd: string[]) => {
      const parsed = parseReviewConfig(
        { enabled: true, merge: { gate: { source: "checks", required: ["build"] }, check_cmd } },
        { github: "example-org/demo" },
      );
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errorsOf(["/bin/check", "{sha}"])).toEqual([
      "review.merge.check_cmd.1: unknown placeholder {sha} (use {pr}, {head}, {base}, {repo})",
    ]);
    expect(errorsOf(["{repo}", "x"])).toEqual(["review.merge.check_cmd.0: the program is fixed: a placeholder can't be it"]);
    expect(errorsOf(["/bin/check", "--pr={pr}", "{head}"])).toEqual([]);
  });

  it("the real spawner: no shell, only the given environment, capped output, and a timeout that kills", async () => {
    const runner = systemCheckRunner();
    const node = process.execPath;
    const options = { cwd: process.cwd(), env: { ONLY_THIS: "1" }, timeoutMs: 10_000, maxOutputBytes: CHECK_OUTPUT_BYTES };

    const literal = await runner.run(
      [node, "-e", "console.log(process.argv[1]); console.log(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').join(',')); process.exit(4)", "$(echo hi); rm -rf /"],
      options,
    );
    expect(literal).toMatchObject({ code: 4, timedOut: false });
    expect(literal.stdout.split("\n").slice(0, 2)).toEqual(["$(echo hi); rm -rf /", "ONLY_THIS"]);

    const loud = await runner.run([node, "-e", "process.stdout.write('y'.repeat(300 * 1024))"], options);
    expect(loud.code).toBe(0);
    expect(loud.stdout.length).toBe(CHECK_OUTPUT_BYTES);

    const started = Date.now();
    const slow = await runner.run([node, "-e", "setTimeout(() => {}, 60000)"], { ...options, timeoutMs: 300 });
    expect(slow).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);

    const missing = await runner.run([join(tmpdir(), "no-such-check-program")], options);
    expect(missing.code).toBeNull();
    expect(missing.error).toBeTruthy();
  });

  it("makes its output plain: every escape sequence dropped, control and text-direction characters made spaces", () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    // A hyperlink (OSC 8, ended by ST), a window title (OSC 0, ended by BEL), DCS, charset and cursor saves, CSI colours
    expect(plainLine(`${esc}]8;;https://example.invalid/x${esc}\\click${esc}]8;;${esc}\\ here`)).toBe("click here");
    expect(plainLine(`${esc}]0;a window title${bel}done`)).toBe("done");
    expect(plainLine(`${esc}Pq#0;2;0;0;0${esc}\\after`)).toBe("after");
    expect(plainLine(`${esc}(Bplain${esc}7 saved${esc}8`)).toBe("plain saved");
    expect(plainLine(`${esc}[1;31mred${esc}[0m`)).toBe("red");
    // C1 controls, a right-to-left override, a tab
    expect(plainLine(`a${String.fromCharCode(0x9b)}b${String.fromCharCode(0x202e)}c\td`)).toBe("a b c d");
    // An unterminated string swallows the rest of the line, never shows it
    expect(plainLine(`kept ${esc}]0;title`)).toBe("kept ");
  });
});

// ============ M6: automatic merge ============

describe("merge.auto", () => {
  it("merges a ready PR once, through the policy path, recorded as lair:policy", async () => {
    const { service, remote, base, head, clock, scan, decisions } = boot(repo(), { auto: true });
    // Not ready (no gate yet): nothing happens
    await scan();
    expect(remote.branches.get("main")).toBe(base);

    service.addGateResult(signed(head));
    await scan();
    expect(remote.branches.get("main")).toBe(head);
    expect(remote.pulls.get(3)).toMatchObject({ state: "closed", merged: true });
    expect(service.listMerges()).toEqual([
      expect.objectContaining({ pr: 3, headSha: head, initiatedBy: "lair:policy", method: "local", strategy: "ff-only" }),
    ]);

    clock.advance(10 * MINUTE);
    await scan();
    expect(service.listMerges()).toHaveLength(1);
    expect(decisions).toEqual([]);
  });

  it("does nothing when merge.auto is false (the default)", async () => {
    const { service, remote, base, head, clock, scan } = boot(repo());
    service.addGateResult(signed(head));
    expect((await service.status(3)).canMerge).toBe(true);
    await scan();
    clock.advance(10 * MINUTE);
    await scan();
    expect(remote.branches.get("main")).toBe(base);
    expect(service.listMerges()).toEqual([]);
  });

  it("merges at most one PR per scan, and none within auto_min_interval_seconds of the last", async () => {
    const at = repo();
    // PR #4 is stacked on #3, so it is still up to date once #3 lands
    const next = at.remote.commit([at.head], AGENT, "more");
    at.remote.openPull({ number: 4, headRef: "agent/worker-a/more", headSha: next, files: [README] });
    const { service, remote, head, clock, scan } = boot(at, { auto: true });
    service.addGateResult(signed(head));
    service.addGateResult(signed(next));

    await scan();
    expect(remote.branches.get("main")).toBe(head);
    expect(remote.pulls.get(4)).toMatchObject({ state: "open" });

    // Ready, but too soon after the last automatic merge
    clock.advance(119_000);
    await scan();
    expect(remote.pulls.get(4)).toMatchObject({ state: "open" });

    clock.advance(2000);
    await scan();
    expect(remote.branches.get("main")).toBe(next);
    // Newest first
    expect(service.listMerges().map((m) => [m.pr, m.initiatedBy])).toEqual([
      [4, "lair:policy"],
      [3, "lair:policy"],
    ]);
  });

  it("goes through check_cmd: a failing check refuses it, raises one decision, and is not tried again at that head", async () => {
    const { service, remote, base, head, clock, scan, spawner, decisions } = boot(repo(), {
      auto: true,
      check_cmd: ["/opt/checks/migration-order", "--pr", "{pr}"],
    });
    spawner.reply = () => ({ code: 1, stdout: "migration V12 is already on main\n", stderr: "", timedOut: false });
    service.addGateResult(signed(head));

    await scan();
    expect(spawner.calls.map((c) => c.argv)).toEqual([["/opt/checks/migration-order", "--pr", "3"]]);
    expect(remote.branches.get("main")).toBe(base);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      project: "demo",
      key: autoMergeDecisionKey(3, head),
      question: `Automatic merge of PR #3 failed at ${head.slice(0, 7)}`,
    });
    expect(decisions[0].context).toContain("Pre-merge check: check_cmd exited 1: migration V12 is already on main");

    // Not retried hot, nor later at the same head, and asked only once
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * MINUTE);
      await scan();
    }
    expect(spawner.calls).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(remote.branches.get("main")).toBe(base);

    // A new head is a new attempt: its check passes, and it merges
    const fixed = remote.commit([head], AGENT, "rename the migration");
    remote.pushToPull(3, fixed);
    service.addGateResult(signed(fixed));
    spawner.reply = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
    await scan();
    expect(remote.branches.get("main")).toBe(fixed);
    expect(service.listMerges()).toEqual([expect.objectContaining({ headSha: fixed, initiatedBy: "lair:policy" })]);
  });

  it("does not merge when the head moves between the evaluation and the merge", async () => {
    const at = repo();
    const api = fakeGitHubApi(at.remote);
    let reads = 0;
    let moveAt = -1;
    let moved: string | null = null;
    // The PR's second read in a scan is merge()'s own evaluation: a push lands just before it
    const fetch: FetchLike = async (url, init) => {
      if ((init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/pulls/3") && ++reads === moveAt) {
        moved = at.remote.commit([at.head], AGENT, "a late push");
        at.remote.pushToPull(3, moved);
      }
      return api(url, init);
    };
    const { service, remote, base, head, clock, scan, decisions } = boot(at, { auto: true }, { fetch });
    service.addGateResult(signed(head));
    expect((await service.status(3)).canMerge).toBe(true);

    moveAt = reads + 2;
    await scan();
    expect(moved).not.toBeNull();
    expect(remote.branches.get("main")).toBe(base);
    expect(remote.pulls.get(3)).toMatchObject({ state: "open", headSha: moved });
    expect(service.listMerges()).toEqual([]);
    // A moved head is no failure: nobody is asked
    expect(decisions).toEqual([]);

    // The new head has no gate result: it waits for one
    clock.advance(MINUTE);
    await scan();
    expect(remote.branches.get("main")).toBe(base);

    // The skipped attempt ran nothing, so auto_min_interval_seconds doesn't hold the new head back
    const newHead = remote.pulls.get(3)!.headSha;
    service.addGateResult(signed(newHead));
    await scan();
    expect(remote.branches.get("main")).toBe(newHead);
    expect(service.listMerges()).toEqual([expect.objectContaining({ headSha: newHead, initiatedBy: "lair:policy" })]);
  });

  it("with source: checks, reads at most MAX_AUTO_GATE_READS gates from the host per scan, and the next scan goes on from there", async () => {
    const at = repo();
    let ready = "";
    for (let i = 0; i < 25; i++) {
      const sha = at.remote.commit([at.base], AGENT, `change ${i}`);
      at.remote.openPull({ number: 10 + i, headRef: `agent/worker-a/change-${i}`, headSha: sha, files: [README] });
      if (i === 24) ready = sha;
    }
    // Only the last of 26 open PRs has its check run
    at.remote.setChecks(ready, [["build", "success"]]);
    const { remote, base, scan } = boot(at, { auto: true, gate: { source: "checks", required: ["build"] } });
    const checkReads = () => remote.requests.filter((r) => r.path.includes("/check-runs")).length;

    await scan();
    expect(checkReads()).toBe(MAX_AUTO_GATE_READS);
    expect(remote.branches.get("main")).toBe(base);

    // The next scan starts after the last PR the first one read, and reaches the ready one
    await scan();
    expect(remote.branches.get("main")).toBe(ready);
    expect(remote.pulls.get(34)).toMatchObject({ state: "closed", merged: true });
    expect(checkReads()).toBeLessThanOrEqual(2 * MAX_AUTO_GATE_READS + 2);
  });

  it("with hold_when_default_red, a revert the red default branch lets through still needs the red tier's reviews", async () => {
    const at = repo({
      title: 'Revert "Add orders"',
      message: `Revert "Add orders"\n\nThis reverts commit ${"a".repeat(40)}.`,
      labels: ["revert"],
    });
    const { service, remote, base, head, clock, scan } = boot(at, { auto: true, hold_exempt_labels: ["revert"] });
    // main is red; the PR is a proven revert with the exempt label, and its own (green) tier needs no review
    service.addGateResult(signed(base, "backend", "failed"));
    service.addGateResult(signed(head));
    const status = await service.status(3);
    expect(status.risk.tier).toBe("green");
    expect(condition(status, "holds").ok).toBe(true);
    expect(status.canMerge).toBe(true);

    // The owner could merge it; the automatic path waits for the red tier's reviews (a human, by default)
    await scan();
    clock.advance(10 * MINUTE);
    await scan();
    expect(remote.branches.get("main")).toBe(base);

    await service.submitReview(
      3,
      { reviewer: { id: "owner", kind: "human" }, headSha: head, verdict: "approve", summary: "revert it", findings: [] },
      { assignmentToken: null, client: null, owner: true },
    );
    await scan();
    expect(remote.branches.get("main")).toBe(head);
    expect(service.listMerges()).toEqual([expect.objectContaining({ pr: 3, initiatedBy: "lair:policy" })]);
  });

  const CHECKED_AUTO = { auto: true, check_cmd: ["/opt/checks/migration-order", "--pr", "{pr}"] };

  /** A server that starts an automatic merge of PR #3 and is killed while its check runs. */
  async function crashMidMerge(at: Repo, dbPath: string): Promise<void> {
    const first = boot(at, CHECKED_AUTO, { dbPath });
    first.service.addGateResult(signed(at.head));
    first.spawner.reply = () => new Promise<CheckOutput>(() => {});
    void first.scan();
    for (let i = 0; i < 200 && first.spawner.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.spawner.calls).toHaveLength(1);
    first.manager.close();
  }

  it("never runs an automatic merge a restart interrupted again blindly: it is reported once", async () => {
    const at = repo();
    const dbPath = join(dir!, "review.db");
    const check = CHECKED_AUTO;
    await crashMidMerge(at, dbPath);

    // The restarted server finds the attempt: it asks the owner once and doesn't merge at that head
    const second = boot(at, check, { dbPath });
    for (let i = 0; i < 3; i++) {
      await second.scan();
      second.clock.advance(10 * MINUTE);
    }
    expect(second.spawner.calls).toEqual([]);
    expect(at.remote.branches.get("main")).toBe(at.base);
    expect(second.decisions).toEqual([
      expect.objectContaining({ key: autoMergeDecisionKey(3, at.head), question: `Automatic merge of PR #3 at ${at.head.slice(0, 7)} was interrupted` }),
    ]);

    // A new head merges as usual
    const next = at.remote.commit([at.head], AGENT, "next");
    at.remote.pushToPull(3, next);
    second.service.addGateResult(signed(next));
    await second.scan();
    expect(at.remote.branches.get("main")).toBe(next);
    expect(second.spawner.calls).toHaveLength(1);
  });

  it("reports an interrupted automatic merge when the project loads, even with merge.auto turned off since", async () => {
    const at = repo();
    const dbPath = join(dir!, "review.db");
    await crashMidMerge(at, dbPath);

    // The owner turned automatic merges off before restarting: the decision is raised all the same, once
    const second = boot(at, { check_cmd: CHECKED_AUTO.check_cmd }, { dbPath });
    const interrupted = expect.objectContaining({
      key: autoMergeDecisionKey(3, at.head),
      question: `Automatic merge of PR #3 at ${at.head.slice(0, 7)} was interrupted`,
    });
    expect(second.decisions).toEqual([interrupted]);
    await second.scan();
    second.clock.advance(10 * MINUTE);
    await second.scan();
    expect(second.decisions).toEqual([interrupted]);
    expect(at.remote.branches.get("main")).toBe(at.base);
  });
});

// ============ M8: auto_tiers ============

/** A file that triggers red tier (auth). */
const AUTH_FILE: FakeFile = {
  filename: "src/auth/session.ts",
  status: "modified",
  additions: 5,
  deletions: 2,
  patch: "@@ -1,2 +1,5 @@\n // auth\n-old\n+new",
};

/** A repo with PR #3 as a RED tier change (auth file). */
function redRepo(): Repo {
  dir ??= mkdtempSync(join(tmpdir(), "lair-review-auto-tiers-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  const head = remote.commit([base], AGENT, "auth change");
  remote.openPull({
    number: 3,
    title: "Update auth session",
    headRef: "agent/worker-a/auth-fix",
    headSha: head,
    files: [AUTH_FILE],
    labels: [],
  });
  return { remote, base, head };
}

describe("merge.auto_tiers", () => {
  it("does not auto-merge a red tier PR when auto_tiers is [amber, green], and raises no decision", async () => {
    const at = redRepo();
    const { service, remote, base, head, clock, scan, decisions } = boot(at, {
      auto: true,
      auto_tiers: ["amber", "green"],
    }, {
      // Red tier requires a human review by default; skip it so canMerge is true
      reviewers: { red: [] },
    });
    service.addGateResult(signed(head));

    // The PR is ready to merge (canMerge: true), but should not auto-merge
    const status = await service.status(3);
    expect(status.risk.tier).toBe("red");
    expect(status.canMerge).toBe(true);
    expect(status.autoMergeStatus).toBe("manual");

    // Multiple scans: it is never auto-merged and no decision is raised
    for (let i = 0; i < 3; i++) {
      await scan();
      clock.advance(10 * MINUTE);
    }
    expect(remote.branches.get("main")).toBe(base);
    expect(service.listMerges()).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it("auto-merges amber and green tier PRs when auto_tiers is [amber, green]", async () => {
    // Green tier: docs
    const at = repo();
    const { service, remote, head, scan } = boot(at, {
      auto: true,
      auto_tiers: ["amber", "green"],
    });
    service.addGateResult(signed(head));

    const status = await service.status(3);
    expect(status.risk.tier).toBe("green");
    expect(status.autoMergeStatus).toBe("auto");

    await scan();
    expect(remote.branches.get("main")).toBe(head);
    expect(service.listMerges()).toEqual([
      expect.objectContaining({ pr: 3, initiatedBy: "lair:policy" }),
    ]);
  });

  it("allows owner's Merge to work for red tier PR even with auto_tiers [amber, green]", async () => {
    const at = redRepo();
    const { service, remote, head } = boot(at, {
      auto: true,
      auto_tiers: ["amber", "green"],
    }, {
      reviewers: { red: [] },
    });
    service.addGateResult(signed(head));

    const status = await service.status(3);
    expect(status.risk.tier).toBe("red");
    expect(status.canMerge).toBe(true);

    // The owner can still merge it manually
    const result = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(result.merged).toBe(true);
    expect(remote.branches.get("main")).toBe(head);
  });

  it("reports autoMergeStatus as null when auto is false", async () => {
    const { service, head } = boot(repo(), { auto: false });
    service.addGateResult(signed(head));

    const status = await service.status(3);
    expect(status.autoMergeStatus).toBeNull();
  });

  it("reports autoMergeStatus as 'auto' for all tiers when auto_tiers is absent (default)", async () => {
    // Test with red tier - should be 'auto' when auto_tiers is not set
    const at = redRepo();
    const { service, head } = boot(at, { auto: true }, { reviewers: { red: [] } });
    service.addGateResult(signed(head));

    const status = await service.status(3);
    expect(status.risk.tier).toBe("red");
    expect(status.autoMergeStatus).toBe("auto");
  });

  it("stops auto-merging a tier when a config reload removes it from auto_tiers", async () => {
    const at = redRepo();
    const dbPath = join(dir!, "review.db");
    // First: auto_tiers includes red
    const first = boot(at, { auto: true, auto_tiers: ["red", "amber", "green"] }, { dbPath, reviewers: { red: [] } });
    first.service.addGateResult(signed(at.head));

    let status = await first.service.status(3);
    expect(status.autoMergeStatus).toBe("auto");
    first.manager.close();

    // Reload with red removed from auto_tiers
    const second = boot(at, { auto: true, auto_tiers: ["amber", "green"] }, { dbPath, reviewers: { red: [] } });
    second.service.addGateResult(signed(at.head));

    status = await second.service.status(3);
    expect(status.autoMergeStatus).toBe("manual");

    // Scan does not auto-merge
    await second.scan();
    second.clock.advance(10 * MINUTE);
    await second.scan();
    expect(at.remote.branches.get("main")).toBe(at.base);
    expect(second.decisions).toEqual([]);
  });
});

// ============ raiseAutoMergeFailure recommendations ============

describe("raiseAutoMergeFailure recommendation", () => {
  it("recommends 'Leave it unmerged' when check_cmd fails: merging manually would hit the same block", async () => {
    const { service, remote, base, head, scan, spawner, decisions } = boot(repo(), {
      auto: true,
      check_cmd: ["/opt/checks/migration-order", "--pr", "{pr}"],
    });
    spawner.reply = () => ({ code: 1, stdout: "migration V12 conflicts\n", stderr: "", timedOut: false });
    service.addGateResult(signed(head));

    await scan();
    expect(remote.branches.get("main")).toBe(base);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      key: autoMergeDecisionKey(3, head),
      question: `Automatic merge of PR #3 failed at ${head.slice(0, 7)}`,
      recommended: "Leave it unmerged",
    });
    expect(decisions[0].context).toContain("The pre-merge check (merge.check_cmd) blocked this PR");
    expect(decisions[0].context).toContain("Fix the cause and push a new head");
  });

  it("recommends 'Merge it from the PR's page' when the executor fails: transient errors may not recur", async () => {
    const at = repo();
    // Make the merge fail at the executor stage (push failure)
    const api = fakeGitHubApi(at.remote);
    const fetch: FetchLike = async (url, init) => {
      // The local merger doesn't use the API to push, but we can make the
      // PR state check fail to simulate a transient host error
      if ((init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/pulls/3")) {
        // First evaluation succeeds, second (in merge) fails
        const reads = at.remote.requests.filter((r) => r.path.endsWith("/pulls/3")).length;
        if (reads >= 1) {
          throw new Error("GitHub API timeout");
        }
      }
      return api(url, init);
    };
    const { service, remote, base, head, scan, decisions } = boot(at, { auto: true }, { fetch });
    service.addGateResult(signed(head));

    // The scan evaluates the PR successfully, then the merge's own evaluation fails
    await scan();
    expect(remote.branches.get("main")).toBe(base);
    // This is caught as an exception (not a refusal), so it recommends merge from page
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      recommended: "Merge it from the PR's page",
    });
    expect(decisions[0].context).toContain("Lair does not try again at this head");
    expect(decisions[0].context).toContain("Merge it from its page in PRs once the cause is fixed");
  });

  it("recommends 'Leave it unmerged' when check_cmd times out: the check didn't finish, and might refuse with more time", async () => {
    const { service, remote, base, head, scan, spawner, decisions } = boot(repo(), {
      auto: true,
      check_cmd: ["/opt/checks/slow-check"],
      check_timeout_seconds: 1,
    });
    spawner.reply = () => ({ code: null, stdout: "still running...\n", stderr: "", timedOut: true });
    service.addGateResult(signed(head));

    await scan();
    expect(remote.branches.get("main")).toBe(base);
    expect(decisions).toHaveLength(1);
    // A timeout is still a "check" refusal: the check might refuse it on a longer timeout
    expect(decisions[0]).toMatchObject({
      recommended: "Leave it unmerged",
    });
    expect(decisions[0].context).toContain("The pre-merge check (merge.check_cmd) blocked this PR");
  });
});
