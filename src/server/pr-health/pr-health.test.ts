/**
 * PR health, observe only (docs/design/pr-health.md section 5, PR 2a and
 * 2b): through PrHealthManager.load, start and the monitor's tick() (what its
 * timer calls), with GitHub faked only at FetchLike (the review module's
 * fake API over an in-memory repository, in GitHub's REST shapes: a list item
 * has no mergeable). The clock is a test clock. Fill snapshots are the line
 * views fill emits, built from tasks file text by fill's own parser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { FillLineState, FillLineView, FillStatusView } from "../../shared/agents-types.js";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { parseTasksFile } from "../agents/fill.js";
import { EventBus } from "../core/event-bus.js";
import { serverModules } from "../reload/modules.js";
import type { FetchLike } from "../review/github.js";
import { ACTIONS_APP, FakeClock, FakeRemote, fakeGitHubApi, type FakePull } from "../review/testing/fakes.js";
import { PrHealthManager, parsePrHealthConfig, registerPrHealthRoutes, startedLine } from "./index.js";

const W = { name: "W", email: "w@example.com" };
const MIN = 60_000;
const T0 = Date.parse("2026-01-01T01:00:00Z");
const GREEN: [string, string][] = [["build", "success"]];
const quiet = { log: () => undefined, warn: () => undefined };
const APP = { repo: "example/app", default: true };
const LIB = { repo: "example/lib" };

const config = (extra: Record<string, unknown>): ProjectConfig =>
  ({ name: "demo", repo: "/home/user/demo", github: "example/app", queue_file: "q", agents_dir: "a", gates_dir: "g", machines: {}, ...extra }) as unknown as ProjectConfig;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.useRealTimers();
});

function remote(repo: string): FakeRemote {
  const r = new FakeRemote(repo);
  r.branches.set("main", r.commit([], W, "init"));
  return r;
}

let counter = 0;
/** A PR forked from main's tip, with green checks unless `checks` says otherwise (null: none) */
function pr(r: FakeRemote, number: number, over: Partial<FakePull> = {}, checks: [string, string][] | null = GREEN): string {
  const head = r.commit([r.branches.get("main") as string], W, `pr ${number} ${++counter}`);
  r.openPull({ number, headRef: `agent/worker-a/pr-${number}`, headSha: head, files: [], ...over });
  if (checks) r.setChecks(head, checks);
  return head;
}

/** n commits on main: the PRs forked before are n further behind */
function advanceMain(r: FakeRemote, n: number): string {
  for (let i = 0; i < n; i++) r.branches.set("main", r.commit([r.branches.get("main") as string], W, `main ${++counter}`));
  return r.branches.get("main") as string;
}

const ago = (min: number) => new Date(T0 - min * MIN).toISOString();

/** Fill's last check over these tasks file lines (fill's parser), each started unless `states` says otherwise */
function fillView(lines: string[], states: Record<number, FillLineState> = {}, over: Partial<FillStatusView> = {}): FillStatusView {
  const views: FillLineView[] = parseTasksFile(lines.join("\n")).map((e) => {
    const base = { hold: null, releasable: false, waiting: null, runId: null, decisionId: null };
    if (e.kind === "malformed") return { ...base, line: e.line, agent: null, name: null, task: null, description: null, state: "malformed", detail: `${e.reason}: ${e.text}` };
    return { ...base, line: e.line, agent: e.agent, name: e.name, task: e.task, description: e.description, state: states[e.line] ?? "started", detail: "" };
  });
  const loop = { enabled: true, running: true, tasksFile: "/home/user/demo/tasks.md", agents: [], maxActive: 4, active: 0, intervalSeconds: 60 };
  return { ...loop, lastCheck: ago(1), lastError: null, lines: views, unmatchedReports: [], warnings: [], ...over };
}

