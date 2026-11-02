/**
 * PR health, act mode (docs/design/pr-health.md section 5, PR 3: AT-33 to
 * AT-47): through PrHealthManager.load, useDecisions and the monitor's
 * tick() (what its timer calls), with a real Decision Inbox (in-memory
 * SQLite) and a real ledger file. GitHub is faked only at FetchLike (the
 * review module's fake API, in GitHub's REST shapes) and commands only at
 * the CommandRunner process boundary (one test runs real programs through
 * the real SpawnRunner). The clock is a test clock; a restart is a new
 * manager on the same ledger file and inbox.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FillLineState, FillLineView, FillStatusView } from "../../shared/agents-types.js";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { parseTasksFile } from "../agents/fill.js";
import { EventBus } from "../core/event-bus.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { SpawnRunner, type CommandOutput, type CommandRunner, type RunOptions } from "../infra-monitor/probes.js";
import type { FetchLike } from "../review/github.js";
import { FakeClock, FakeRemote, fakeGitHubApi, type FakePull } from "../review/testing/fakes.js";
import { serverModules } from "../reload/modules.js";
import { PrHealthManager, type NoteRecord } from "./index.js";

const W = { name: "W", email: "w@example.com" };
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T01:00:00Z");
const quiet = { log: () => undefined, warn: () => undefined };
const NOTIFY = ["/opt/hooks/agent-note", "{agent}", "{kinds}", "{id}", "{message}"];
const WITHDRAW = ["/opt/hooks/agent-unnote", "{agent}", "{id}", "{message}"];

/** The process boundary: records each argv with its options and answers with the next scripted outcome (default: exit 0). */
class FakeRunner implements CommandRunner {
  calls: { argv: string[]; options: RunOptions }[] = [];
  outcomes: Partial<CommandOutput>[] = [];
  /** The command hangs until it is aborted (the manager stopping) */
  hold = false;
  run(argv: string[], options: RunOptions): Promise<CommandOutput> {
    this.calls.push({ argv: [...argv], options });
    if (this.hold) {
      return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ code: -1, stdout: "", stderr: "aborted", timedOut: false })));
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...this.outcomes.shift() });
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let counter = 0;
function remote(repo: string): FakeRemote {
  const r = new FakeRemote(repo);
  r.branches.set("main", r.commit([], W, "init"));
  return r;
}

/** A PR forked from main's tip, with green checks unless `checks` says otherwise */
function pr(r: FakeRemote, number: number, over: Partial<FakePull> = {}, checks: [string, string][] = [["build", "success"]]): string {
  const head = r.commit([r.branches.get("main") as string], W, `pr ${number} ${++counter}`);
  r.openPull({ number, headRef: `agent/worker-a/pr-${number}`, headSha: head, files: [], title: `Secret title ${number}`, ...over });
  r.setChecks(head, checks);
  return head;
}

function fillView(lines: string[], states: Record<number, FillLineState> = {}, over: Partial<FillStatusView> = {}): FillStatusView {
  const views: FillLineView[] = parseTasksFile(lines.join("\n")).map((e) => {
    const base = { hold: null, releasable: false, waiting: null, runId: null, decisionId: null };
    if (e.kind === "malformed") return { ...base, line: e.line, agent: null, name: null, task: null, description: null, state: "malformed", detail: e.reason };
    return { ...base, line: e.line, agent: e.agent, name: e.name, task: e.task, description: e.description, state: states[e.line] ?? "started", detail: "" };
  });
  const loop = { enabled: true, running: true, tasksFile: "/home/user/demo/tasks.md", agents: [], maxActive: 4, active: 0, intervalSeconds: 60 };
  return { ...loop, lastCheck: new Date(T0).toISOString(), lastError: null, lines: views, unmatchedReports: [], warnings: [], ...over };
}

