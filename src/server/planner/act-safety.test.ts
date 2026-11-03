/**
 * Planner act safety (docs/design/planner-act.md §4.3, §8 PR 1): the act-mode config rules in warn mode, the refusal
 * window and its holds, dedupe_pending, the verifier's merged PRs and the owner's Undo. The production planner,
 * agents module (agents.spend on), Decision Inbox, owner credential and review store (testing/harness.ts); only the
 * process spawner and the clock are fake, and the planner agent's run is a fixed proposals.json.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewStore } from "../review/store.js";
import { parsePlannerConfig } from "./config.js";
import { PlannerStore } from "./store.js";
import { REFUSAL_HOLD } from "./service.js";
import {
  cleanup,
  DASHBOARD,
  makePaths,
  MIN,
  NOW,
  plannerBlock,
  projectConfig,
  promptOf,
  runPlannerAgent,
  setup,
  tasks,
  tasksText,
  writeProposals,
  type Harness,
  type Paths,
  type SpawnCall,
} from "./testing/harness.js";

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

/** The act-mode guards (so no act-rule warning) */
const SAFE = { recheck_on_change: "act", prefilter_closed: "observe", dedupe_pending: "observe" };

function extraOf(p: Paths, spend = true): Partial<ProjectConfig> {
  const agents = projectConfig(p, {}).agents as Record<string, unknown>;
  return { agents: { ...agents, spend: { enabled: spend } }, dragons: DRAGONS } as unknown as Partial<ProjectConfig>;
}

/** A planner run starts as soon as a trigger is pending: no debounce, no interval. */
function blockOf(p: Paths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return plannerBlock(p, { agent: { id: "planner", prompt_file: "planner.md", min_interval_seconds: 0, debounce_seconds: 0, max_proposals: 5 }, ...over });
}

async function boot(p: Paths, over: Record<string, unknown> = {}, options: { dbs?: Harness["dbs"]; clock?: Harness["clock"]; reviews?: ReviewStore; spend?: boolean } = {}) {
  writeFileSync(join(p.promptsDir, "verifier.md"), "You are the verifier.\n");
  const reviews = options.reviews;
  const h = await setup(p, blockOf(p, over), {
    extra: extraOf(p, options.spend),
    dbs: options.dbs,
    clock: options.clock,
    prs: reviews ? { mergedPrs: (project, limit) => reviews.mergedPrs(project, limit) } : undefined,
  });
  await h.service.cycle();
  return h;
}

let messages = 0;
/** An owner message: a trigger, so a planner run starts at the next cycle. */
function ask(h: Harness): void {
  messages += 1;
  appendFileSync(h.inboxFile, `- OWNER 2026-03-02T12:00:00Z [m${messages}]: plan the next work\n`);
}

/** One planner run, from its trigger to its end, returning `proposals`. */
async function planRun(h: Harness, proposals: unknown[]): Promise<SpawnCall> {
  ask(h);
  await h.service.cycle();
  const call = await runPlannerAgent(h, (c) => writeProposals(c, { proposals }));
  await h.service.cycle();
  return call;
}

const add = (task: string, agent: string, text: string) => ({ op: "add", task, agent, text, reason: "ready in the plan" });
const post = (h: Harness, url: string, payload: unknown = { confirm: true }, headers: Record<string, string> = h.owner) =>
  h.app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
const undo = (h: Harness, id: string, payload: unknown = { confirm: true }, headers: Record<string, string> = h.owner) =>
  post(h, `/api/planner/changes/${id}/undo`, payload, headers);
const changeOf = (h: Harness, op: string, task: string) => {
  const found = h.service.history().find((c) => c.op === op && c.task === task && c.source === "proposal");
  if (!found) throw new Error(`no ${op} ${task} change`);
  return found;
};
/** The task's newest proposal */
const proposalOf = (h: Harness, task: string) => {
  const found = h.service.proposals().find((x) => x.task === task);
  if (!found) throw new Error(`no proposal for ${task}`);
  return found;
};
const notices = (h: Harness, cls: string) => h.inbox.list({ project: "demo" }).filter((d) => d.class === cls);
const events = (h: Harness, kind: "guard_would" | "guard_did") =>
  h.agentsStore.listEvents("demo", { kinds: [kind], limit: 100 }).filter((e) => e.data.guard === "planner_dedupe_pending");
