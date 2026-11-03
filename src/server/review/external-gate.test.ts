/**
 * review.merge.external_gate (docs/design/merge-external-gate.md): merging on
 * a signed gate at the exact head for a repository whose hosted CI is not its
 * merge signal. Through ReviewManager with the real policy, signed-gate
 * verification, store and local merge executor; only the git host's API,
 * git, the clock and the pre-merge check's spawner are stand-ins, and the
 * gate results are really signed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { GateResult, SignedGateResult } from "../../shared/policy-types.js";
import { EventBus } from "../core/event-bus.js";
import { generateNodeKeyPair, signGateResult } from "../gates/signature.js";
import { ReviewManager, type ReviewService } from "./service.js";
import { parseReviewConfig } from "./config.js";
import type { CheckOutput, CheckRunOptions, CheckRunner } from "./check.js";
import type { DecisionRequest } from "./ports.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MINUTE = 60_000;
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const NODE = generateNodeKeyPair("gates-1");
const REPO = "example-org/demo";

const README: FakeFile = {
  filename: "docs/usage.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n # Usage\n-Old text\n+New text",
};
const ROUTE: FakeFile = {
  filename: "server/src/main/OrdersController.java",
  status: "modified",
  additions: 2,
  deletions: 0,
  patch: '@@ -10,2 +10,4 @@\n class OrdersController {\n+  @GetMapping("/orders")\n+  List<Order> list() { return List.of(); }\n }',
};

const managers: ReviewManager[] = [];
let dir: string | null = null;

afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

class FakeSpawner implements CheckRunner {
  calls: { argv: string[]; options: CheckRunOptions }[] = [];
  reply: (argv: string[]) => CheckOutput | Promise<CheckOutput> = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

  async run(argv: string[], options: CheckRunOptions): Promise<CheckOutput> {
    this.calls.push({ argv: [...argv], options });
    return this.reply(argv);
  }
}

let resultCount = 0;

/** A gate result signed by NODE at `sha`, finished `minutes` after 11:00, with the report names it wrote. */
function signed(
  sha: string,
  pipelineId = "backend",
  status: "passed" | "failed" = "passed",
  options: { minutes?: number; reports?: string[]; version?: string } = {},
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
    steps: [{ name: "test", status: status === "passed" ? "passed" : "failed", exitCode: status === "passed" ? 0 : 1 }],
    selectedSteps: ["test"],
    durationMs: 5000,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(start + 5000).toISOString(),
    pipelineVersion: options.version ?? "1",
    ...(options.reports ? { reports: options.reports.map((name) => ({ name, sha256: "0".repeat(64) })) } : {}),
  };
  return signGateResult(result, NODE.privateKey, NODE.publicKey);
}

interface Repo {
  remote: FakeRemote;
  base: string;
  head: string;
}