function setup(block: Record<string, unknown> = {}, o: { repos?: unknown[]; extra?: Record<string, unknown>; runner?: CommandRunner } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pr-health-act-"));
  const remotes = new Map<string, FakeRemote>();
  const repos = (o.repos ?? [{ repo: "example/app", default: true }]) as { repo: string }[];
  for (const { repo } of repos) remotes.set(repo, remote(repo));
  const app = remotes.get(repos[0].repo) as FakeRemote;
  const clock = new FakeClock(T0);
  const store = new DecisionStore(":memory:");
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock, events: new EventBus() });
  const runner = new FakeRunner();
  /** Repositories whose every request answers 500 */
  const down = new Set<string>();
  const fetch: FetchLike = async (url, init) => {
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(new URL(url).pathname)?.[1] ?? "";
    if (down.has(repo)) return { status: 500, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: "Server Error" }) };
    return fakeGitHubApi(remotes.get(repo) ?? app)(url, init);
  };
  const fill: { view: FillStatusView | null } = { view: fillView(["agent-b|n|t|app#42 fix it"]) };
  const agents = { get: (project: string) => (project === "demo" && fill.view ? { fillStatus: () => fill.view as FillStatusView } : undefined) };
  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (e) => {
    events.push(e);
  });
  const ledgerPath = join(root, "data", "pr-health-deliveries.json");
  const project = (over: Record<string, unknown> = {}): ProjectConfig =>
    ({
      name: "demo",
      repo: root,
      github: repos[0].repo,
      queue_file: "q",
      agents_dir: "a",
      gates_dir: "g",
      machines: {},
      repos,
      ...o.extra,
      pr_health: { enabled: true, mode: "act", notify_cmd: NOTIFY, withdraw_cmd: WITHDRAW, ...block, ...over },
    }) as unknown as ProjectConfig;
  const managers: PrHealthManager[] = [];
  const open = () => {
    const m = new PrHealthManager({ events: bus, agents, fetch, env: {}, now: () => clock.now(), log: quiet, ledgerPath, runner: o.runner ?? runner });
    m.useDecisions(inbox);
    m.load([{ name: "demo", config: project() }]);
    managers.push(m);
    return m;
  };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  cleanups.push(async () => {
    for (const m of managers) await m.stop();
  });
  const h = {
    root,
    app,
    remotes,
    clock,
    inbox,
    runner,
    down,
    fill,
    events,
    ledgerPath,
    project,
    manager: open(),
    monitor: () => h.manager.get("demo") as NonNullable<ReturnType<PrHealthManager["get"]>>,
    tick: async () => {
      expect(await h.monitor().tick()).not.toBeNull();
    },
    after: async (ms: number) => {
      clock.advance(ms);
      await h.tick();
    },
    /** A restart: the manager stops and a new one reads the same ledger file */
    restart: async () => {
      await h.manager.stop();
      h.manager = open();
    },
    status: () => h.manager.status("demo"),
    records: (): NoteRecord[] => h.manager.status("demo").deliveries,
    ran: () => runner.calls.map((c) => c.argv),
    notices: () => inbox.list({ project: "demo", status: "all" }).filter((d) => d.source.module === "pr_health"),
    of: (type: string) => events.filter((e) => e.type === type).map((e) => e.data),
  };
  return h;
}

const head8 = (sha: string) => sha.slice(0, 8);
const idOf = (n: number, sha: string, kinds: string) => `pr_health:example/app#${n}@${head8(sha)}:${kinds}`;
const withdrawal = (n: number, sha: string, kinds: string, why: string) => [
  "/opt/hooks/agent-unnote",
  "agent-b",
  idOf(n, sha, kinds),
  `PR example/app#${n} at ${head8(sha)}: ${kinds.split("+").join(", ")} no longer seen (${why}); note ${idOf(n, sha, kinds)} is withdrawn.`,
];

