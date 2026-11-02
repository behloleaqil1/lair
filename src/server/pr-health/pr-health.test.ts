/**
 * PR health, observe only (docs/design/pr-health.md section 5, PR 2a):
 * through PrHealthManager.load, start and the monitor's tick() (what its
 * timer calls), with GitHub faked only at FetchLike (the review module's
 * fake API over an in-memory repository, in GitHub's REST shapes: a list item
 * has no mergeable). The clock is a test clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import type { FetchLike } from "../review/github.js";
import { ACTIONS_APP, FakeClock, FakeRemote, fakeGitHubApi, type FakePull } from "../review/testing/fakes.js";
import { PrHealthManager, parsePrHealthConfig } from "./index.js";

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

function setup(prHealth: Record<string, unknown> = {}, repos: unknown = [APP]) {
  const app = remote("example/app");
  const lib = remote("example/lib");
  const apis = { app: fakeGitHubApi(app), lib: fakeGitHubApi(lib) };
  const clock = new FakeClock(T0);
  const requests: string[] = [];
  /** Repositories whose requests never answer (the host's timeout ends them) */
  const hang = new Set<string>();
  /** Repositories that answer 429 with this x-ratelimit-reset (epoch s) */
  const limited = new Map<string, number>();
  const net = { delayMs: 0 };
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    clock.advance(net.delayMs);
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1] ?? "";
    const signal = init?.signal;
    if (hang.has(repo)) return new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
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
  const manager = new PrHealthManager({ events: bus, fetch, env: {}, now: () => clock.now(), log: quiet });
  manager.load([{ name: "demo", config: config({ repos, pr_health: { enabled: true, ...prHealth } }) }]);
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
    limited,
    net,
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
    expect(h.status().findings[0]).toMatchObject({ head, owner: "unknown", ownerReason: expect.stringMatching(/owner/), noticeId: null });
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
    expect(h.of("pr_health.repo_error")).toEqual([{ project: "demo", repo: "example/lib", error: expect.stringMatching(/^GitHub GET \/repos\/example\/lib.*429/) }]);
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