/** main at `base`, PR #3 at `head` (one commit ahead) changing `files`. */
function repo(files: FakeFile[] = [README], baseRef = "main"): Repo {
  dir ??= mkdtempSync(join(tmpdir(), "lair-external-gate-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  if (baseRef !== "main") remote.branches.set(baseRef, base);
  const head = remote.commit([base], AGENT, "change");
  remote.openPull({ number: 3, title: "A change", headRef: "agent/worker-a/change", headSha: head, files, baseRef });
  return { remote, base, head };
}

const GATE = {
  source: "signed",
  required: [{ any_of: ["backend", "scoped", "docs"] }],
  node_keys: { "gates-1": NODE.publicKey },
  pipeline_versions: { backend: "1", scoped: "1", docs: "1" },
};

const ROUTE_RULE = {
  id: "routes",
  paths: ["server/**/*.java"],
  added_line_contains: ["@GetMapping", "@PostMapping"],
  needs_any: [{ pipelines: ["backend"] }, { reports: ["AccessControlTest"] }],
};

function projectConfig(review: Record<string, unknown>, ciSignal: boolean | null): ProjectConfig {
  return {
    name: "demo",
    repo: "/home/user/demo",
    github: REPO,
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: false,
    review,
    ...(ciSignal === null ? {} : { pr_health: { enabled: false, repos: { [REPO]: { ci_signal: ciSignal } } } }),
  };
}

interface Rig extends Repo {
  manager: ReviewManager;
  service: ReviewService;
  clock: FakeClock;
  spawner: FakeSpawner;
  decisions: DecisionRequest[];
  observed: Record<string, unknown>[];
  scan(): Promise<void>;
}

function boot(
  at: Repo,
  externalGate: Record<string, unknown> | null,
  options: { merge?: Record<string, unknown>; ciSignal?: boolean | null } = {},
): Rig {
  const clock = new FakeClock(NOW);
  const spawner = new FakeSpawner();
  const decisions: DecisionRequest[] = [];
  const events = new EventBus();
  const observed: Record<string, unknown>[] = [];
  events.on("review.merge_observed", (event) => {
    observed.push(event.data as Record<string, unknown>);
  });
  const manager = new ReviewManager({
    dbPath: ":memory:",
    clock,
    git: new FakeGit(at.remote),
    fetch: fakeGitHubApi(at.remote),
    env: {},
    cwd: dir!,
    autoRequestMs: 0,
    checks: spawner,
    events,
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
      config: projectConfig(
        {
          enabled: true,
          authors: { branch_pattern: "agent/{agent}/**" },
          reviewers: { red: [], amber: [], green: [] },
          merge: {
            gate: GATE,
            method: "local",
            local_strategy: "ff-only",
            work_dir: join(dir!, "work"),
            ...(externalGate ? { external_gate: externalGate } : {}),
            ...options.merge,
          },
        },
        options.ciSignal === undefined ? false : options.ciSignal,
      ),
    },
  ]);
  const service = manager.get("demo");
  if (!service) throw new Error(`reviews are off: ${manager.info("demo").errors.join("; ")}`);
  return { ...at, manager, service, clock, spawner, decisions, observed, scan: () => manager.requestOpenPullRequests() };
}

function condition(status: { conditions: { id: string; ok: boolean; detail: string }[] }, id: string) {
  return status.conditions.find((c) => c.id === id);
}

describe("review.merge.external_gate", () => {
  it("externalGate_signal_default_red_exempt: with ci_signal false a red default branch doesn't hold the merge; with it true it does", async () => {
    const act = boot(repo(), { mode: "act" });
    act.service.addGateResult(signed(act.base, "backend", "failed"));
    act.service.addGateResult(signed(act.head, "docs"));
    const status = await act.service.status(3);
    expect(condition(status, "holds")).toMatchObject({ ok: true });
    expect(status.externalGate).toMatchObject({ mode: "act", defaultRedExempt: true, wouldMerge: true });
    await act.scan();
    expect(act.remote.branches.get("main")).toBe(act.head);

    // The same PR in a repository whose hosted CI is the signal (unlisted): the red default branch holds it
    const held = boot(repo(), { mode: "act" }, { ciSignal: null });
    held.service.addGateResult(signed(held.base, "backend", "failed"));
    held.service.addGateResult(signed(held.head, "docs"));
    const heldStatus = await held.service.status(3);
    expect(condition(heldStatus, "holds")).toMatchObject({ ok: false });
    expect(condition(heldStatus, "holds")!.detail).toContain("the default branch main is red");
    expect(heldStatus.externalGate).toMatchObject({ defaultRedExempt: false, wouldMerge: false });
    await held.scan();
    expect(held.remote.branches.get("main")).toBe(held.base);

    // ci_signal listed as true behaves as unlisted
    const listed = boot(repo(), { mode: "act" }, { ciSignal: true });
    listed.service.addGateResult(signed(listed.base, "backend", "failed"));
    listed.service.addGateResult(signed(listed.head, "docs"));
    expect((await listed.service.status(3)).canMerge).toBe(false);
  });

  it("externalGate_gate_rule_any_gate: any trusted pass at the head may meet a rule, not only the first; a newer failure of its pipeline unmeets it", async () => {
    const rig = boot(repo([ROUTE]), { mode: "act", gate_rules: [ROUTE_RULE] });
    const h = rig.head.slice(0, 7);
    // A scoped gate that did not run the access-control test: the gate condition passes, the rule doesn't
    rig.service.addGateResult(signed(rig.head, "scoped", "passed", { minutes: 0, reports: ["TEST-OrdersTest.xml"] }));
    let status = await rig.service.status(3);
    expect(condition(status, "gate")).toMatchObject({ ok: true });
    expect(condition(status, "gate_rules")).toMatchObject({ ok: false });
    expect(status.reasons).toContain(
      `Gate rules: routes needs a passed gate at ${h} with pipeline backend, or reports AccessControlTest`,
    );
    expect(status.canMerge).toBe(false);

    // A later gate of another pipeline at the same head that ran it: the rule is met (the first one didn't decide)
    rig.service.addGateResult(signed(rig.head, "docs", "passed", { minutes: 5, reports: ["TEST-com.example.AccessControlTest.xml"] }));
    status = await rig.service.status(3);
    expect(condition(status, "gate_rules")).toMatchObject({ ok: true });
    expect(condition(status, "gate_rules")!.detail).toContain("routes: met by docs-");
    expect(status.canMerge).toBe(true);

    // A newer failure of that pipeline at the head: its older pass no longer counts
    rig.service.addGateResult(signed(rig.head, "docs", "failed", { minutes: 10 }));
    status = await rig.service.status(3);
    expect(condition(status, "gate_rules")).toMatchObject({ ok: false });

    // The full pipeline meets it on its own
    rig.service.addGateResult(signed(rig.head, "backend", "passed", { minutes: 15 }));
    status = await rig.service.status(3);
    expect(condition(status, "gate_rules")).toMatchObject({ ok: true });
    await rig.scan();
    expect(rig.remote.branches.get("main")).toBe(rig.head);
  });

  it("externalGate_gate_rule_scope: a rule doesn't apply to a PR whose files or added lines don't match", async () => {
    const docs = boot(repo([README]), { mode: "act", gate_rules: [ROUTE_RULE] });
    docs.service.addGateResult(signed(docs.head, "scoped"));
    const status = await docs.service.status(3);
    expect(condition(status, "gate_rules")).toMatchObject({ ok: true, detail: "no rule applies" });
    expect(status.canMerge).toBe(true);

    // The path matches but no added line has a listed string
    const plain: FakeFile = { ...ROUTE, patch: "@@ -1,1 +1,1 @@\n-  int a = 1;\n+  int a = 2;\n" };
    const other = boot(repo([plain]), { mode: "act", gate_rules: [ROUTE_RULE] });
    other.service.addGateResult(signed(other.head, "scoped"));
    expect(condition(await other.service.status(3), "gate_rules")).toMatchObject({ ok: true, detail: "no rule applies" });
  });

  it("externalGate_gate_rule_fail_closed: a matching file without a patch makes the rule apply, and an untrusted pass doesn't meet it", async () => {
    const huge: FakeFile = { ...ROUTE, patch: undefined, additions: 9000 };
    const rig = boot(repo([huge]), { mode: "act", gate_rules: [ROUTE_RULE] });
    rig.service.addGateResult(signed(rig.head, "scoped"));
    // An old pipeline version: stored, never trusted
    rig.service.addGateResult(signed(rig.head, "backend", "passed", { version: "0" }));
    const status = await rig.service.status(3);
    expect(condition(status, "gate_rules")).toMatchObject({ ok: false });
    expect(status.canMerge).toBe(false);
    await rig.scan();
    expect(rig.remote.branches.get("main")).toBe(rig.base);
  });

  it("externalGate_stacked_never_merges: a PR whose base is not the default branch is recorded with the reason and not merged", async () => {
    const observe = boot(repo([README], "agent/worker-a/parent"), { mode: "observe" });
    observe.service.addGateResult(signed(observe.head, "docs"));
    await observe.scan();
    const [row] = observe.service.listMergeObservations();
    expect(row).toMatchObject({ pr: 3, headSha: observe.head, wouldMerge: false });
    expect(row.reasons.join("\n")).toContain("Target branch: targets agent/worker-a/parent, not the default branch main");

    const act = boot(repo([README], "agent/worker-a/parent"), { mode: "act" });
    act.service.addGateResult(signed(act.head, "docs"));
    await act.scan();
    act.clock.advance(10 * MINUTE);
    await act.scan();
    expect(act.remote.pulls.get(3)).toMatchObject({ state: "open", merged: false });
    expect(act.service.listMerges()).toEqual([]);
  });

  it("externalGate_sweep_without_auto: observe sweeps every gated PR with merge.auto false, records each, merges none", async () => {
    const at = repo();
    const second = at.remote.commit([at.base], AGENT, "second");
    at.remote.openPull({ number: 4, headRef: "agent/worker-a/second", headSha: second, files: [ROUTE] });
    const ungated = at.remote.commit([at.base], AGENT, "third");
    at.remote.openPull({ number: 5, headRef: "agent/worker-a/third", headSha: ungated, files: [README] });
    const rig = boot(at, { mode: "observe", gate_rules: [ROUTE_RULE] });
    rig.service.addGateResult(signed(at.head, "docs"));
    rig.service.addGateResult(signed(second, "scoped"));

    await rig.scan();
    const rows = rig.service.listMergeObservations();
    expect(rows.map((r) => [r.pr, r.wouldMerge])).toEqual([
      [3, true],
      [4, false],
    ]);
    expect(rows[1].reasons.join("\n")).toContain("Gate rules: routes needs a passed gate");
    expect(rig.remote.branches.get("main")).toBe(at.base);
    expect(rig.service.listMerges()).toEqual([]);
  });

  it("externalGate_refused_head_not_retried: act, a pre-merge check refusal at a head is not tried again; a new head is", async () => {
    const rig = boot(repo(), { mode: "act" }, { merge: { check_cmd: ["/opt/checks/premerge", "--pr", "{pr}"] } });
    rig.spawner.reply = () => ({ code: 1, stdout: "a test file was deleted\n", stderr: "", timedOut: false });
    rig.service.addGateResult(signed(rig.head, "docs"));
    await rig.scan();
    expect(rig.spawner.calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(10 * MINUTE);
      await rig.scan();
    }
    expect(rig.spawner.calls).toHaveLength(1);
    expect(rig.decisions).toHaveLength(1);
    expect(rig.remote.branches.get("main")).toBe(rig.base);

    const fixed = rig.remote.commit([rig.head], AGENT, "restore the test");
    rig.remote.pushToPull(3, fixed);
    rig.service.addGateResult(signed(fixed, "docs"));
    rig.spawner.reply = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
    await rig.scan();
    expect(rig.remote.branches.get("main")).toBe(fixed);
  });

  it("externalGate_hold_list: a held PR is recorded with the hold's reason and not merged; released, it merges", async () => {
    const at = repo();
    const observe = boot(at, { mode: "observe" });
    observe.service.addGateResult(signed(at.head, "docs"));
    await observe.service.addHold(3, "waiting for the release notes", "owner", true);
    await observe.scan();
    expect(observe.service.listMergeObservations()[0]).toMatchObject({ wouldMerge: false });
    expect(observe.service.listMergeObservations()[0].reasons.join("\n")).toContain("waiting for the release notes");

    const act = boot(repo(), { mode: "act" });
    act.service.addGateResult(signed(act.head, "docs"));
    const hold = await act.service.addHold(3, "waiting for the release notes", "owner", true);
    await act.scan();
    expect(act.remote.branches.get("main")).toBe(act.base);
    await act.service.releaseHold(hold.id, "owner");
    act.clock.advance(10 * MINUTE);
    await act.scan();
    expect(act.remote.branches.get("main")).toBe(act.head);
  });

  it("externalGate_observe_writes_nothing: observe merges nothing, runs no check, raises no decision, and emits once per changed verdict", async () => {
    const rig = boot(repo(), { mode: "observe" }, { merge: { check_cmd: ["/opt/checks/premerge", "--pr", "{pr}"] } });
    rig.service.addGateResult(signed(rig.head, "docs"));
    // The policy for every other merge path is unchanged in observe: the red default branch still holds the PR
    rig.service.addGateResult(signed(rig.base, "backend", "failed"));
    const status = await rig.service.status(3);
    expect(status.canMerge).toBe(false);
    expect(status.externalGate).toMatchObject({ mode: "observe", wouldMerge: true, defaultRedExempt: true });

    for (let i = 0; i < 3; i++) {
      await rig.scan();
      rig.clock.advance(10 * MINUTE);
    }
    expect(rig.remote.branches.get("main")).toBe(rig.base);
    expect(rig.spawner.calls).toEqual([]);
    expect(rig.decisions).toEqual([]);
    expect(rig.service.listMerges()).toEqual([]);
    expect(rig.observed).toEqual([expect.objectContaining({ project: "demo", pr: 3, headSha: rig.head, wouldMerge: true })]);

    // A hold changes the verdict: one more event, then quiet again
    await rig.service.addHold(3, "freeze", "owner", true);
    await rig.scan();
    await rig.scan();
    expect(rig.observed).toHaveLength(2);
    expect(rig.observed[1]).toMatchObject({ wouldMerge: false });
  });

  it("externalGate_observe_tiers: a tier not in tiers is recorded as would not merge", async () => {
    const rig = boot(repo([ROUTE]), { mode: "observe", tiers: ["green"] });
    rig.service.addGateResult(signed(rig.head, "backend"));
    await rig.scan();
    const [row] = rig.service.listMergeObservations();
    expect(row.wouldMerge).toBe(false);
    expect(row.reasons.join("\n")).toMatch(/^Tier: .* is not in external_gate\.tiers \(green\)/m);
  });

  it("externalGate_act_tiers: act merges only the tiers in tiers; the owner may still merge another tier", async () => {
    const amber = boot(repo([ROUTE]), { mode: "act", tiers: ["green"] });
    amber.service.addGateResult(signed(amber.head, "backend"));
    const status = await amber.service.status(3);
    expect(status.risk.tier).toBe("amber");
    expect(status.canMerge).toBe(true);
    expect(status.autoMergeStatus).toBe("manual");
    await amber.scan();
    expect(amber.remote.branches.get("main")).toBe(amber.base);

    const green = boot(repo([README]), { mode: "act", tiers: ["green"] });
    green.service.addGateResult(signed(green.head, "docs"));
    expect((await green.service.status(3)).autoMergeStatus).toBe("auto");
    await green.scan();
    expect(green.remote.branches.get("main")).toBe(green.head);
    expect(green.service.listMerges()).toEqual([expect.objectContaining({ pr: 3, initiatedBy: "lair:policy" })]);
  });

  it("externalGate_config: off by default; checks source, act with merge.auto, an empty need and an unknown pipeline are config errors", () => {
    const parse = (merge: Record<string, unknown>, review: Record<string, unknown> = {}) =>
      parseReviewConfig({ enabled: true, merge: { gate: GATE, ...merge }, ...review }, { github: REPO });
    const plain = parse({});
    expect(plain.ok && plain.settings.merge.externalGate).toMatchObject({ mode: "off", tiers: null, gateRules: [] });

    const errors = (merge: Record<string, unknown>) => {
      const r = parse(merge);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ gate: { source: "checks", required: ["build"] }, external_gate: { mode: "observe" } })).toContain(
      "review.merge.external_gate: needs merge.gate.source: signed (the signed gate at the head is the merge signal)",
    );
    expect(errors({ auto: true, external_gate: { mode: "act" } })).toContain(
      "review.merge.external_gate.mode: act replaces merge.auto; set auto: false",
    );
    expect(errors({ external_gate: { mode: "observe", gate_rules: [{ ...ROUTE_RULE, needs_any: [{}] }] } })).toContain(
      "review.merge.external_gate.gate_rules.routes.needs_any[0]: needs pipelines or reports",
    );
    expect(
      errors({ external_gate: { mode: "observe", gate_rules: [{ ...ROUTE_RULE, needs_any: [{ pipelines: ["nightly"] }] }] } }),
    ).toContain("review.merge.external_gate.gate_rules.routes.needs_any[0]: unknown pipeline nightly (not in merge.gate.pipeline_versions)");
    expect(errors({ external_gate: { mode: "observe", gate_rules: [ROUTE_RULE, ROUTE_RULE] } })).toContain(
      "review.merge.external_gate.gate_rules: duplicate rule id routes",
    );
    expect(errors({ external_gate: { mode: "maybe" } }).length).toBeGreaterThan(0);
    expect(errors({ external_gate: { mode: "act", extra: 1 } }).length).toBeGreaterThan(0);

    // ci_signal is read per repository, case-insensitively
    const exempt = parseReviewConfig(
      { enabled: true, merge: { gate: GATE, external_gate: { mode: "observe" } } },
      { github: REPO, pr_health: { repos: { "Example-Org/Demo": { ci_signal: false } } } },
    );
    expect(exempt.ok && exempt.settings.merge.externalGate.defaultRedExempt).toBe(true);
  });
});