const BASE = ["worker-a|Alice|feat-login|Login form", "worker-b|Bob|feat-cart|Cart"];

describe("AT-2 and AT-19: the act-mode config rules", () => {
  const configOf = (p: Paths, planner: Record<string, unknown>, spend = true) => projectConfig(p, planner, extraOf(p, spend));
  const parse = (p: Paths, planner: Record<string, unknown>, mode: "warn" | "refuse" = "warn", spend = true) => {
    const config = configOf(p, planner, spend);
    return parsePlannerConfig(config.planner, config, mode);
  };

  it("AT-2: act with recheck_on_change observe warns once (load warning and one planner.act_rules notice, none on reload); refuse mode refuses with the keys", async () => {
    const p = makePaths();
    tasks(p, ...BASE);
    const guards = { ...SAFE, recheck_on_change: "observe" };
    const h = await boot(p, { guards });
    const warning = h.service.status().warnings.find((w) => w.includes("planner.mode: act"));
    expect(warning).toContain("planner.guards.recheck_on_change: act");
    expect(warning).toContain("refused from the next release");
    const [notice, ...more] = notices(h, "planner.act_rules");
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ attention: "notice", evidence: { code: "act_rules_missing", facts: { rules: 1 } } });
    expect(notice.context).toContain("planner.guards.recheck_on_change");
    expect(notice.context).toContain("agents.spend.enabled: true");
    // The owner closes it; a reload (the planner on the same data, the same config) raises no second notice
    expect(await h.answer(notice.id, "noted")).toBe(200);
    await h.planner.stop();
    const again = await boot(p, { guards }, { dbs: h.dbs, clock: h.clock });
    await again.service.cycle();
    expect(notices(again, "planner.act_rules").map((d) => d.id)).toEqual([notice.id]);
    // Refuse mode (the next release): the planner does not load, with the same keys
    const refused = parse(p, blockOf(p, { guards }), "refuse");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors.join("\n")).toContain("planner.mode: act needs planner.guards.recheck_on_change: act");
    }
  });

  it("AT-19: prefilter_closed or dedupe_pending off in act warns (warn) or refuses (refuse), naming the keys; dedupe_pending needs spend; the defaults load with no warning", () => {
    const p = makePaths();
    for (const key of ["prefilter_closed", "dedupe_pending"]) {
      const planner = blockOf(p, { guards: { ...SAFE, [key]: "off" } });
      const warned = parse(p, planner);
      if (!warned.ok) throw new Error(warned.errors.join("; "));
      expect(warned.settings.actRules).toEqual([`planner.mode: act needs planner.guards.${key} at least observe (now off)`]);
      expect(warned.settings.warnings.some((w) => w.startsWith(`planner.mode: act needs planner.guards.${key}`))).toBe(true);
      const refused = parse(p, planner, "refuse");
      expect(refused.ok ? [] : refused.errors).toEqual([expect.stringContaining(`planner.mode: act needs planner.guards.${key} at least observe`)]);
    }
    // Every rule broken at once: one message for the recheck rule, one naming both other keys
    const bare = parse(p, blockOf(p));
    expect(bare.ok && bare.settings.actRules).toEqual([
      expect.stringContaining("planner.guards.recheck_on_change: act"),
      "planner.mode: act needs planner.guards.prefilter_closed and planner.guards.dedupe_pending at least observe (now off)",
    ]);
    // dedupe_pending is a guard: it needs agents.spend.enabled, as G6's do
    const noSpend = parse(p, blockOf(p, { mode: "observe", guards: { dedupe_pending: "observe" } }), "warn", false);
    expect(noSpend.ok ? [] : noSpend.errors).toEqual([
      "planner.guards.dedupe_pending: observe needs agents.spend.enabled: true (a guard's verdicts and counts are written by spend)",
    ]);
    // The defaults (observe) and act with the guards set: no act rule, no warning about it
    for (const planner of [blockOf(p, { mode: "observe" }), blockOf(p, { guards: SAFE })]) {
      const ok = parse(p, planner);
      if (!ok.ok) throw new Error(ok.errors.join("; "));
      expect(ok.settings.actRules).toEqual([]);
      expect(ok.settings.warnings.filter((w) => w.includes("planner.mode"))).toEqual([]);
      expect(ok.settings.refuseUndoneDays).toBe(7);
    }
    expect(parse(p, blockOf(p, { act: { refuse_undone_days: 91 } })).ok).toBe(false);
  });
});