function setup(prHealth: Record<string, unknown> = {}, repos: unknown = [APP], extra: Record<string, unknown> = {}) {
  const app = remote("example/app");
  const lib = remote("example/lib");
  const apis = { app: fakeGitHubApi(app), lib: fakeGitHubApi(lib) };
  const clock = new FakeClock(T0);
  const requests: string[] = [];
  /** Repositories (owner/name) or request paths whose requests never answer (the host's timeout ends them) */
  const hang = new Set<string>();
  /** Request paths answered 200 with this body instead */
  const answers = new Map<string, unknown>();
  /** Repositories that answer 429 with this x-ratelimit-reset (epoch s) */
  const limited = new Map<string, number>();
  const net = { delayMs: 0 };
  /** What the agents module's fill shows (null: the project has no agents module) */
  const fill: { view: FillStatusView | null } = { view: null };
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    clock.advance(net.delayMs);
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1] ?? "";
    const signal = init?.signal;
    if (hang.has(repo) || hang.has(path)) return new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    if (answers.has(path)) return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(answers.get(path)) };
    const reset = limited.get(repo);
    if (reset !== undefined) {
      const headers = { get: (n: string) => (n === "x-ratelimit-reset" ? String(reset) : n === "x-ratelimit-remaining" ? "0" : null) };
      return { status: 429, ok: false, headers, text: async () => JSON.stringify({ message: "API rate limit exceeded" }) };
    }
    return (repo === "example/lib" ? apis.lib : apis.app)(url, init);
  };
  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (e) => {
    events.push(e);
  });
  // The agents module as index.ts passes it: get(project)?.fillStatus()
  const agents = { get: (project: string) => (project === "demo" && fill.view ? { fillStatus: () => fill.view as FillStatusView } : undefined) };
  const manager = new PrHealthManager({ events: bus, agents, fetch, env: {}, now: () => clock.now(), log: quiet });
  manager.load([{ name: "demo", config: config({ repos, ...extra, pr_health: { enabled: true, ...prHealth } }) }]);
  cleanups.push(() => manager.stop());
  const monitor = manager.get("demo");
  if (!monitor) throw new Error(manager.status("demo").lastError ?? "not loaded");
  const status = () => manager.status("demo");
  return {
    app,
    lib,
    clock,
    requests,
    hang,
    answers,
    limited,
    net,
    fill,
    events,
    status,
    tick: async () => expect(await monitor.tick()).not.toBeNull(),
    kinds: () => status().findings.map((f) => `${f.repo}#${f.pr}:${f.kind}`).sort(),
    finding: (pr: number, kind: string) => status().findings.find((f) => f.pr === pr && f.kind === kind),
    of: (type: string) => events.filter((e) => e.type === type).map((e) => e.data),
  };
}

