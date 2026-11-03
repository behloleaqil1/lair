/**
 * The readiness report (docs/design/planner-act.md §4.4, §8 PR 2, AT-15): mode_history, GET /api/planner/readiness,
 * its counts from planner.db and the spend events, the after-switch check and the load warning. The production
 * planner, agents module (agents.spend on), Decision Inbox, owner credential and stores (testing/harness.ts); only the
 * process spawner and the clock are fake. Proposals are stored the way a planner run stores them (insertProposal, then
 * decide), and the would_* records the way the backlog and spec parts record them (recordWould).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { PlannerReadinessView, ReadinessRowView } from "../../shared/planner-types.js";
import { parsePlannerConfig } from "./config.js";
import { MODE_HISTORY, recordWould, type WouldRecord } from "./readiness.js";
import { PlannerStore } from "./store.js";
import {
  cleanup,
  DASHBOARD,
  makePaths,
  MIN,
  NOW,
  plannerBlock,
  projectConfig,
  runPlannerAgent,
  setup,
  tasks,
  tasksText,
  writeProposals,
  type Harness,
  type Paths,
} from "./testing/harness.js";

vi.setConfig({ testTimeout: 30_000 });

const DAY = 24 * 60 * MIN;
const stores: { close(): void }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await cleanup();
});

const DRAGONS = {
  "worker-a": { id: "worker-a", name: "Alice", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  "worker-b": { id: "worker-b", name: "Bob", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  planner: { id: "planner", name: "Planner", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  verifier: { id: "verifier", name: "Verifier", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
};
const SAFE = { recheck_on_change: "act", prefilter_closed: "observe", dedupe_pending: "observe" };
const VERIFIER = { id: "verifier", prompt_file: "verifier.md", auto_apply: ["add"] };
const ON = { enabled: true };

function extraOf(p: Paths): Partial<ProjectConfig> {
  const agents = projectConfig(p, {}).agents as Record<string, unknown>;
  return { agents: { ...agents, spend: { enabled: true } }, dragons: DRAGONS } as unknown as Partial<ProjectConfig>;
}

function blockOf(p: Paths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return plannerBlock(p, { agent: { id: "planner", prompt_file: "planner.md", min_interval_seconds: 0, debounce_seconds: 0, max_proposals: 5 }, ...over });
}

async function boot(p: Paths, over: Record<string, unknown>, options: { dbs?: Harness["dbs"]; clock?: Harness["clock"] } = {}): Promise<Harness> {
  writeFileSync(join(p.promptsDir, "verifier.md"), "You are the verifier.\n");
  const h = await setup(p, blockOf(p, over), { extra: extraOf(p), dbs: options.dbs, clock: options.clock });
  await h.service.cycle();
  return h;
}

/** Stop the planner and start it again on the same data with `over` (a config reload). */
async function reload(h: Harness, p: Paths, over: Record<string, unknown>, at: number): Promise<Harness> {
  await h.planner.stop();
  h.clock.t = at;
  return boot(p, over, { dbs: h.dbs, clock: h.clock });
}

function storeOf(h: Harness): PlannerStore {
  const store = new PlannerStore(h.dbs.planner);
  stores.push(store);
  return store;
}

/** A verified proposal of an earlier run, decided by the owner, stored as a planner run stores it. */
function verified(store: PlannerStore, at: number, task: string, verdict: "approve" | "reject", status: "applied" | "declined") {
  const p = store.insertProposal({
    project: "demo", runId: randomUUID(), index: 0, op: "add", task, agent: "worker-a", text: task, reason: "ready in the plan",
    status: "pending", refusal: null, decidedBy: null, decidedAt: null, createdAt: at,
    verifierVerdict: verdict, verifierReason: "checked", verifierEvidence: null,
  });
  store.decide(p.id, status, "owner", at + MIN);
}

const get = (h: Harness, headers: Record<string, string> = h.owner) => h.app.inject({ method: "GET", url: "/api/planner/readiness", headers });
const report = async (h: Harness): Promise<PlannerReadinessView> => {
  const res = await get(h);
  if (res.statusCode !== 200) throw new Error(`${res.statusCode}: ${res.body}`);
  return res.json().data as PlannerReadinessView;
};
const row = (r: PlannerReadinessView, part: ReadinessRowView["part"]) => {
  const found = r.rows.find((x) => x.part === part);
  if (!found) throw new Error(`no ${part} row`);
  return found;
};
const failing = (x: ReadinessRowView) => x.criteria.filter((c) => !c.ok).map((c) => c.id);