describe("AT-1: outside edits during an act run are kept, and a removed line is recorded", () => {
  it("both edits stay, one notice for the run, two external rows; the reword of the removed task is refused, the add applies; a removal record holds the task", async () => {
    const p = makePaths();
    tasks(p, ...BASE);
    const h = await boot(p, { guards: SAFE });
    ask(h);
    await h.service.cycle();
    const r = h.service.runs()[0];
    expect(r.state).toBe("running");
    h.spawner.behaviour = (c) => {
      if (c.env.LAIR_AGENT === "planner") {
        writeProposals(c, { proposals: [{ op: "reword", task: "t2", text: "Two, reworded", reason: "the plan says so" }, add("t9", "worker-b", "Nine")] });
      }
    };
    await h.agentsService.tick();
    const call = h.spawner.calls.at(-1) as SpawnCall;
    h.spawner.behaviour = undefined;
    // The owner adds 3 lines; a cycle; 2 minutes later the owner removes one of them; a cycle
    const three = ["# agent|name|task|description", ...BASE, "worker-a|Alice|t1|One", "worker-a|Alice|t2|Two", "worker-b|Bob|t3|Three", ""].join("\n");
    writeFileSync(h.tasksFile, three);
    await h.service.cycle();
    h.clock.t += 2 * MIN;
    const two = three.replace("worker-a|Alice|t2|Two\n", "");
    writeFileSync(h.tasksFile, two);
    await h.service.cycle();
    expect(tasksText(h)).toBe(two);
    // R ends
    h.clock.t += MIN;
    appendFileSync(call.logPath, "worked\n");
    utimesSync(call.logPath, new Date(h.clock.now()), new Date(h.clock.now()));
    h.spawner.exit(call.pid, 0);
    await h.agentsService.tick();
    await h.service.cycle();

    expect(tasksText(h)).toBe(`${two}worker-b|Bob|t9|Nine\n`);
    expect(notices(h, "planner.guard_notice").filter((d) => d.evidence?.facts.run === r.id)).toHaveLength(1);
    const external = h.service.history().filter((c) => c.source === "external");
    expect(external.map((c) => c.diff)).toEqual([
      ["-5 worker-a|Alice|t2|Two"],
      ["+4 worker-a|Alice|t1|One", "+5 worker-a|Alice|t2|Two", "+6 worker-b|Bob|t3|Three"],
    ]);
    expect(h.service.history().filter((c) => c.source === "restored")).toEqual([]);
    expect(proposalOf(h, "t2")).toMatchObject({ status: "rejected", refusal: "task t2 has no open line in the tasks file" });
    expect(proposalOf(h, "t9")).toMatchObject({ status: "applied" });
    expect(h.service.overview().refusals).toEqual([{ op: "add", task: "t2", at: new Date(NOW + 2 * MIN).toISOString(), why: "removed", held: true }]);
  });
});