describe("PR health act: notes", () => {
  it("AT-33 prHealthAct_one_note_per_episode: one run with the filled argv, sent, nothing again; a later kind gets its own note", async () => {
    const h = setup();
    const head = pr(h.app, 42, { mergeable: false }, [["build", "failure"]]);
    await h.tick();
    const id = idOf(42, head, "conflicts+ci_red");
    const message =
      `PR example/app#42 at ${head8(head)}: it conflicts with main: merge main into the branch with a normal merge, resolve, push; ` +
      `CI is red at ${head8(head)} (1 failing checks): fix them before reporting it done or waiting. Fix this before other work on that PR. (${id})`;
    expect(h.runner.calls).toEqual([{ argv: ["/opt/hooks/agent-note", "agent-b", "conflicts,ci_red", id, message], options: expect.objectContaining({ timeoutMs: 30_000, cwd: h.root }) }]);
    expect(h.runner.calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(h.records()).toMatchObject([{ id, repo: "example/app", pr: 42, head, kinds: ["conflicts", "ci_red"], agent: "agent-b", status: "sent", attempts: 1, sentAt: T0, withdraw: null }]);
    expect(JSON.parse(readFileSync(h.ledgerPath, "utf8"))).toMatchObject({ format: 1, records: [{ id, status: "sent" }] });
    expect(h.of("pr_health.noted")).toEqual([
      { project: "demo", id, repo: "example/app", pr: 42, head, kinds: ["conflicts", "ci_red"], agent: "agent-b", result: "sent", attempts: 1, error: null },
    ]);
    expect(h.status()).toMatchObject({ mode: "act", actBlocked: null, lastError: null });
    expect(h.notices()).toEqual([]);

    await h.after(MIN);
    await h.after(MIN);
    expect(h.ran()).toHaveLength(1);

    // behind appears at the same head: one more note, naming behind only
    for (let i = 0; i < 31; i++) h.app.branches.set("main", h.app.commit([h.app.branches.get("main") as string], W, `main ${++counter}`));
    await h.after(MIN);
    await h.after(MIN);
    expect(h.ran()).toHaveLength(2);
    expect(h.ran()[1].slice(0, 4)).toEqual(["/opt/hooks/agent-note", "agent-b", "behind", idOf(42, head, "behind")]);
    expect(h.ran()[1][4]).toMatch(/: it is 31 commits behind main: merge main and push\. /);
  });

  it("AT-34 prHealthAct_retry_after_failure: exit 1 is failed and waits for its backoff; the retry sends with the same id; a timeout is never sent", async () => {
    const h = setup();
    const head = pr(h.app, 42, { mergeable: false });
    h.runner.outcomes.push({ code: 1, stderr: "busy\nnow" });
    await h.tick();
    expect(h.records()).toMatchObject([{ status: "failed", attempts: 1, lastError: "exited 1: busy now", nextAttemptAt: T0 + 300_000, sentAt: null }]);
    expect(h.of("pr_health.noted")).toMatchObject([{ result: "failed", attempts: 1, error: "exited 1: busy now" }]);
    await h.after(4 * MIN);
    expect(h.ran()).toHaveLength(1);
    await h.after(MIN);
    expect(h.ran()).toHaveLength(2);
    expect(h.ran()[1]).toEqual(h.ran()[0]);
    expect(h.ran()[1][3]).toBe(idOf(42, head, "conflicts"));
    expect(h.records()).toMatchObject([{ status: "sent", attempts: 2, sentAt: T0 + 5 * MIN, lastError: null }]);
    await h.after(10 * MIN);
    expect(h.ran()).toHaveLength(2);

    const t = setup();
    pr(t.app, 42, { mergeable: false });
    t.runner.outcomes.push({ code: 0, stdout: "delivered", timedOut: true });
    await t.tick();
    expect(t.records()).toMatchObject([{ status: "failed", lastError: "timed out after 30 s", sentAt: null }]);
  });

  it("AT-36 prHealthAct_restart_mid_command: a running record loads as failed and is retried after its backoff with the same id", async () => {
    const h = setup();
    const head = pr(h.app, 42, { mergeable: false });
    h.runner.hold = true;
    const tick = h.monitor().tick();
    for (let i = 0; i < 50 && h.runner.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.runner.calls).toHaveLength(1);
    await h.restart(); // the server stops while the command runs
    await tick;
    expect(JSON.parse(readFileSync(h.ledgerPath, "utf8")).records).toMatchObject([{ id: idOf(42, head, "conflicts"), status: "running", attempts: 1 }]);

    h.runner.hold = false;
    await h.tick();
    expect(h.records()).toMatchObject([{ status: "failed", lastError: "interrupted by a restart", attempts: 1 }]);
    expect(h.ran()).toHaveLength(1);
    await h.after(5 * MIN);
    expect(h.ran()).toHaveLength(2);
    expect(h.ran()[1]).toEqual(h.ran()[0]);
    expect(h.records()).toMatchObject([{ status: "sent", attempts: 2 }]);
  });

  it("AT-37 prHealthAct_gave_up_escalates: both attempts fail, the note gave up, and one delivery_failed notice is raised", async () => {
    const h = setup({ max_attempts: 2 });
    const head = pr(h.app, 42, { mergeable: false });
    h.runner.outcomes.push({ code: 1 }, { code: 2 });
    await h.tick();
    expect(h.notices()).toEqual([]);
    await h.after(5 * MIN);
    expect(h.records()).toMatchObject([{ status: "gave_up", attempts: 2, nextAttemptAt: null, lastError: "exited 2: no output" }]);
    const key = `pr_health:example/app#42@${head8(head)}`;
    expect(h.notices()).toMatchObject([{ key, class: "pr_health.notice", attention: "notice", status: "open", evidence: { code: "delivery_failed", facts: { owner: "agent-b", kinds: "conflicts" } } }]);
    expect(h.of("pr_health.escalated")).toEqual([{ project: "demo", key, code: "delivery_failed", decisionId: h.notices()[0].id }]);
    expect(h.status().findings[0].noticeId).toBe(h.notices()[0].id);
    for (let i = 0; i < 5; i++) await h.after(30 * MIN);
    expect(h.ran()).toHaveLength(2);
    expect(h.notices()).toHaveLength(1);
  });

  it("AT-43 prHealthAct_argv_safety: an array with no host text in it; a value that would start with '-' is refused and nothing runs", async () => {
    const h = setup();
    pr(h.app, 42, { mergeable: false }, [["lint-secret", "failure"]]);
    await h.tick();
    expect(Array.isArray(h.ran()[0])).toBe(true);
    expect(h.ran()[0].join(" ")).not.toMatch(/worker-a|lint-secret|Secret title/);

    const d = setup({ notify_cmd: ["/opt/hooks/agent-note", "{repo}", "{id}"] }, { repos: [{ repo: "-x/app", default: true }] });
    d.fill.view = fillView(["agent-b|n|t|PR #42 fix it"]);
    pr(d.app, 42, { mergeable: false });
    await d.tick();
    expect(d.status().findings).toMatchObject([{ repo: "-x/app", kind: "conflicts", owner: { agent: "agent-b" } }]);
    expect(d.status().planned).toMatchObject([{ type: "note", agent: "agent-b", argv: null, reason: expect.stringMatching(/^notify_cmd: the value in "\{repo\}" starts with "-"/) }]);
    expect(d.ran()).toEqual([]);
    expect(d.records()).toEqual([]);
    expect(d.status().lastError).toMatch(/^note pr_health:-x\/app#42@[0-9a-f]{8}:conflicts not sent: notify_cmd: the value/);
  });

  it("notes run as argv with no shell through the real runner, in the project's repository; a hung note is killed at its timeout with its group", async () => {
    const real = setup({ command_timeout_seconds: 1 }, { runner: new SpawnRunner() });
    const script = join(real.root, "note.js");
    const log = join(real.root, "calls.log");
    writeFileSync(
      script,
      `const fs = require("fs"), { spawn } = require("child_process");
if (fs.existsSync(${JSON.stringify(join(real.root, "hang"))})) {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(join(real.root, "child.pid"))}, String(child.pid));
  setInterval(() => {}, 1000);
} else fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
    );
    const cfg = real.project({ notify_cmd: [process.execPath, script, "{agent}", "$(touch pwned) {id}", "{message}"] });
    await real.manager.reloadProject({ name: "demo", config: cfg });
    const head = pr(real.app, 42, { mergeable: false });
    await real.tick();
    const [call] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(call.argv.slice(0, 2)).toEqual(["agent-b", `$(touch pwned) ${idOf(42, head, "conflicts")}`]);
    expect(call.cwd).toBe(realpathSync(real.root));
    expect(existsSync(join(real.root, "pwned"))).toBe(false);
    expect(real.records()).toMatchObject([{ status: "sent" }]);

    // A second PR whose note hangs: killed after 1 s with its child, failed, never sent
    writeFileSync(join(real.root, "hang"), "");
    real.fill.view = fillView(["agent-b|n|t|app#42 app#43"]);
    pr(real.app, 43, { mergeable: false });
    const started = Date.now();
    await real.after(MIN);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(real.records().find((r) => r.pr === 43)).toMatchObject({ status: "failed", lastError: "timed out after 1 s", sentAt: null });
    const child = readFileSync(join(real.root, "child.pid"), "utf8").trim();
    // Gone, or a zombie its new parent has not reaped yet: not running either way
    let state = "running";
    for (let i = 0; i < 100 && state !== "" && !state.startsWith("Z"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      state = spawnSync("ps", ["-o", "stat=", "-p", child]).stdout.toString().trim();
    }
    expect(state === "" || state.startsWith("Z")).toBe(true);
  }, 30_000);
});


/** CI goes green at this head by a re-run (checks are read again each tick; mergeability is not, until a head or base moves) */
const fixCi = (r: FakeRemote, head: string) => r.setChecks(head, [["build", "failure"], ["build", "success"]]);

describe("PR health act: withdrawals and restarts", () => {
  /** PR #42 owned by agent-b, conflicting (or red), its note sent on the first tick */
  async function sent(block: Record<string, unknown> = {}, red = false) {
    const h = setup({ clear_minutes: 10, ...block });
    const head = red ? pr(h.app, 42, {}, [["build", "failure"]]) : pr(h.app, 42, { mergeable: false });
    await h.tick();
    expect(h.records()).toMatchObject([{ status: "sent", kinds: [red ? "ci_red" : "conflicts"] }]);
    return { h, head };
  }

  it("AT-35 prHealthAct_restart_after_send: nothing again in the same state; a fix, a close or a new head while down gets exactly one withdrawal; a failed first read none", async () => {
    const same = await sent();
    await same.h.restart();
    for (let i = 0; i < 3; i++) await same.h.after(10 * MIN);
    expect(same.h.ran()).toHaveLength(1);

    const fixed = await sent({}, true);
    await fixed.h.restart();
    fixCi(fixed.h.app, fixed.head);
    await fixed.h.after(MIN);
    await fixed.h.after(9 * MIN);
    expect(fixed.h.ran()).toHaveLength(1);
    await fixed.h.after(MIN);
    expect(fixed.h.ran()).toEqual([expect.any(Array), withdrawal(42, fixed.head, "ci_red", "fixed")]);
    await fixed.h.after(30 * MIN);
    expect(fixed.h.ran()).toHaveLength(2);
    expect(fixed.h.records()[0].withdraw).toMatchObject({ status: "done", why: "fixed", attempts: 1, lastError: null });
    expect(fixed.h.of("pr_health.withdrawn")).toEqual([{ project: "demo", id: idOf(42, fixed.head, "ci_red"), agent: "agent-b", result: "done", attempts: 1, error: null }]);

    const closed = await sent();
    await closed.h.restart();
    closed.h.app.pulls.get(42)!.state = "closed";
    await closed.h.after(MIN);
    expect(closed.h.ran()).toEqual([expect.any(Array), withdrawal(42, closed.head, "conflicts", "closed")]);
    await closed.h.after(MIN);
    expect(closed.h.ran()).toHaveLength(2);

    const moved = await sent();
    await moved.h.restart();
    const h2 = moved.h.app.commit([moved.head], W, "more");
    moved.h.app.pushToPull(42, h2);
    moved.h.app.setChecks(h2, [["build", "success"]]);
    await moved.h.after(MIN);
    await moved.h.after(MIN);
    expect(moved.h.ran().filter((a) => a[0] === "/opt/hooks/agent-unnote")).toEqual([withdrawal(42, moved.head, "conflicts", "head_moved")]);

    const failing = await sent();
    await failing.h.restart();
    failing.h.app.pulls.get(42)!.state = "closed";
    failing.h.down.add("example/app");
    for (let i = 0; i < 3; i++) await failing.h.after(10 * MIN);
    expect(failing.h.ran()).toHaveLength(1);
    expect(failing.h.status().repos[0]).toMatchObject({ state: "error" });
    expect(JSON.parse(readFileSync(failing.h.ledgerPath, "utf8")).records).toMatchObject([{ status: "sent", withdraw: null }]);
  });

  it("AT-38 prHealthAct_withdraw: one run when the kinds clear and one when the PR closes; none for a note never sent; skipped without withdraw_cmd", async () => {
    const fixed = await sent({}, true);
    fixCi(fixed.h.app, fixed.head);
    for (let i = 0; i < 4; i++) await fixed.h.after(5 * MIN);
    expect(fixed.h.ran()).toEqual([expect.any(Array), withdrawal(42, fixed.head, "ci_red", "fixed")]);

    const closed = await sent();
    closed.h.app.pulls.get(42)!.state = "closed";
    for (let i = 0; i < 3; i++) await closed.h.after(MIN);
    expect(closed.h.ran()).toEqual([expect.any(Array), withdrawal(42, closed.head, "conflicts", "closed")]);

    const never = setup();
    pr(never.app, 42, { mergeable: false });
    never.runner.outcomes.push({ code: 1 });
    await never.tick();
    never.app.pulls.get(42)!.state = "closed";
    for (let i = 0; i < 4; i++) await never.after(10 * MIN);
    expect(never.ran()).toHaveLength(1);
    expect(never.records()).toMatchObject([{ status: "failed", withdraw: null }]);
    // A failed note whose kinds cleared is not retried either
    const stale = setup({ clear_minutes: 0 });
    const red = pr(stale.app, 42, {}, [["build", "failure"]]);
    stale.runner.outcomes.push({ code: 1 });
    await stale.tick();
    fixCi(stale.app, red);
    for (let i = 0; i < 4; i++) await stale.after(10 * MIN);
    expect(stale.ran()).toHaveLength(1);

    const skipped = await sent({ withdraw_cmd: null });
    skipped.h.app.pulls.get(42)!.state = "closed";
    await skipped.h.after(MIN);
    await skipped.h.after(MIN);
    expect(skipped.h.ran()).toHaveLength(1);
    expect(skipped.h.records()[0].withdraw).toMatchObject({ status: "skipped", why: "closed", attempts: 0 });
    expect(skipped.h.of("pr_health.withdrawn")).toMatchObject([{ result: "skipped", attempts: 0, error: null }]);
  });

  it("a failed withdrawal is retried after its backoff and gives up at max_attempts", async () => {
    const { h, head } = await sent({ max_attempts: 2 });
    h.app.pulls.get(42)!.state = "closed";
    h.runner.outcomes.push({ code: 1 }, { code: 1 });
    await h.after(MIN);
    expect(h.records()[0].withdraw).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: T0 + MIN + 300_000 });
    await h.after(4 * MIN);
    expect(h.ran()).toHaveLength(2);
    await h.after(MIN);
    expect(h.ran()).toEqual([expect.any(Array), withdrawal(42, head, "conflicts", "closed"), withdrawal(42, head, "conflicts", "closed")]);
    expect(h.records()[0].withdraw).toMatchObject({ status: "gave_up", attempts: 2 });
    await h.after(60 * MIN);
    expect(h.ran()).toHaveLength(3);
  });

  it("AT-39 prHealthAct_new_head: a note sent at h1 and h2 pushed, still conflicting: one withdrawal for h1, one note for h2", async () => {
    const { h, head } = await sent();
    const h2 = h.app.commit([head], W, "more");
    h.app.pushToPull(42, h2);
    h.app.setChecks(h2, [["build", "success"]]);
    await h.after(MIN);
    await h.after(MIN);
    expect(h.ran()).toHaveLength(3);
    expect(h.ran()).toEqual(expect.arrayContaining([withdrawal(42, head, "conflicts", "head_moved")]));
    expect(h.ran().filter((a) => a[0] === "/opt/hooks/agent-note").map((a) => a[3])).toEqual([idOf(42, head, "conflicts"), idOf(42, h2, "conflicts")]);
  });

  it("at most four commands run in one tick, notes and withdrawals together; the rest run on the next", async () => {
    const h = setup();
    h.fill.view = fillView(["agent-b|n|t|app#1 app#2 app#3 app#4 app#5 app#6"]);
    for (let n = 1; n <= 6; n++) pr(h.app, n, { mergeable: false });
    await h.tick();
    expect(h.ran()).toHaveLength(4);
    await h.after(MIN);
    expect(h.ran()).toHaveLength(6);
  });
});


describe("PR health act: notices", () => {
  it("AT-40 prHealthAct_no_owner_notice_only: no command, one no_owner notice, withdrawn when fixed, not again once noted; an unknown owner raises nothing", async () => {
    const h = setup({ clear_minutes: 10 });
    h.fill.view = fillView(["agent-a|n|t|other work"]);
    const head = pr(h.app, 42, {}, [["lint-secret", "failure"]]);
    await h.tick();
    expect(h.ran()).toEqual([]);
    const key = `pr_health:example/app#42@${head8(head)}`;
    expect(h.notices()).toMatchObject([
      {
        key,
        class: "pr_health.notice",
        attention: "notice",
        status: "open",
        options: [{ id: "noted", effect: "reversible" }],
        evidence: { code: "no_owner", facts: { repo: "example/app", pr: 42, head, kinds: "ci_red", owner: null, reason: expect.stringMatching(/^no open task line names the PR/) }, cause_cleared: false, linked_issue: null },
      },
    ]);
    expect(`${h.notices()[0].title} ${h.notices()[0].context}`).not.toMatch(/worker-a|Secret title|lint-secret/);
    expect(h.of("pr_health.escalated")).toEqual([{ project: "demo", key, code: "no_owner", decisionId: h.notices()[0].id }]);
    await h.after(MIN);
    expect(h.notices()).toHaveLength(1);
    fixCi(h.app, head);
    await h.after(MIN);
    await h.after(9 * MIN);
    expect(h.notices()[0].status).toBe("open");
    await h.after(MIN);
    expect(h.notices()).toMatchObject([{ status: "withdrawn" }]);
    expect(h.ran()).toEqual([]);

    const noted = setup();
    noted.fill.view = null;
    pr(noted.app, 42, { mergeable: false });
    await noted.tick();
    await noted.inbox.answer(noted.notices()[0].id, { optionId: "noted" });
    for (let i = 0; i < 3; i++) await noted.after(MIN);
    expect(noted.notices()).toMatchObject([{ status: "answered" }]);

    const unknown = setup();
    unknown.fill.view = fillView([], {}, { lastCheck: null });
    pr(unknown.app, 42, { mergeable: false });
    await unknown.tick();
    await unknown.after(MIN);
    expect(unknown.notices()).toEqual([]);
    expect(unknown.ran()).toEqual([]);
  });

  it("AT-41 prHealthAct_escalate_after_timer: one unfixed notice at 60 min after the note, none at 59, none for a fix at 30, none again after a restart, none with null", async () => {
    const h = setup({ escalate_after_minutes: 60 });
    const head = pr(h.app, 42, { mergeable: false });
    await h.tick();
    await h.after(59 * MIN);
    expect(h.notices()).toEqual([]);
    await h.after(MIN);
    expect(h.notices()).toMatchObject([{ key: `pr_health:example/app#42@${head8(head)}`, evidence: { code: "unfixed", facts: { owner: "agent-b" } }, status: "open" }]);
    expect(h.of("pr_health.escalated")).toMatchObject([{ code: "unfixed" }]);
    await h.restart();
    await h.tick();
    await h.after(30 * MIN);
    expect(h.notices()).toHaveLength(1);
    expect(h.of("pr_health.escalated")).toHaveLength(1);

    const fixed = setup({ escalate_after_minutes: 60 });
    const red = pr(fixed.app, 42, {}, [["build", "failure"]]);
    await fixed.tick();
    await fixed.after(30 * MIN);
    fixCi(fixed.app, red);
    for (let i = 0; i < 8; i++) await fixed.after(5 * MIN);
    expect(fixed.records()).toMatchObject([{ status: "sent", withdraw: { status: "done", why: "fixed" } }]);
    expect(fixed.notices()).toEqual([]);

    const off = setup();
    pr(off.app, 42, { mergeable: false });
    await off.tick();
    await off.after(600 * MIN);
    expect(off.notices()).toEqual([]);
  });

  it("an open notice left from before a restart with no finding behind it is withdrawn after clear_minutes, only once its repository was read", async () => {
    const h = setup({ clear_minutes: 10 });
    h.fill.view = null;
    pr(h.app, 42, { mergeable: false });
    await h.tick();
    expect(h.notices()).toMatchObject([{ status: "open" }]);
    await h.restart();
    h.app.pulls.get(42)!.mergeable = true;
    h.down.add("example/app");
    for (let i = 0; i < 3; i++) await h.after(10 * MIN);
    expect(h.notices()).toMatchObject([{ status: "open" }]);
    h.down.clear();
    await h.after(MIN);
    await h.after(9 * MIN);
    expect(h.notices()).toMatchObject([{ status: "open" }]);
    await h.after(MIN);
    expect(h.notices()).toMatchObject([{ status: "withdrawn" }]);
  });

  it("AT-45 prHealthAct_switch_to_observe: a reload to observe withdraws the open notices and runs no command; the ledger stays", async () => {
    const h = setup();
    h.fill.view = fillView(["agent-b|n|t|app#42"]);
    pr(h.app, 42, { mergeable: false });
    pr(h.app, 43, { mergeable: false });
    await h.tick();
    expect(h.ran()).toHaveLength(1);
    expect(h.notices()).toMatchObject([{ status: "open", evidence: { code: "no_owner" } }]);
    const [module] = serverModules({ prHealth: h.manager });
    await module.reload({ name: "demo", config: h.project({ mode: "observe" }) });
    expect(h.notices()).toMatchObject([{ status: "withdrawn" }]);
    for (let i = 0; i < 3; i++) await h.after(10 * MIN);
    expect(h.ran()).toHaveLength(1);
    expect(h.notices()).toHaveLength(1);
    expect(h.status()).toMatchObject({ mode: "observe", deliveries: [] });
    expect(JSON.parse(readFileSync(h.ledgerPath, "utf8")).records).toMatchObject([{ status: "sent" }]);
  });
});

describe("PR health act: the ledger and the project", () => {
  it("AT-42 prHealthAct_ledger_failures: an unwritable ledger runs nothing and says why; an invalid one is not overwritten and pauses act", async () => {
    const blocked = setup();
    await blocked.tick(); // the ledger is read: none yet
    // Then its directory can't be made (a file stands there), whoever runs the test
    writeFileSync(join(blocked.root, "data"), "a file where the ledger's directory should be");
    pr(blocked.app, 42, { mergeable: false });
    await blocked.after(MIN);
    expect(blocked.ran()).toEqual([]);
    expect(blocked.status().lastError).toMatch(/^note pr_health:example\/app#42@[0-9a-f]{8}:conflicts not sent: the ledger can't be written/);
    expect(blocked.records()).toMatchObject([{ status: "failed", attempts: 1, sentAt: null }]);
    await blocked.after(MIN);
    expect(blocked.ran()).toEqual([]);

    const invalid = setup();
    mkdirSync(join(invalid.root, "data"));
    writeFileSync(invalid.ledgerPath, "{not json");
    invalid.fill.view = fillView(["agent-b|n|t|app#42"]);
    pr(invalid.app, 42, { mergeable: false });
    pr(invalid.app, 43, { mergeable: false });
    await invalid.tick();
    await invalid.after(MIN);
    expect(invalid.ran()).toEqual([]);
    expect(invalid.status().lastError).toMatch(/is not valid .*notes and withdrawals stop until it is fixed or removed/);
    expect(readFileSync(invalid.ledgerPath, "utf8")).toBe("{not json");
    // Notices that need no ledger still go up
    expect(invalid.notices()).toMatchObject([{ evidence: { code: "no_owner" } }]);
  });

  it("AT-44 prHealthAct_read_only_project: actBlocked, and it behaves like observe", async () => {
    const h = setup({}, { extra: { read_only: true } });
    pr(h.app, 42, { mergeable: false });
    pr(h.app, 43, { mergeable: false });
    await h.tick();
    await h.after(MIN);
    expect(h.status()).toMatchObject({ mode: "act", actBlocked: "the project is read_only", deliveries: [] });
    expect(h.status().planned).toMatchObject([{ type: "note", agent: "agent-b" }, { type: "notice", code: "no_owner" }]);
    expect(h.ran()).toEqual([]);
    expect(h.notices()).toEqual([]);
    expect(existsSync(join(h.root, "data"))).toBe(false);
    expect(h.events.map((e) => e.type).filter((t) => t !== "pr_health.finding")).toEqual([]);
  });

  it("observe mode never reads or creates the ledger, even with records in it", async () => {
    const h = setup({ mode: "observe" });
    mkdirSync(join(h.root, "data"));
    writeFileSync(h.ledgerPath, "{not json");
    pr(h.app, 42, { mergeable: false });
    await h.tick();
    expect(h.status()).toMatchObject({ lastError: null, deliveries: [] });
    expect(readdirSync(join(h.root, "data"))).toEqual(["pr-health-deliveries.json"]);
    expect(h.ran()).toEqual([]);
  });

  it("AT-47 prHealthAct_prune_keeps_open: 15-day-old records whose head has an open finding are kept and not noted again; a closed-out one is pruned", async () => {
    const h = setup();
    h.fill.view = fillView(["agent-b|n|t|app#42 app#43 app#44 app#45"]);
    const open = pr(h.app, 42, { mergeable: false });
    const done = pr(h.app, 43);
    const fresh = pr(h.app, 44, { mergeable: false });
    const gaveUp = pr(h.app, 45, { mergeable: false });
    const old = T0 - 15 * DAY;
    const record = (n: number, head: string, over: Partial<NoteRecord>): NoteRecord => ({
      project: "demo",
      id: idOf(n, head, "conflicts"),
      repo: "example/app",
      pr: n,
      head,
      kinds: ["conflicts"],
      agent: "agent-b",
      status: "sent",
      attempts: 1,
      lastAttemptAt: old,
      nextAttemptAt: null,
      lastError: null,
      argv: ["/opt/hooks/agent-note"],
      sentAt: old,
      withdraw: null,
      ...over,
    });
    const withdrawn = { status: "done" as const, why: "fixed" as const, attempts: 1, lastAttemptAt: old, nextAttemptAt: null, lastError: null };
    mkdirSync(join(h.root, "data"));
    const records = [
      record(42, open, {}),
      record(43, done, { withdraw: withdrawn }),
      // Only its open finding keeps it: pruned, its kind would be noted again
      record(45, gaveUp, { status: "gave_up", attempts: 3, sentAt: null }),
    ];
    writeFileSync(h.ledgerPath, JSON.stringify({ format: 1, records }));
    await h.tick();
    expect(h.ran().map((a) => a[3])).toEqual([idOf(44, fresh, "conflicts")]);
    const ids = (JSON.parse(readFileSync(h.ledgerPath, "utf8")) as { records: NoteRecord[] }).records.map((r) => r.id).sort();
    expect(ids).toEqual([idOf(42, open, "conflicts"), idOf(44, fresh, "conflicts"), idOf(45, gaveUp, "conflicts")].sort());
    await h.after(MIN);
    expect(h.ran()).toHaveLength(1);
    expect(h.status().warning).toBeNull();
  });
});