/**
 * AT-15's week: recheck_on_change off from day 0, observe from day 2 (the history), 25 verified auto-apply proposals
 * on days 4-6 (24 approved by the owner), 20 would_add records (19 later added by the owner by hand, 1 for a skipped
 * task), 20 would_assign records (18 match the assignment that came next, 2 have none), 5 would_spec records (1 for a
 * task that already had a merged spec link).
 */
async function week(): Promise<{ p: Paths; h: Harness }> {
  const p = makePaths();
  tasks(p, "worker-a|Alice|feat-login|Login form");
  const observe = { mode: "observe", verifier: VERIFIER, act_evidence: ON };
  const h0 = await boot(p, { ...observe, guards: { prefilter_closed: "observe" } });
  const h = await reload(h0, p, { ...observe, guards: { prefilter_closed: "observe", recheck_on_change: "observe" } }, NOW + 2 * DAY);
  const store = storeOf(h);
  for (let i = 0; i < 25; i++) verified(store, NOW + 4 * DAY + i * MIN, `v${i}`, "approve", i === 0 ? "declined" : "applied");

  const would = (kind: WouldRecord["kind"], task: string, extra: Partial<WouldRecord> = {}) =>
    recordWould(store, "demo", { kind, task, agent: null, at: NOW + 4 * DAY, planText: `${task}: work`, specLink: null, ...extra });
  for (let i = 1; i <= 19; i++) would("would_add", `a${i}`);
  would("would_add", "a20", { planText: "a20: [blocked] waits for the vendor" });
  for (let i = 1; i <= 20; i++) would("would_assign", `u${i}`, { agent: "worker-a" });
  for (let i = 1; i <= 4; i++) would("would_spec", `s${i}`);
  would("would_spec", "s5", { specLink: "docs/design/s5.md" });

  // Day 5: the owner adds a1-a19, and gives u1-u18 to worker-a, by hand (two outside edits the planner records)
  h.clock.t = NOW + 5 * DAY;
  const added = Array.from({ length: 19 }, (_, i) => `worker-b|Bob|a${i + 1}|Task a${i + 1}`);
  writeFileSync(p.tasksFile, `${tasksText(h)}${added.join("\n")}\n`);
  await h.service.cycle();
  h.clock.t += MIN;
  const assigned = Array.from({ length: 18 }, (_, i) => `worker-a|Alice|u${i + 1}|Task u${i + 1}`);
  writeFileSync(p.tasksFile, `${tasksText(h)}${assigned.join("\n")}\n`);
  await h.service.cycle();
  expect(h.service.history().filter((c) => c.source === "external")).toHaveLength(2);
  return { p, h };
}