describe("AT-13: dedupe_pending", () => {
  async function twoRuns(mode: "act" | "observe") {
    const p = makePaths();
    tasks(p, ...BASE);
    const h = await boot(p, { mode: "observe", guards: { dedupe_pending: mode } });
    await planRun(h, [add("t1", "worker-a", "One")]);
    const first = proposalOf(h, "t1");
    expect(first.status).toBe("pending");
    await planRun(h, [add("t1", "worker-a", "One"), add("t1", "worker-b", "One")]);
    const [dup, other] = h.service.proposals().filter((x) => x.runId !== first.runId);
    return { h, first, dup, other };
  }

  it("act: the duplicate is refused naming the pending proposal and its run; the other agent's add is checked normally", async () => {
    const { h, first, dup, other } = await twoRuns("act");
    expect(dup).toMatchObject({ agent: "worker-a", status: "rejected" });
    expect(dup.refusal).toBe(`already pending as proposal ${first.id.slice(0, 8)} of run ${first.runId.slice(0, 8)} (planner.guards.dedupe_pending)`);
    expect(other).toMatchObject({ agent: "worker-b", status: "pending", refusal: null });
    expect(events(h, "guard_did")).toEqual([expect.objectContaining({ data: expect.objectContaining({ verdict: "refuse", task: "t1", pending: first.id }) })]);
    expect(events(h, "guard_would")).toEqual([]);
  });

  it("observe: the duplicate is kept, and one would_refuse is recorded", async () => {
    const { h, first, dup, other } = await twoRuns("observe");
    expect(dup).toMatchObject({ agent: "worker-a", status: "pending", refusal: null });
    // The first add stays in the run's working copy of the file, so today's rule refuses the second
    expect(other.refusal).toMatch(/^task t1 is already in the tasks file/);
    expect(events(h, "guard_would")).toEqual([expect.objectContaining({ data: expect.objectContaining({ verdict: "would_refuse", pending: first.id }) })]);
    expect(events(h, "guard_did")).toEqual([]);
  });
});