describe("PR health: off, config and the event loop", () => {
  it("AT-10 prHealth_off_by_default: no block, no instance, no timer, no request; empty repos is inactive with a reason", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const fetch: FetchLike = async (url) => {
      requests.push(url);
      throw new Error("no request was expected");
    };
    const manager = new PrHealthManager({ fetch, env: {}, log: quiet, firstTickMs: 10 });
    cleanups.push(() => manager.stop());
    manager.load([
      { name: "absent", config: config({}) },
      { name: "off", config: config({ pr_health: { enabled: false } }) },
      { name: "empty", config: config({ repos: [], pr_health: { enabled: true } }) },
    ]);
    expect(manager.get("absent")).toBeUndefined();
    expect(manager.get("off")).toBeUndefined();
    expect(manager.start()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.status("absent")).toMatchObject({ enabled: false, running: false, findings: [], planned: [] });
    expect(manager.status("empty")).toMatchObject({ enabled: true, running: false, repos: [], inactive: expect.stringMatching(/lists no repository/) });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(requests).toEqual([]);

    // The control: on, one timer, and its first tick reads the host
    const app = remote("example/app");
    const on = new PrHealthManager({ fetch: fakeGitHubApi(app), env: {}, log: quiet, firstTickMs: 10 });
    cleanups.push(() => on.stop());
    on.load([{ name: "on", config: config({ pr_health: { enabled: true } }) }]);
    expect(on.start()).toEqual(["on"]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    // The tick the timer started (a call during one returns it)
    expect(await on.get("on")?.tick()).not.toBeNull();
    expect(app.requests.map((r) => r.path)).toContain("/repos/example/app/pulls?state=open&per_page=100");
    expect(on.status("on")).toMatchObject({ enabled: true, running: true, mode: "observe", actBlocked: expect.stringMatching(/observe/), planned: [] });
  });

  it("AT-30 prHealth_config_errors: each names its key; an invalid repos: keeps PR health off", () => {
    const errors = (block: Record<string, unknown>, repos: unknown = [APP, LIB]) => {
      const result = parsePrHealthConfig(config({ repos, pr_health: { enabled: true, ...block } }));
      return result.ok ? [] : result.errors;
    };
    expect(errors({ ignored_prs: ["app#1"] })[0]).toMatch(/^pr_health\.ignored_prs\.0: use owner\/name#N/);
    expect(errors({ ignored_prs: ["example/other#1"] })[0]).toMatch(/^pr_health\.ignored_prs\.0: example\/other is not listed in repos:/);
    expect(errors({ ignored_branches: ["a***"] })[0]).toMatch(/^pr_health\.ignored_branches\.0: use \* or \*\*/);
    expect(errors({ mode: "act" })[0]).toMatch(/^pr_health\.mode: act needs notify_cmd/);
    expect(errors({ notify_cmd: ["/opt/hooks/note", "{foo}"] })[0]).toMatch(/^pr_health\.notify_cmd: unknown placeholder \{foo\}/);
    expect(errors({ interval_seconds: 30 })[0]).toMatch(/^pr_health\.interval_seconds:/);
    expect(errors({}, [{ repo: "lib" }])[0]).toMatch(/^repos\[0\]\.repo: use owner\/name/);
    // Valid: every placeholder, act with notify_cmd, and an off block ignores a bad repos:
    const act = { mode: "act", notify_cmd: ["/opt/hooks/note", "{agent}", "{repo}", "{pr}", "{head}", "{kinds}", "{id}", "{message}"], ignored_prs: ["EXAMPLE/lib#7"] };
    expect(errors(act)).toEqual([]);
    expect(parsePrHealthConfig(config({ repos: [{ repo: "lib" }], pr_health: { enabled: false } })).ok).toBe(true);

    // Through the manager: not started, and the status says why
    const manager = new PrHealthManager({ env: {}, log: quiet });
    manager.load([{ name: "demo", config: config({ pr_health: { enabled: true, interval_seconds: 30 } }) }]);
    expect(manager.get("demo")).toBeUndefined();
    expect(manager.status("demo").lastError).toMatch(/pr_health\.interval_seconds/);
  });

  it("AT-26 prHealth_sources_no_sync_io: no synchronous fs or child process in pr-health/ and repos/", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [here, join(here, "..", "repos")].flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(dir, f)),
    );
    const names = sources.map((f) => f.split(/[\\/]/).slice(-2).join("/"));
    expect(names).toEqual(expect.arrayContaining(["pr-health/service.ts", "pr-health/detect.ts", "pr-health/config.ts", "repos/refs.ts", "repos/hosts.ts"]));
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/\b\w+Sync\s*\(/);
      expect(code, file).not.toMatch(/from ["'](node:)?fs["']/);
      expect(code, file).not.toMatch(/from ["'](node:)?child_process["']/);
    }
  });
});

describe("PR health: kinds", () => {
  it("AT-11 prHealth_conflicts_from_single_pr_read: mergeable comes from GET /pulls/42, not the list", async () => {
    const h = setup();
    const head = pr(h.app, 42, { mergeable: false });
    await h.tick();
    expect(h.status().findings.map((f) => f.key)).toEqual([`pr_health:example/app#42@${head.slice(0, 8)}:conflicts`]);
    expect(h.requests).toContain("GET /repos/example/app/pulls/42");
    expect(h.status().findings[0]).toMatchObject({ head, owner: { agent: null, reason: expect.stringMatching(/no agents module/) }, ownerReason: null, noticeId: null });
  });

  it("AT-12 prHealth_mergeable_null_unknown: no finding, an open one stays without clearing, and the PR is read again", async () => {
    const h = setup();
    pr(h.app, 42, { mergeable: null });
    await h.tick();
    expect(h.kinds()).toEqual([]);
    h.requests.length = 0;
    h.app.pulls.get(42)!.mergeable = false;
    await h.tick();
    expect(h.requests).toContain("GET /repos/example/app/pulls/42");
    expect(h.kinds()).toEqual(["example/app#42:conflicts"]);

    // The base moves and the host has not worked mergeable out again: unknown
    h.app.pulls.get(42)!.mergeable = null;
    advanceMain(h.app, 1);
    h.clock.advance(30 * MIN);
    await h.tick();
    expect(h.finding(42, "conflicts")).toMatchObject({ since: T0, clearingSince: null });
    h.requests.length = 0;
    h.clock.advance(30 * MIN);
    await h.tick();
    expect(h.requests).toContain("GET /repos/example/app/pulls/42");
    expect(h.finding(42, "conflicts")).toMatchObject({ since: T0, clearingSince: null });
    expect(h.of("pr_health.cleared")).toEqual([]);
  });

  it("AT-13 prHealth_behind_threshold: 31 behind is behind, 30 is not", async () => {
    const h = setup();
    pr(h.app, 1);
    advanceMain(h.app, 1);
    pr(h.app, 2);
    advanceMain(h.app, 30);
    await h.tick();
    expect(h.kinds()).toEqual(["example/app#1:behind"]);
  });

  it("AT-14 prHealth_no_ci_window: 21 min without checks is no_ci; 19 min, a draft or a pending check is not", async () => {
    const h = setup();
    pr(h.app, 1, { updatedAt: ago(21) }, null);
    pr(h.app, 2, { updatedAt: ago(19) }, null);
    pr(h.app, 3, { updatedAt: ago(60), draft: true }, null);
    const pending = pr(h.app, 4, { updatedAt: ago(60) }, null);
    h.app.checks.set(pending, [{ name: "build", status: "in_progress", conclusion: null, completed_at: null, app: ACTIONS_APP }]);
    await h.tick();
    expect(h.kinds()).toEqual(["example/app#1:no_ci"]);
  });

  it("AT-15 prHealth_ci_red_states: failure, cancelled, timed_out and an error status are red; a re-run success, skipped and neutral are not", async () => {
    const h = setup();
    pr(h.app, 1, {}, [["build", "failure"]]);
    pr(h.app, 2, {}, [["build", "cancelled"]]);
    pr(h.app, 3, {}, [["build", "timed_out"]]);
    const status = pr(h.app, 4, {}, null);
    h.app.statuses.set(status, [{ context: "ci/external", state: "error", creator: "ci-bot" }]);
    pr(h.app, 5, {}, [["build", "failure"], ["build", "success"]]);
    pr(h.app, 6, {}, [["lint", "skipped"], ["docs", "neutral"]]);
    pr(h.app, 7, { draft: true }, [["build", "failure"]]);
    await h.tick();
    expect(h.kinds()).toEqual(["example/app#1:ci_red", "example/app#2:ci_red", "example/app#3:ci_red", "example/app#4:ci_red", "example/app#7:ci_red"]);
  });

  it("AT-16 prHealth_ci_counts_off: no CI kinds and no check request; conflicts and behind still found", async () => {
    const h = setup({}, [{ repo: "example/app", ci_counts: false }]);
    pr(h.app, 1, { updatedAt: ago(60) }, null);
    pr(h.app, 2, {}, [["build", "failure"]]);
    pr(h.app, 3, { mergeable: false }, null);
    pr(h.app, 4, {}, null);
    advanceMain(h.app, 31);
    await h.tick();
    expect(h.kinds()).toEqual([1, 2, 3, 4].map((n) => `example/app#${n}:behind`).concat("example/app#3:conflicts").sort());
    expect(h.requests.filter((r) => /check-runs|statuses/.test(r))).toEqual([]);
    expect(h.status().repos[0]).toMatchObject({ ciCounts: false, state: "ok" });
  });

  it("AT-17 prHealth_ignored: ignored_prs, ignored_branches and another base are skipped and listed; a PR that becomes skipped is cleared", async () => {
    const h = setup({ ignored_prs: ["example/app#42"] });
    pr(h.app, 42, { mergeable: false });
    pr(h.app, 43, { mergeable: false, headRef: "dependabot/npm/x" });
    pr(h.app, 44, { mergeable: false, baseRef: "develop" });
    pr(h.app, 45, { mergeable: false });
    await h.tick();
    expect(h.kinds()).toEqual(["example/app#45:conflicts"]);
    expect(h.status().repos[0].skipped).toEqual([
      { pr: 42, why: "ignored_prs" },
      { pr: 43, why: "ignored_branches" },
      { pr: 44, why: "other_base" },
    ]);
    expect(h.requests.filter((r) => /\/pulls\/4[234]$/.test(r))).toEqual([]);

    h.app.pulls.get(45)!.baseRef = "develop";
    await h.tick();
    expect(h.kinds()).toEqual([]);
    expect(h.of("pr_health.cleared")).toMatchObject([{ pr: 45, kind: "conflicts", why: "ignored" }]);
  });
});

describe("PR health: requests, isolation and clearing", () => {
  it("AT-18 prHealth_cache_no_extra_requests: an unchanged settled PR costs nothing; a new base tip re-reads the PR, not its checks; pending checks are read each tick", async () => {
    const h = setup();
    const head = pr(h.app, 42);
    await h.tick();
    h.requests.length = 0;
    await h.tick();
    expect(h.requests).toEqual(["GET /repos/example/app/pulls", "GET /repos/example/app/git/ref/heads/main"]);

    const tip = advanceMain(h.app, 1);
    h.requests.length = 0;
    await h.tick();
    expect(h.requests).toEqual([
      "GET /repos/example/app/pulls",
      "GET /repos/example/app/git/ref/heads/main",
      "GET /repos/example/app/pulls/42",
      `GET /repos/example/app/compare/${tip}...${head}`,
    ]);

    const pending = pr(h.app, 43, {}, null);
    h.app.checks.set(pending, [{ name: "build", status: "queued", conclusion: null, completed_at: null, app: ACTIONS_APP }]);
    await h.tick();
    h.requests.length = 0;
    await h.tick();
    expect(h.requests).toEqual([
      "GET /repos/example/app/pulls",
      "GET /repos/example/app/git/ref/heads/main",
      `GET /repos/example/app/commits/${pending}/check-runs`,
      `GET /repos/example/app/commits/${pending}/statuses`,
    ]);
  });

  it("AT-19 prHealth_repo_isolation_timeout: A's list times out; A keeps its findings, B is read, one repo_error, nothing cleared on recovery", async () => {
    const h = setup({ request_timeout_seconds: 1 }, [APP, LIB]);
    pr(h.app, 1, { mergeable: false });
    pr(h.lib, 2, { mergeable: false });
    await h.tick();
    const before = h.finding(1, "conflicts");
    expect(before).toMatchObject({ repo: "example/app", since: T0, clearingSince: null });

    h.hang.add("example/app");
    pr(h.lib, 3, { mergeable: false });
    h.clock.advance(20 * MIN);
    await h.tick();
    expect(h.status().repos[0]).toMatchObject({ repo: "example/app", state: "error", error: expect.stringMatching(/timed out/) });
    expect(h.finding(1, "conflicts")).toEqual(before);
    expect(h.kinds()).toEqual(["example/app#1:conflicts", "example/lib#2:conflicts", "example/lib#3:conflicts"]);
    h.clock.advance(20 * MIN);
    await h.tick();
    expect(h.of("pr_health.repo_error")).toEqual([{ project: "demo", repo: "example/app", error: expect.stringMatching(/timed out/) }]);
    expect(h.finding(1, "conflicts")).toEqual(before);

    h.hang.delete("example/app");
    h.clock.advance(20 * MIN);
    await h.tick();
    expect(h.status().repos[0]).toMatchObject({ state: "ok", error: null });
    expect(h.finding(1, "conflicts")).toEqual(before);
    expect(h.of("pr_health.cleared")).toEqual([]);
    expect(h.of("pr_health.finding")).toHaveLength(3);
  }, 15_000);

  it("AT-20 prHealth_rate_limited_no_storm: after a 429 A gets no request until the reset; B is unaffected", async () => {
    const h = setup({}, [APP, LIB]);
    pr(h.app, 1, { mergeable: false });
    pr(h.lib, 2, { mergeable: false });
    h.limited.set("example/app", Math.floor((T0 + 10 * MIN) / 1000));
    await h.tick();
    expect(h.status().repos[0]).toMatchObject({ state: "error", error: expect.stringMatching(/429/) });
    expect(h.kinds()).toEqual(["example/lib#2:conflicts"]);

    h.limited.delete("example/app");
    h.requests.length = 0;
    h.clock.advance(5 * MIN);
    await h.tick();
    expect(h.requests.filter((r) => r.includes("/repos/example/app"))).toEqual([]);
    expect(h.requests.filter((r) => r.includes("/repos/example/lib"))).not.toEqual([]);
    expect(h.status().repos[0].state).toBe("error");

    h.clock.advance(6 * MIN);
    await h.tick();
    expect(h.status().repos[0].state).toBe("ok");
    expect(h.kinds()).toEqual(["example/app#1:conflicts", "example/lib#2:conflicts"]);
  });

  it("AT-28 prHealth_clearing: a new head clears with head_moved, a closed PR with closed, a fixed kind after clear_minutes", async () => {
    const h = setup({ clear_minutes: 10 });
    const h1 = pr(h.app, 42, { mergeable: false });
    pr(h.app, 43, { mergeable: false });
    const red = pr(h.app, 44, {}, [["build", "failure"]]);
    await h.tick();
    expect(h.kinds()).toEqual(["example/app#42:conflicts", "example/app#43:conflicts", "example/app#44:ci_red"]);

    const h2 = h.app.commit([h1], W, "more work");
    h.app.pushToPull(42, h2);
    h.app.setChecks(h2, GREEN);
    h.app.pulls.get(43)!.state = "closed";
    h.app.setChecks(red, [["build", "failure"], ["build", "success"]]);
    h.clock.advance(MIN);
    await h.tick();
    const cleared = () => h.of("pr_health.cleared").map((e) => `${String(e.key)}:${String(e.why)}`);
    expect(cleared()).toEqual([`pr_health:example/app#43@${h.app.pulls.get(43)!.headSha.slice(0, 8)}:conflicts:closed`, `pr_health:example/app#42@${h1.slice(0, 8)}:conflicts:head_moved`]);
    expect(h.finding(42, "conflicts")).toMatchObject({ head: h2, since: T0 + MIN });
    const clearingSince = T0 + MIN;
    expect(h.finding(44, "ci_red")).toMatchObject({ since: T0, clearingSince });

    h.clock.advance(9 * MIN);
    await h.tick();
    expect(h.finding(44, "ci_red")).toMatchObject({ clearingSince });
    h.clock.advance(MIN);
    await h.tick();
    expect(h.finding(44, "ci_red")).toBeUndefined();
    expect(cleared().at(-1)).toBe(`pr_health:example/app#44@${red.slice(0, 8)}:ci_red:fixed`);
    // Found on every read: it keeps its since and never starts clearing
    expect(h.finding(42, "conflicts")).toMatchObject({ since: T0 + MIN, clearingSince: null });
  });

  it("a full page of 100 open PRs is truncated: a PR missing from it is not taken as closed", async () => {
    const h = setup({ max_prs_per_repo: 1 });
    pr(h.app, 1, { mergeable: false, updatedAt: ago(0) });
    await h.tick();
    h.app.pulls.get(1)!.state = "closed";
    for (let n = 2; n <= 101; n++) pr(h.app, n, { updatedAt: ago(n) });
    await h.tick();
    expect(h.status().repos[0]).toMatchObject({ truncated: true, partial: false });
    expect(h.status().repos[0].skipped.filter((s) => s.why === "max_prs_per_repo")).toHaveLength(99);
    expect(h.kinds()).toEqual(["example/app#1:conflicts"]);

    // Its cached facts were kept too: back in a whole list, unchanged, it costs no request
    for (let n = 2; n <= 101; n++) h.app.pulls.get(n)!.state = "closed";
    h.app.pulls.get(1)!.state = "open";
    h.requests.length = 0;
    await h.tick();
    expect(h.status().repos[0]).toMatchObject({ truncated: false, prsRead: 1 });
    expect(h.requests).toEqual(["GET /repos/example/app/pulls", "GET /repos/example/app/git/ref/heads/main"]);
    expect(h.kinds()).toEqual(["example/app#1:conflicts"]);
  });

  it("a repository the tick's budget never reached is not partial: it was not listed", async () => {
    const h = setup({ max_requests_per_tick: 10 }, [APP, LIB]);
    for (const n of [1, 2]) pr(h.app, n, { mergeable: false });
    pr(h.lib, 7, { mergeable: false });
    await h.tick();
    // app: getRepo, list, base tip, then 4 per PR: the 11th request (PR 2's statuses) is never sent
    expect(h.status().repos.map((r) => [r.repo, r.state, r.partial])).toEqual([
      ["example/app", "ok", true],
      ["example/lib", "inactive", false],
    ]);
  });

  it("a parse error is warned about only for a project that turns PR health on", () => {
    const warned: string[] = [];
    const manager = new PrHealthManager({ env: {}, log: { log: () => undefined, warn: (m: string) => void warned.push(m) } });
    manager.load([
      { name: "off", config: config({ pr_health: { enabled: false, interval_seconds: 30 } }) },
      { name: "on", config: config({ pr_health: { enabled: true, interval_seconds: 30 } }) },
    ]);
    expect(warned).toEqual([expect.stringMatching(/^\[pr-health\] on: not started: pr_health\.interval_seconds/)]);
    expect(manager.status("off").lastError).toMatch(/interval_seconds/);
  });

  it("AT-29 prHealth_event_payloads: finding, cleared and repo_error carry exactly the fields of the design", async () => {
    const h = setup({}, [APP, LIB]);
    const h1 = pr(h.app, 42, { mergeable: false });
    await h.tick();
    const key = `pr_health:example/app#42@${h1.slice(0, 8)}:conflicts`;
    expect(h.of("pr_health.finding")).toEqual([
      { project: "demo", key, repo: "example/app", pr: 42, head: h1, kind: "conflicts", owner: null, ownerSource: null, mode: "observe" },
    ]);
    h.app.pushToPull(42, h.app.commit([h1], W, "fix"));
    h.limited.set("example/lib", Math.floor((T0 + 10 * MIN) / 1000));
    await h.tick();
    expect(h.of("pr_health.cleared")).toEqual([{ project: "demo", key, repo: "example/app", pr: 42, head: h1, kind: "conflicts", why: "head_moved" }]);
    // The status only: the host's answer text ("API rate limit exceeded") is not repeated
    expect(h.of("pr_health.repo_error")).toEqual([{ project: "demo", repo: "example/lib", error: "GitHub GET /repos/example/lib/pulls: 429" }]);
  });

  it("AT-32 prHealth_budget_and_deadline: the tick stops at the budget or the deadline, partial; unread PRs keep their state and are read first", async () => {
    const h = setup({ max_requests_per_tick: 40, max_prs_per_repo: 100 });
    for (let n = 1; n <= 40; n++) pr(h.app, n, { mergeable: false, updatedAt: ago(n) });
    await h.tick();
    // getRepo, list, base tip, then 4 per PR: 9 PRs, and the 10th stops at the 41st request (never sent)
    expect(h.requests).toHaveLength(40);
    expect(h.status().repos[0]).toMatchObject({ state: "ok", partial: true, prsRead: 9 });
    expect(h.status().findings.map((f) => f.pr).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Every PR changed (a new base tip): the unread ones go first, the 9 read ones keep their findings as they are
    advanceMain(h.app, 1);
    h.clock.advance(MIN);
    await h.tick();
    const prs = h.status().findings.map((f) => f.pr).sort((a, b) => a - b);
    expect(prs).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(h.finding(1, "conflicts")).toMatchObject({ since: T0, clearingSince: null });
    expect(h.status().repos[0]).toMatchObject({ state: "ok", partial: true });

    // The deadline: half the interval (150 s); each request here takes 10 s
    const slow = setup({ max_prs_per_repo: 100 });
    for (let n = 1; n <= 10; n++) pr(slow.app, n, { mergeable: false });
    slow.net.delayMs = 10_000;
    await slow.tick();
    expect(slow.requests).toHaveLength(15);
    expect(slow.status().repos[0]).toMatchObject({ state: "ok", partial: true });
  });
});

describe("PR health 2b: the owner rule, the plan, the route and the wiring", () => {
  const AUTHORS = { review: { authors: { branch_pattern: "agent/{agent}/**" } } };
  const ownerOf = (h: ReturnType<typeof setup>, pr: number) => h.status().findings.find((f) => f.pr === pr)?.owner;

  /** A conflicting PR from `branch` whose head was committed `minAgo` minutes before T0 (negative: in the future) */
  function branchPr(r: FakeRemote, number: number, branch: string, minAgo: number): string {
    const head = r.commit([r.branches.get("main") as string], W, `pr ${number} ${++counter}`, { ...W, date: ago(minAgo) });
    r.openPull({ number, headRef: branch, headSha: head, files: [], mergeable: false });
    r.setChecks(head, GREEN);
    return head;
  }

  it("AT-21 prHealth_owner_latest_open_line: the latest open line naming the PR; a done or not_allowlisted line names nobody", async () => {
    const h = setup({}, [APP], AUTHORS);
    const head = pr(h.app, 42, { mergeable: false });
    const lines = ["# tasks", "", "agent-a|n|t1|fix app#42", "", "", "", "agent-b|n|t2|app PR #42 red CI"];
    h.fill.view = fillView(lines);
    await h.tick();
    expect(ownerOf(h, 42)).toEqual({ agent: "agent-b", source: "task_line", line: 7, reason: "task line 7 names the PR" });
    const key = `pr_health:example/app#42@${head.slice(0, 8)}:conflicts`;
    expect(h.of("pr_health.finding")).toEqual([
      { project: "demo", key, repo: "example/app", pr: 42, head, kind: "conflicts", owner: "agent-b", ownerSource: "task_line", mode: "observe" },
    ]);
    h.fill.view = fillView(lines, { 7: "done" });
    await h.tick();
    expect(ownerOf(h, 42)).toMatchObject({ agent: "agent-a", source: "task_line", line: 3 });
    h.fill.view = fillView(lines, { 7: "not_allowlisted" });
    await h.tick();
    expect(ownerOf(h, 42)).toMatchObject({ agent: "agent-a", source: "task_line", line: 3 });
    // A task line names the PR: the branch rule's commit read never happens (its branch maps to worker-a)
    expect(h.requests.filter((r) => r.endsWith("/commits"))).toEqual([]);
  });

  it("AT-22 prHealth_owner_cross_repo_negative: lib#42 is not owned by app#42 or a bare PR #42; repo:example/lib makes it", async () => {
    const h = setup({}, [APP, LIB]);
    pr(h.lib, 42, { mergeable: false });
    const own = async (description: string) => {
      h.fill.view = fillView([`agent-a|n|t|${description}`]);
      await h.tick();
      return ownerOf(h, 42);
    };
    expect(await own("fix app#42")).toMatchObject({ agent: null, source: null, reason: expect.stringMatching(/^no open task line names the PR/) });
    expect(await own("PR #42")).toMatchObject({ agent: null, source: null });
    expect(await own("repo:example/lib PR #42")).toMatchObject({ agent: "agent-a", source: "task_line", line: 1 });
  });

  it("AT-23 prHealth_owner_branch_window: the branch's agent with an open line, inside the window by the committer date", async () => {
    const run = async (minAgo: number, o: { state?: FillLineState; authors?: boolean; commits?: unknown; hang?: boolean } = {}) => {
      const h = setup({ request_timeout_seconds: 1 }, [APP], o.authors === false ? {} : AUTHORS);
      branchPr(h.app, 42, "agent/agent-c/x", minAgo);
      h.fill.view = fillView(["agent-c|n|t|other work"], o.state ? { 1: o.state } : {});
      if (o.commits !== undefined) h.answers.set("/repos/example/app/pulls/42/commits", o.commits);
      if (o.hang) h.hang.add("/repos/example/app/pulls/42/commits");
      await h.tick();
      return { h, owner: ownerOf(h, 42) };
    };
    const inWindow = await run(300);
    expect(inWindow.owner).toEqual({ agent: "agent-c", source: "branch", line: null, reason: expect.stringContaining("committed 300 min ago") });
    expect(inWindow.h.of("pr_health.finding")).toMatchObject([{ owner: "agent-c", ownerSource: "branch" }]);
    // Read once per (repo, PR, head)
    await inWindow.h.tick();
    expect(inWindow.h.requests.filter((r) => r.endsWith("/pulls/42/commits"))).toHaveLength(1);
    expect((await run(-30)).owner).toMatchObject({ agent: "agent-c", source: "branch" });
    expect((await run(420)).owner).toMatchObject({ agent: null, reason: expect.stringMatching(/over 360 min ago/) });
    expect((await run(300, { state: "done" })).owner).toMatchObject({ agent: null, reason: expect.stringMatching(/agent-c, who has no open task line/) });
    expect((await run(300, { authors: false })).owner).toMatchObject({ agent: null, reason: expect.stringMatching(/review\.authors maps no branch/) });
    expect((await run(300, { commits: [] })).owner).toMatchObject({ agent: null, reason: expect.stringMatching(/date is not known/) });
    const timedOut = await run(300, { hang: true });
    expect(timedOut.owner).toBe("unknown");
    expect(timedOut.h.finding(42, "conflicts")?.ownerReason).toMatch(/^the head commit's date could not be read: timed out/);
    expect(timedOut.h.status().planned).toEqual([]);
  });

  it("AT-24 prHealth_owner_ignores_malformed_long_line: fill's view of a 2001-character line names nobody, and nothing throws", async () => {
    const h = setup();
    pr(h.app, 42, { mergeable: false });
    const long = `agent-a|n|t|fix PR #42 ${"x".repeat(2000)}`;
    h.fill.view = fillView([long]);
    expect(h.fill.view.lines).toMatchObject([{ line: 1, agent: null, description: null, state: "malformed" }]);
    await h.tick();
    expect(ownerOf(h, 42)).toEqual({ agent: null, source: null, line: null, reason: expect.stringMatching(/^no open task line names the PR/) });
  });

  it("AT-25 prHealth_owner_unknown_until_fill_checks: fill on before its first check is unknown (nothing planned); fill off is nobody", async () => {
    const h = setup();
    const head = pr(h.app, 42, { mergeable: false });
    h.fill.view = fillView([], {}, { lastCheck: null });
    await h.tick();
    expect(ownerOf(h, 42)).toBe("unknown");
    expect(h.finding(42, "conflicts")?.ownerReason).toMatch(/fill has not checked/);
    expect(h.of("pr_health.finding")).toMatchObject([{ owner: null, ownerSource: null }]);
    expect(h.status().planned).toEqual([]);
    h.fill.view = fillView(["agent-a|n|t|PR #42"], {}, { enabled: false });
    await h.tick();
    expect(ownerOf(h, 42)).toMatchObject({ agent: null, reason: expect.stringMatching(/agents\.fill is off/) });
    expect(h.status().planned).toEqual([{ type: "notice", key: `pr_health:example/app#42@${head.slice(0, 8)}`, code: "no_owner" }]);
  });

  it("AT-27 prHealth_observe_writes_nothing: planned lists the note's argv and the no_owner notice; its only events are findings", async () => {
    const h = setup({ notify_cmd: ["/opt/hooks/agent-note", "{agent}", "{id}", "{message}"], withdraw_cmd: ["/opt/hooks/agent-unnote", "{id}"] });
    const owned = pr(h.app, 42, { mergeable: false }, [["build", "failure"]]);
    const orphan = pr(h.app, 43, { mergeable: false });
    h.fill.view = fillView(["agent-b|n|t|app#42 conflicts"]);
    await h.tick();
    const [o8, n8] = [owned.slice(0, 8), orphan.slice(0, 8)];
    const id = `pr_health:example/app#42@${o8}:conflicts+ci_red`;
    const message =
      `PR example/app#42 at ${o8}: it conflicts with main: merge main into the branch with a normal merge, resolve, push; ` +
      `CI is red at ${o8} (1 failing checks): fix them before reporting it done or waiting. Fix this before other work on that PR. (${id})`;
    const planned = h.status().planned;
    expect(planned).toHaveLength(2);
    expect(planned).toEqual(
      expect.arrayContaining([
        { type: "note", id, agent: "agent-b", argv: ["/opt/hooks/agent-note", "agent-b", id, message], reason: null },
        { type: "notice", key: `pr_health:example/app#43@${n8}`, code: "no_owner" },
      ]),
    );
    // Host text never goes into a note: no branch name, check name or title
    expect(message).not.toMatch(/worker-a|build|pr 42/);
    // Observe sends and raises nothing: the only events are the findings
    expect([...new Set(h.events.map((e) => e.type))]).toEqual(["pr_health.finding"]);
    expect(h.status()).toMatchObject({ mode: "observe", actBlocked: expect.stringMatching(/observe/) });
  });

  it("AT-31 prHealth_wired_and_reloaded: started as index.ts starts it, GET-only status route, a reload to enabled: false stops the timer", async () => {
    const app = remote("example/app");
    pr(app, 42, { mergeable: false });
    const manager = new PrHealthManager({ events: new EventBus(), agents: { get: () => undefined }, fetch: fakeGitHubApi(app), env: {}, log: quiet, firstTickMs: 10 });
    cleanups.push(() => manager.stop());
    manager.load([
      { name: "demo", config: config({ pr_health: { enabled: true } }) },
      { name: "other", config: config({}) },
    ]);
    const fastify = Fastify({ logger: false });
    await registerPrHealthRoutes(fastify, manager, () => "demo");
    await fastify.ready();
    cleanups.push(() => fastify.close());
    const [module] = serverModules({ prHealth: manager });
    expect(module).toMatchObject({ name: "pr_health", blocks: ["pr_health"], reads: ["review"] });
    expect(module.validate(config({ pr_health: { enabled: true, interval_seconds: 30 } }))).toEqual([expect.stringMatching(/^pr_health\.interval_seconds/)]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(startedLine(manager.start())).toBe("[pr-health] Watching PRs for: demo");
    expect(startedLine([])).toBe("[pr-health] Off (no project sets pr_health.enabled)");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    const monitor = manager.get("demo");
    await monitor?.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor?.lastTick).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the next tick's

    const status = await fastify.inject({ method: "GET", url: "/api/pr-health/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({ project: "demo", enabled: true, running: true, mode: "observe", findings: [{ pr: 42, kind: "conflicts" }] });
    expect((await fastify.inject({ url: "/api/pr-health/status?project=other" })).json().data).toMatchObject({ project: "other", enabled: false });
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      expect((await fastify.inject({ method, url: "/api/pr-health/status" })).statusCode).toBe(404);
    }

    await module.reload({ name: "demo", config: config({ pr_health: { enabled: false } }) });
    expect(monitor?.running).toBe(false);
    expect(manager.get("demo")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.status("demo")).toMatchObject({ enabled: false, running: false });
  });
});