describe("AT-15: the readiness report", () => {
  it("planner.mode is not yet while recheck_on_change was off in the window (5), ready once it covers the window; the backlog, assign and spec rows", async () => {
    const { h } = await week();
    // Day 8: the window (days 1-8) starts while recheck_on_change was still off
    h.clock.t = NOW + 8 * DAY;
    const r = await report(h);
    expect(r).toMatchObject({ days: 7, minSamples: 20, minAgreement: 0.9, since: new Date(NOW + DAY).toISOString() });
    const planner = row(r, "planner.mode");
    expect(planner).toMatchObject({ mode: "observe", verdict: "not_yet", undone: [] });
    expect(failing(planner)).toEqual(["recheck_history"]);
    expect(planner.criteria.find((c) => c.id === "recheck_history")?.label).toContain("(5)");
    expect(planner.criteria.find((c) => c.id === "verified")?.detail).toBe("25 verified proposals in auto-applied ops (add); 20 needed");
    expect(planner.criteria.find((c) => c.id === "agreement")?.detail).toBe("the owner approved 24 of the 25 the verifier approved (0.96); 0.9 needed");

    expect(row(r, "backlog.mode")).toMatchObject({ mode: "off", verdict: "not_yet", failed: ["a20"] });
    expect(failing(row(r, "backlog.mode"))).toEqual(["no_skipped"]);
    expect(row(r, "backlog.assign")).toMatchObject({ mode: "off", verdict: "ready", failed: [] });
    expect(row(r, "backlog.assign").criteria.find((c) => c.id === "agreement")?.detail).toBe(
      "18 of 18 matched the assignment that came next (2 had none); 0.9 needed",
    );
    expect(row(r, "spec_first.mode")).toMatchObject({ mode: "off", verdict: "not_yet", failed: ["s5"] });
    expect(failing(row(r, "spec_first.mode"))).toEqual(["no_false_positive"]);

    // Day 10: the window (days 3-10) is all observe: ready
    h.clock.t = NOW + 10 * DAY;
    const later = row(await report(h), "planner.mode");
    expect(later.verdict).toBe("ready");
    expect(failing(later)).toEqual([]);

    // The route reads only: no history row, no state, no notice, no event; and it is the owner's
    const before = { history: h.service.history(1000).length, modes: storeOf(h).get("demo", MODE_HISTORY), decisions: h.inbox.list({ project: "demo" }).length };
    await report(h);
    expect({ history: h.service.history(1000).length, modes: storeOf(h).get("demo", MODE_HISTORY), decisions: h.inbox.list({ project: "demo" }).length }).toEqual(before);
    expect((await get(h, DASHBOARD)).statusCode).toBe(403);
    expect(tasksText(h)).toContain("worker-a|Alice|u18|Task u18");
  });

  it("after a switch to act: an undo within 24 h, or an outside edit that changes the line back, says switch back recommended and lists the change; later edits don't", async () => {
    const { p, h: week0 } = await week();
    const act = { verifier: undefined, guards: SAFE, act_evidence: ON };
    const h = await reload(week0, p, act, NOW + 10 * DAY);
    const planRun = async (proposals: unknown[]) => {
      writeFileSync(h.inboxFile, `- OWNER 2026-03-12T12:00:00Z [m${randomUUID().slice(0, 6)}]: plan\n`, { flag: "a" });
      await h.service.cycle();
      await runPlannerAgent(h, (c) => writeProposals(c, { proposals }));
      await h.service.cycle();
    };
    const add = (task: string, text: string) => ({ op: "add", task, agent: "worker-a", text, reason: "ready in the plan" });

    // A change edited only after 24 h: no switch back
    await planRun([add("t1", "One")]);
    h.clock.t += DAY + 10 * MIN;
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t1|One", "worker-a|Alice|t1|One, edited"));
    await h.service.cycle();
    expect(row(await report(h), "planner.mode").verdict).not.toBe("switch_back");

    // An outside edit 1 h later that changes the planner's line: switch back recommended
    await planRun([add("t2", "Two")]);
    h.clock.t += 60 * MIN;
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t2|Two", "worker-b|Bob|t2|Two"));
    await h.service.cycle();
    // An undo within 24 h
    await planRun([add("t3", "Three")]);
    const t3 = h.service.history().find((c) => c.op === "add" && c.task === "t3" && c.source === "proposal");
    const t2 = h.service.history().find((c) => c.op === "add" && c.task === "t2" && c.source === "proposal");
    expect((await h.app.inject({ method: "POST", url: `/api/planner/changes/${t3?.id}/undo`, headers: h.owner, payload: { confirm: true } })).statusCode).toBe(200);

    const planner = row(await report(h), "planner.mode");
    expect(planner).toMatchObject({ mode: "act", verdict: "switch_back" });
    expect(planner.undone).toEqual([
      expect.objectContaining({ change: t2?.id, op: "add", task: "t2", how: "edited back" }),
      expect.objectContaining({ change: t3?.id, op: "add", task: "t3", how: "undone" }),
    ]);
  });

  it("more than one dedupe would_refuse, or more than one refusal-window refusal, on one day: not yet, naming (3) or (4)", async () => {
    const { h } = await week();
    h.clock.t = NOW + 10 * DAY;
    // Two would_refuse on day 10, as the planner records them (the agents module's recordModuleGuard)
    for (const n of [1, 2]) {
      const recorded = await h.agents.recordModuleGuard("demo", "guard_would", {
        guard: "planner_dedupe_pending",
        verdict: "would_refuse",
        subject: `run-${n}`,
        summary: `planner_dedupe_pending (observe): add t${n} would be refused`,
        evidence: [`add t${n} -> worker-a`],
        data: { run: `run-${n}`, task: `t${n}`, op: "add", pending: `p${n}` },
        dedupeKey: `guard_would:planner_dedupe_pending:run-${n}:0`,
      });
      expect(recorded).toBe(true);
    }
    const dedupe = row(await report(h), "planner.mode");
    expect(failing(dedupe)).toEqual(["dedupe"]);
    expect(dedupe.criteria.find((c) => c.id === "dedupe")?.label).toContain("(3)");
    expect(dedupe.criteria.find((c) => c.id === "dedupe")?.detail).toBe("at most 2 on one day (2026-03-12); at most 1 allowed");

    // Two refusal-window refusals on day 7
    const store = storeOf(h);
    for (const task of ["r1", "r2"]) {
      store.insertProposal({
        project: "demo", runId: randomUUID(), index: 0, op: "add", task, agent: "worker-a", text: task, reason: "r",
        status: "rejected", refusal: `the owner undid add ${task} on 2026-03-08: not proposed again for 7 days (planner.act.refuse_undone_days)`,
        decidedBy: "lair", decidedAt: NOW + 7 * DAY, createdAt: NOW + 7 * DAY,
        verifierVerdict: null, verifierReason: null, verifierEvidence: null,
      });
    }
    const both = row(await report(h), "planner.mode");
    expect(failing(both)).toEqual(["dedupe", "refusals"]);
    expect(both.criteria.find((c) => c.id === "refusals")?.label).toContain("(4)");
  });

  it("mode_history: one entry per load whose modes changed, the newest 200; the report and its history are off by default", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    // Off (the default): no history, the route says how to turn it on, no warning
    const off = await boot(p, { mode: "observe" });
    expect(storeOf(off).get("demo", MODE_HISTORY)).toBeNull();
    const res = await get(off);
    expect([res.statusCode, res.json().error]).toEqual([409, "The readiness report is off: set planner.act_evidence.enabled: true"]);
    const on = await reload(off, p, { mode: "observe", act_evidence: ON }, NOW + MIN);
    await on.service.cycle();
    const same = await reload(on, p, { mode: "observe", act_evidence: ON }, NOW + 2 * MIN);
    const changed = await reload(same, p, { mode: "observe", act_evidence: ON, guards: { recheck_on_change: "observe" } }, NOW + 3 * MIN);
    expect(storeOf(changed).get("demo", MODE_HISTORY)).toEqual([
      expect.objectContaining({ at: NOW + MIN, mode: "observe", guards: expect.objectContaining({ recheck_on_change: "off" }) }),
      expect.objectContaining({ at: NOW + 3 * MIN, mode: "observe", guards: expect.objectContaining({ recheck_on_change: "observe" }) }),
    ]);
  });

  it("the load warning: act set while planner.mode is not yet raises one warning and one notice for the switch; a reload raises no second", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const warn = vi.spyOn(console, "warn");
    const h = await boot(p, { guards: SAFE, act_evidence: ON });
    const warning = h.service.status().warnings.find((w) => w.startsWith("planner.mode: act"));
    expect(warning).toBe(
      "planner.mode: act is set, but the readiness report says not yet: (1) verified samples, (2) owner agreement, (5) recheck_on_change history (GET /api/planner/readiness)",
    );
    expect(warn).toHaveBeenCalledWith(`[planner] demo: ${warning}`);
    const notice = h.inbox.list({ project: "demo" }).filter((d) => d.class === "planner.act_readiness");
    expect(notice).toEqual([expect.objectContaining({ attention: "notice", evidence: expect.objectContaining({ code: "act_not_ready" }) })]);
    expect(await h.answer(notice[0].id, "noted")).toBe(200);
    const again = await reload(h, p, { guards: SAFE, act_evidence: ON }, NOW + MIN);
    expect(again.inbox.list({ project: "demo" }).filter((d) => d.class === "planner.act_readiness")).toHaveLength(1);
    // Off: no warning, no notice
    const p2 = makePaths();
    tasks(p2, "worker-a|Alice|feat-login|Login form");
    const quiet = await boot(p2, { guards: SAFE });
    expect(quiet.service.status().warnings.filter((w) => w.includes("readiness"))).toEqual([]);
    expect(quiet.inbox.list({ project: "demo" }).filter((d) => d.class === "planner.act_readiness")).toEqual([]);
  });

  it("config: act_evidence's bounds", () => {
    const p = makePaths();
    const parse = (act_evidence: Record<string, unknown>) => {
      const config = projectConfig(p, blockOf(p, { mode: "observe", act_evidence }), extraOf(p));
      return parsePlannerConfig(config.planner, config);
    };
    const ok = parse({});
    expect(ok.ok && ok.settings.actEvidence).toEqual({ enabled: false, days: 7, minSamples: 20, minAgreement: 0.9 });
    for (const bad of [{ days: 0 }, { days: 61 }, { min_samples: 0 }, { min_samples: 1001 }, { min_agreement: 0 }, { min_agreement: 1.1 }, { other: 1 }]) {
      expect(parse(bad).ok).toBe(false);
    }
  });
});