describe("AT-14: the owner's Undo", () => {
  async function applied() {
    const p = makePaths();
    tasks(p, ...BASE, "worker-a|Alice|t2|Two", "worker-b|Bob|t3|Three");
    const h = await boot(p, { guards: SAFE, approval: { drop: "never" } });
    await planRun(h, [add("t1", "worker-a", "One"), add("t4", "worker-b", "Four"), { op: "reword", task: "t2", text: "Two, better", reason: "r" }, { op: "drop", task: "t3", reason: "r" }]);
    expect(h.service.proposals().map((x) => x.status)).toEqual(["applied", "applied", "applied", "applied"]);
    return { p, h };
  }

  it("removes the added line once, records an undo row and a refusal; a second call returns the same row; edited, running, drop, rules and unknown changes are refused; owner session and confirm are needed", async () => {
    const { p, h } = await applied();
    const c = changeOf(h, "add", "t1");
    expect(c.undoable).toBe(true);
    expect(changeOf(h, "drop", "t3").undoable).toBe(false);
    expect((await undo(h, c.id, { confirm: true }, DASHBOARD)).statusCode).toBe(403);
    expect((await undo(h, c.id, {})).statusCode).toBe(400);
    expect((await undo(h, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);

    const first = await undo(h, c.id);
    expect(first.statusCode).toBe(200);
    const row = first.json().data;
    expect(row).toMatchObject({ source: "owner", op: "undo", task: "t1", diff: ["-5 worker-a|Alice|t1|One"] });
    const after = tasksText(h);
    expect(after).not.toContain("|t1|");
    expect(h.service.overview().refusals).toEqual([expect.objectContaining({ op: "add", task: "t1", why: "undid", held: true })]);
    expect(changeOf(h, "add", "t1")).toMatchObject({ undoable: false, undoneBy: row.id });
    const second = await undo(h, c.id);
    expect(second.json().data.id).toBe(row.id);
    expect(tasksText(h)).toBe(after);
    expect(h.service.history().filter((x) => x.op === "undo")).toHaveLength(1);

    // A line the owner edited since: 409
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t2|Two, better", "worker-a|Alice|t2|Two, by hand"));
    const edited = await undo(h, changeOf(h, "reword", "t2").id);
    expect([edited.statusCode, edited.json().error]).toEqual([409, "the line of task t2 is no longer as this change wrote it: edit the file"]);
    // A drop: 409
    const dropped = await undo(h, changeOf(h, "drop", "t3").id);
    expect([dropped.statusCode, dropped.json().error]).toEqual([409, "this drop (proposal, applied) can't be undone here: edit the file"]);
    // A task with an active run: 409, and its line stays
    await h.agents.requestRun("demo", { agent: "worker-b", task: "t4", prompt: "do t4" });
    const running = await undo(h, changeOf(h, "add", "t4").id);
    expect(running.statusCode).toBe(409);
    expect(running.json().error).toMatch(/^task t4 has an active run/);
    expect(tasksText(h)).toContain("worker-b|Bob|t4|Four");
  });

  it("a reword's undo puts the line before it back; a rules change (the queue's done line) is refused naming the queue line", async () => {
    const { p, h } = await applied();
    // An add whose task has a done line since: its line stays
    appendFileSync(p.queueFile, "- DONE t1 by worker-a 12:20Z: merged\n");
    await h.service.cycle();
    expect(tasksText(h)).toContain("#done worker-a|Alice|t1|One");
    const doneAdd = await undo(h, changeOf(h, "add", "t1").id);
    expect([doneAdd.statusCode, doneAdd.json().error]).toEqual([409, "task t1 is done (line 5): its line stays"]);
    const reword = await undo(h, changeOf(h, "reword", "t2").id);
    expect(reword.statusCode).toBe(200);
    expect(tasksText(h)).toContain("worker-a|Alice|t2|Two\n");
    expect(h.service.overview().refusals).toEqual([expect.objectContaining({ op: "reword", task: "t2", why: "undid", held: false })]);
    appendFileSync(p.queueFile, "- DONE feat-cart by worker-b 12:30Z: merged\n");
    await h.service.cycle();
    const rules = h.service.history().find((x) => x.source === "deterministic" && x.task === "feat-cart");
    expect(rules?.undoable).toBe(false);
    const refused = await undo(h, rules?.id ?? "");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("- DONE feat-cart by worker-b 12:30Z: merged");
  });
});

describe("AT-18: the refusal window and the hold", () => {
  it("an undone add is refused with the same text and held with other text; a declined add (observe, then act) and a hand-removed line are refused; on day 8 all wait for the owner; a plan reword lifts the hold", async () => {
    const p = makePaths();
    writeFileSync(p.planFile, ["# Plan", "- [ ] t1: First", "- [ ] t2: Second", "- [ ] t3: Third"].join("\n"));
    tasks(p, ...BASE);
    // Observe: the owner declines add t2
    const o = await boot(p, { mode: "observe", guards: SAFE });
    await planRun(o, [add("t2", "worker-b", "Second")]);
    expect((await post(o, `/api/planner/proposals/${proposalOf(o, "t2").id}/reject`)).statusCode).toBe(200);
    expect(o.service.overview().refusals).toEqual([expect.objectContaining({ op: "add", task: "t2", why: "declined" })]);
    await o.planner.stop();

    // The project switches to act
    const h = await boot(p, { guards: SAFE }, { dbs: o.dbs, clock: o.clock });
    await planRun(h, [add("t1", "worker-a", "First"), add("t2", "worker-b", "Second"), add("t3", "worker-b", "Third")]);
    expect(proposalOf(h, "t2")).toMatchObject({ status: "rejected", refusal: "the owner declined add t2 on 2026-03-02: not proposed again for 7 days (planner.act.refuse_undone_days)" });
    expect(proposalOf(h, "t1").status).toBe("applied");
    expect((await undo(h, changeOf(h, "add", "t1").id)).statusCode).toBe(200);
    // Run N+1: the same text is refused with the undo's reason
    await planRun(h, [add("t1", "worker-a", "First")]);
    expect(proposalOf(h, "t1")).toMatchObject({ status: "rejected", refusal: "the owner undid add t1 on 2026-03-02: not proposed again for 7 days (planner.act.refuse_undone_days)" });
    // Run N+2: other text waits for the owner, naming the record
    await planRun(h, [add("t1", "worker-a", "First, smaller")]);
    expect(proposalOf(h, "t1")).toMatchObject({ status: "pending", verifierVerdict: "unsure", verifierReason: `${REFUSAL_HOLD}the owner undid add t1 on 2026-03-02; it waits for you` });
    expect(tasksText(h)).not.toContain("|t1|");
    expect((await post(h, `/api/planner/proposals/${proposalOf(h, "t1").id}/reject`)).statusCode).toBe(200);

    // Day 3: the owner deletes the planner's t3 line by hand; an add of it is refused
    h.clock.t = NOW + 3 * DAY;
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-b|Bob|t3|Third\n", ""));
    await h.service.cycle();
    await planRun(h, [add("t3", "worker-b", "Third")]);
    expect(proposalOf(h, "t3").refusal).toMatch(/^the owner removed add t3 on 2026-03-05: not proposed again for 7 days/);

    // 8 days after the newest record: past the window, each waits for the owner instead of applying (the hold)
    h.clock.t = NOW + 11 * DAY;
    await planRun(h, [add("t1", "worker-a", "First"), add("t2", "worker-b", "Second"), add("t3", "worker-b", "Third")]);
    for (const task of ["t1", "t2", "t3"]) {
      expect(proposalOf(h, task)).toMatchObject({ status: "pending", verifierVerdict: "unsure" });
      expect(proposalOf(h, task).verifierReason).toMatch(new RegExp(`^${REFUSAL_HOLD}the owner (undid|declined|removed) add ${task} on `));
    }
    // The plan rewords t3: its add is checked normally, and applies
    writeFileSync(p.planFile, ["# Plan", "- [ ] t1: First", "- [ ] t2: Second", "- [ ] t3: Third, now with tests"].join("\n"));
    await planRun(h, [add("t3", "worker-a", "Third, now with tests")]);
    expect(proposalOf(h, "t3")).toMatchObject({ status: "applied", verifierReason: null });
    expect(tasksText(h)).toContain("worker-a|Alice|t3|Third, now with tests");
  });

  it("a restart between the undo's write and its history row keeps the row and the record exactly once", async () => {
    const p = makePaths();
    tasks(p, ...BASE);
    const h = await boot(p, { guards: SAFE });
    await planRun(h, [add("t1", "worker-a", "One")]);
    const c = changeOf(h, "add", "t1");
    vi.spyOn(PlannerStore.prototype, "addChange").mockImplementationOnce(() => {
      throw new Error("the server stopped");
    });
    expect((await undo(h, c.id)).statusCode).toBe(500);
    expect(tasksText(h)).not.toContain("|t1|");
    expect(h.service.history().filter((x) => x.op === "undo")).toEqual([]);
    await h.planner.stop();

    const again = await boot(p, { guards: SAFE }, { dbs: h.dbs, clock: h.clock });
    const undos = again.service.history().filter((x) => x.op === "undo");
    expect(undos).toHaveLength(1);
    expect(again.service.history().filter((x) => x.source === "external")).toEqual([]);
    expect(again.service.overview().refusals).toEqual([expect.objectContaining({ op: "add", task: "t1", why: "undid" })]);
    const repeat = await undo(again, c.id);
    expect(repeat.json().data.id).toBe(undos[0].id);
    expect(again.service.history().filter((x) => x.op === "undo")).toHaveLength(1);
  });

  it("a plan source that can't be read keeps a hold; only a real change of the task's plan text lifts it", async () => {
    const p = makePaths();
    writeFileSync(p.planFile, ["# Plan", "- [ ] t1: First"].join("\n"));
    tasks(p, ...BASE, "worker-a|Alice|t1|First");
    const h = await boot(p, { guards: SAFE });
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t1|First\n", ""));
    await h.service.cycle();
    expect(h.service.overview().refusals).toEqual([expect.objectContaining({ task: "t1", why: "removed", held: true })]);
    rmSync(p.planFile);
    h.clock.t = NOW + 8 * DAY;
    await planRun(h, [add("t1", "worker-a", "First")]);
    expect(proposalOf(h, "t1")).toMatchObject({ status: "pending", verifierVerdict: "unsure" });
    expect(h.service.overview().refusals[0].held).toBe(true);
    writeFileSync(p.planFile, ["# Plan", "- [ ] t1: First, again"].join("\n"));
    await h.service.cycle();
    expect(h.service.overview().refusals[0].held).toBe(false);
  });

  it("a verifier-approved add is not applied when the owner declined the same add while it was verified", async () => {
    const p = makePaths();
    tasks(p, ...BASE);
    const h = await boot(p, { guards: SAFE, verifier: { id: "verifier", prompt_file: "verifier.md", auto_apply: ["add"] } });
    const verify = async (verdict: string) => {
      const before = h.spawner.calls.length;
      h.spawner.behaviour = (c) => {
        if (c.env.LAIR_AGENT !== "verifier") return;
        const path = /Write your verdicts as JSON to this file, and nothing else: (\S+)/.exec(promptOf(c))?.[1] ?? "";
        writeFileSync(path, JSON.stringify({ verdicts: [{ proposal: 0, verdict, reason: "checked" }] }));
      };
      await h.agentsService.tick();
      const call = h.spawner.calls.slice(before).find((c) => c.env.LAIR_AGENT === "verifier") as SpawnCall;
      h.spawner.behaviour = undefined;
      h.clock.t += 2 * MIN;
      appendFileSync(call.logPath, "verified\n");
      utimesSync(call.logPath, new Date(h.clock.now()), new Date(h.clock.now()));
      h.spawner.exit(call.pid, 0);
      await h.agentsService.tick();
      await h.service.cycle();
    };
    // Run B: the verifier is unsure, so add t5 waits for the owner
    await planRun(h, [add("t5", "worker-b", "Five")]);
    await verify("unsure");
    const b = proposalOf(h, "t5");
    expect(b.status).toBe("pending");
    // Run A proposes the same add (dedupe_pending observes only); while its verifier runs the owner declines B's
    await planRun(h, [add("t5", "worker-b", "Five")]);
    expect((await post(h, `/api/planner/proposals/${b.id}/reject`)).statusCode).toBe(200);
    await verify("approve");
    expect(proposalOf(h, "t5")).toMatchObject({ status: "rejected", refusal: expect.stringMatching(/^the owner declined add t5 on /) });
    expect(readFileSync(h.tasksFile, "utf-8")).not.toContain("|t5|");
  });

  it("a hand edit that puts back a line the planner reworded is recorded as that reword; another hand edit is not", async () => {
    const p = makePaths();
    tasks(p, ...BASE, "worker-a|Alice|t2|Two");
    const h = await boot(p, { guards: SAFE });
    await planRun(h, [{ op: "reword", task: "t2", text: "Two, better", reason: "r" }]);
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-b|Bob|feat-cart|Cart", "worker-b|Bob|feat-cart|Cart, by hand"));
    await h.service.cycle();
    expect(h.service.overview().refusals).toEqual([]);
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t2|Two, better", "worker-a|Alice|t2|Two"));
    await h.service.cycle();
    expect(h.service.overview().refusals).toEqual([expect.objectContaining({ op: "reword", task: "t2", why: "removed", held: false })]);
    await planRun(h, [{ op: "reword", task: "t2", text: "Two, better", reason: "r" }]);
    expect(proposalOf(h, "t2").refusal).toMatch(/^the owner removed reword t2 on /);
  });
});

describe("AT-20 (verifier half): the verifier sees merged PRs when prefilter_closed is not act", () => {
  function reviewsWith3(p: Paths): ReviewStore {
    const reviews = new ReviewStore(join(p.dir, "data", "review.db"));
    stores.push(reviews);
    for (const pr of [41, 42, 43]) {
      reviews.observePull("demo", pr, `agent/worker-a/t-${pr}`, "open", "2026-03-01T10:00:00.000Z");
      reviews.recordMerge({ project: "demo", pr, headSha: "a".repeat(40), method: "host", strategy: "squash", resultSha: null, initiatedBy: "owner", at: "2026-03-01T11:00:00.000Z", commitsChecked: 1, conditions: {}, client: null });
    }
    return reviews;
  }
  const jsonOf = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf("```json\n") + "```json\n".length, prompt.lastIndexOf("\n```")));

  async function verified(prefilter: "off" | "observe" | "act") {
    const p = makePaths();
    tasks(p, ...BASE);
    const h = await boot(p, { mode: "observe", guards: { prefilter_closed: prefilter }, verifier: { id: "verifier", prompt_file: "verifier.md" } }, { reviews: reviewsWith3(p) });
    const planner = await planRun(h, [add("t1", "worker-a", "One")]);
    await h.agentsService.tick();
    const verifier = h.spawner.calls.find((c) => c.env.LAIR_AGENT === "verifier");
    if (!verifier) throw new Error("the verifier was not started");
    return { planner: jsonOf(promptOf(planner)), verifier: jsonOf(promptOf(verifier)) };
  }

  it("observe: the verifier's context has closed.mergedPrs with the 3 PRs; the planner's has no closed block", async () => {
    const { planner, verifier } = await verified("observe");
    expect(planner.closed).toBeUndefined();
    expect(verifier.context.closed.mergedPrs.map((m: { pr: number }) => m.pr).sort()).toEqual([41, 42, 43]);
  });

  it("off: today's contexts, neither has it", async () => {
    const { planner, verifier } = await verified("off");
    expect(planner.closed).toBeUndefined();
    expect(verifier.context.closed).toBeUndefined();
  });

  it("act: both have it, once", async () => {
    const { planner, verifier } = await verified("act");
    expect(planner.closed.mergedPrs).toHaveLength(3);
    expect(verifier.context.closed).toEqual(planner.closed);
  });
});

describe("AT-17: these parts off are today's behaviour", () => {
  it("refuse_undone_days 0 and dedupe_pending off: a declined add comes back pending, a removal records nothing, a duplicate stays, no notice", async () => {
    const p = makePaths();
    tasks(p, ...BASE, "worker-a|Alice|t2|Two");
    const h = await boot(p, { mode: "observe", act: { refuse_undone_days: 0 } }, { spend: false });
    await planRun(h, [add("t1", "worker-a", "One")]);
    expect((await post(h, `/api/planner/proposals/${proposalOf(h, "t1").id}/reject`)).statusCode).toBe(200);
    await planRun(h, [add("t1", "worker-a", "One")]);
    expect(proposalOf(h, "t1")).toMatchObject({ status: "pending", refusal: null, verifierReason: null });
    await planRun(h, [add("t1", "worker-a", "One")]);
    expect(proposalOf(h, "t1")).toMatchObject({ status: "pending", refusal: null });
    writeFileSync(p.tasksFile, tasksText(h).replace("worker-a|Alice|t2|Two\n", ""));
    await h.service.cycle();
    expect(h.service.overview().refusals).toEqual([]);
    expect(h.inbox.list({ project: "demo" }).filter((d) => d.class === "planner.act_rules" || d.class === "planner.guard_notice")).toEqual([]);
    expect(h.agentsStore.listEvents("demo", { kinds: ["guard_would", "guard_did"], limit: 10 })).toEqual([]);
    expect(h.service.status().warnings.filter((w) => w.includes("planner.mode"))).toEqual([]);
  });
});
