/**
 * G6, the planner guards (docs/design/ai-spend.md §4.5, AT-24 to AT-28 and AT-30): the production planner, agents
 * module (agents.spend on), Decision Inbox and owner credential (testing/harness.ts), and the review store wired as
 * the server wires it (src/server/index.ts: ReviewManager.mergedPrs reads ReviewStore.mergedPrs). Only the process
 * spawner and the clock are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewStore } from "../review/store.js";
import {
  at,
  cleanup,
  DASHBOARD,
  makePaths,
  MIN,
  plannerBlock,
  projectConfig,
  promptOf,
  queue,
  runPlannerAgent,
  SEC,
  setup,
  tasks,
  tasksText,
  writeProposals,
  type Harness,
  type Paths,
  type SpawnCall,
} from "./testing/harness.js";
import { PlannerStore } from "./store.js";
import { branchNamesTask, inputsHash, ownMergedPr } from "./guards.js";
import { OWNER_SESSION_HEADER } from "../human-auth/index.js";

const stores: { close(): void }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await cleanup();
});

const DRAGONS = {
  "worker-a": { id: "worker-a", name: "Alice", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  "worker-b": { id: "worker-b", name: "Bob", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  planner: { id: "planner", name: "Planner", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
  verifier: { id: "verifier", name: "Verifier", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
};

interface Options {
  verifier?: boolean;
  /** agents.spend.enabled (the guards need it); default on */
  spend?: boolean;
}

/** The project's extra config: agents.spend on, and the verifier agent when asked for. */
function extraOf(p: Paths, options: Options): Partial<ProjectConfig> {
  const agents = projectConfig(p, {}).agents as Record<string, unknown>;
  return {
    agents: { ...agents, spend: { enabled: options.spend ?? true } },
    ...(options.verifier ? { dragons: DRAGONS } : {}),
  } as unknown as Partial<ProjectConfig>;
}

function blockOf(p: Paths, guards: Record<string, unknown> | undefined, options: Options, over: Record<string, unknown> = {}): Record<string, unknown> {
  return plannerBlock(p, {
    ...(guards ? { guards } : {}),
    ...(options.verifier ? { verifier: { id: "verifier", prompt_file: "verifier.md" } } : {}),
    ...over,
  });
}

/** review.db as the review module keeps it, read through the planner's `prs` as the server wires it. */
function reviewsOf(p: Paths): ReviewStore {
  const store = new ReviewStore(join(p.dir, "data", "review.db"));
  stores.push(store);
  return store;
}

function merge(reviews: ReviewStore, pr: number, at: string): void {
  reviews.recordMerge({
    project: "demo",
    pr,
    headSha: "a".repeat(40),
    method: "host",
    strategy: "squash",
    resultSha: null,
    initiatedBy: "owner",
    at,
    commitsChecked: 1,
    conditions: {},
    client: null,
  });
}

async function boot(p: Paths, guards: Record<string, unknown> | undefined, options: Options = {}, reviews?: ReviewStore, over: Record<string, unknown> = {}) {
  writeFileSync(join(p.promptsDir, "verifier.md"), "You are the verifier.\n");
  return setup(p, blockOf(p, guards, options, over), {
    extra: extraOf(p, options),
    prs: reviews ? { mergedPrs: (project, limit) => reviews.mergedPrs(project, limit) } : undefined,
  });
}

/** The context bundle Lair put in a planner run's prompt (the JSON block at its end). */
function contextOf(call: SpawnCall): {
  openTasks: { id: string | null }[];
  ownerMessages: { id: string }[];
  closed?: { tasks: { id: string; why: string }[]; mergedPrs: { pr: number; branch: string | null }[] };
} {
  const prompt = promptOf(call);
  const start = prompt.lastIndexOf("```json\n");
  const end = prompt.lastIndexOf("\n```");
  return JSON.parse(prompt.slice(start + "```json\n".length, end));
}

const events = (h: Harness, kind: "guard_would" | "guard_did", guard: string) =>
  h.agentsStore.listEvents("demo", { kinds: [kind], limit: 100 }).filter((e) => e.data.guard === guard);
const notices = (h: Harness) => h.inbox.list({ project: "demo" }).filter((d) => d.class === "planner.guard_notice");
const guardOf = (h: Harness, guard: string) => h.agentsService.spendReport("today", "origin").guards.find((g) => g.guard === guard);
const post = (h: Harness, url: string, headers: Record<string, string> = h.owner) => h.app.inject({ method: "POST", url, headers, payload: {} });
const runOf = (h: Harness, id: string) => {
  const store = new PlannerStore(h.dbs.planner);
  try {
    return store.getRun(id);
  } finally {
    store.close();
  }
};

/** The verifier agent's run: spawned by the agents tick, it exits 0 two minutes later (writing no verdicts). */
async function runVerifier(h: Harness): Promise<SpawnCall> {
  const before = h.spawner.calls.length;
  await h.agentsService.tick();
  const call = h.spawner.calls.slice(before).find((c) => c.env.LAIR_AGENT === "verifier");
  if (!call) throw new Error("the verifier agent was not spawned");
  h.clock.t += 2 * MIN;
  appendFileSync(call.logPath, "worked\n");
  const t = new Date(h.clock.now());
  utimesSync(call.logPath, t, t);
  h.spawner.exit(call.pid, 0);
  await h.agentsService.tick();
  return call;
}

/** The plan and tasks file of AT-24: a done backlog id, a task whose own PR merged, and a follow-up that only mentions it. */
function closedWorkProject(p: Paths, reviews: ReviewStore): void {
  writeFileSync(p.planFile, ["# Plan", "- [ ] B-7: Clean up the old exports", "- [ ] t-42: Search page", "- [ ] t-43: Fix the regression from #42"].join("\n"));
  tasks(p, "worker-a|Alice|feat-login|Login form", "#done worker-a|Alice|B-7|Clean up the old exports");
  // PR #42's branch names t-42 (as the review module read it from the host), and the review module merged it
  reviews.observePull("demo", 42, "agent/worker-a/t-42", "open", "2026-03-01T10:00:00.000Z");
  merge(reviews, 42, "2026-03-01T11:00:00.000Z");
}

const T42 = { op: "add", task: "t-42", agent: "worker-b", text: "Search page (plan: t-42)", reason: "ready in the plan" };
const T43 = { op: "add", task: "t-43", agent: "worker-b", text: "Fix the regression from #42", reason: "a follow-up of #42" };

describe("G6's pure parts", () => {
  it("a branch names a task id only as whole consecutive parts; a task's own merged PR is by its branch or its DONE line's PR", () => {
    expect(branchNamesTask("agent/worker-a/t-42", "t-42")).toBe(true);
    expect(branchNamesTask("agent/worker-a/T-42", "t-42")).toBe(true);
    expect(branchNamesTask("t-42", "t-42")).toBe(true);
    expect(branchNamesTask("feat/area/t-42/fix", "area/t-42")).toBe(true);
    expect(branchNamesTask("agent/worker-a/t-420", "t-42")).toBe(false);
    expect(branchNamesTask("agent/worker-a/t-42-fix", "t-42")).toBe(false);
    expect(branchNamesTask("agent/t-42", "worker-a/t-42")).toBe(false);
    const own = ownMergedPr(
      [
        { pr: 42, branch: "agent/worker-a/t-42", at: null },
        { pr: 50, branch: null, at: null },
      ],
      (task) => (task === "t-50" ? 50 : task === "t-51" ? 51 : null),
    );
    expect(own("t-42")).toBe("its own PR #42 (branch agent/worker-a/t-42) merged");
    expect(own("t-50")).toBe("its own PR #50, which its DONE line names, merged");
    expect(own("t-51")).toBeNull();
    expect(own("t-4")).toBeNull();
  });

  it("the inputs' hash leaves out recent events, triggers and times, and changes with any listed input", () => {
    const task = { source: "plan", file: "plan.md", line: 1, id: "t-1", text: "One", done: false, section: null, phase: null, dependsOn: [], details: [], ready: true, waitingOn: [] };
    const inputs = {
      tasksText: "# agent|name|task|description\n",
      openTasks: [task],
      messages: [{ id: "m1", at: "11:00Z", text: "Please" }],
      blocked: [{ task: "t-2", agent: "worker-a", reason: "docker is down", class: "environment" as const, rule: "docker", at: "2026-03-02T11:00:00.000Z", attempts: 0, route: "a decision" }],
      closed: null,
      allowlist: ["worker-a", "worker-b"],
      idle: ["worker-b"],
    };
    const h = inputsHash(inputs);
    expect(inputsHash({ ...inputs, allowlist: ["worker-b", "worker-a"] })).toBe(h);
    expect(inputsHash({ ...inputs, messages: [{ ...inputs.messages[0], at: "11:30Z" }] })).toBe(h);
    expect(inputsHash({ ...inputs, blocked: [{ ...inputs.blocked[0], at: "2026-03-02T12:00:00.000Z", attempts: 1, route: "x" }] })).toBe(h);
    expect(inputsHash({ ...inputs, openTasks: [{ ...task, line: 9, section: "Later" }] })).toBe(h);
    expect(inputsHash({ ...inputs, messages: [] })).not.toBe(h);
    expect(inputsHash({ ...inputs, openTasks: [{ ...task, text: "One, changed" }] })).not.toBe(h);
    expect(inputsHash({ ...inputs, tasksText: `${inputs.tasksText}worker-a|Alice|t-1|One\n` })).not.toBe(h);
    expect(inputsHash({ ...inputs, idle: [] })).not.toBe(h);
    expect(inputsHash({ ...inputs, closed: { tasks: [{ id: "t-9", why: "done" }], mergedPrs: [] } })).not.toBe(h);
  });
});

describe("G6 prefilter_closed: closed work leaves the context", () => {
  it("AT-24 act: a done id and a task whose own PR merged are dropped and listed as closed; an add of one is refused before the verifier", async () => {
    const p = makePaths();
    const reviews = reviewsOf(p);
    closedWorkProject(p, reviews);
    const h = await boot(p, { prefilter_closed: "act" }, { verifier: true }, reviews);
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    const call = await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [T42, T43] }));

    const context = contextOf(call);
    // The follow-up only mentions #42: it stays
    expect(context.openTasks.map((t) => t.id)).toEqual(["t-43"]);
    expect(context.closed?.tasks).toEqual([
      { id: "B-7", why: "a done id of the tasks file" },
      { id: "t-42", why: "its own PR #42 (branch agent/worker-a/t-42) merged" },
    ]);
    expect(context.closed?.mergedPrs).toEqual([{ pr: 42, branch: "agent/worker-a/t-42" }]);
    expect(promptOf(call)).toContain("closed lists finished work");

    await h.service.cycle();
    const proposals = h.service.proposals();
    expect(proposals.find((x) => x.task === "t-42")).toMatchObject({
      status: "rejected",
      refusal: "task t-42 is closed work: its own PR #42 (branch agent/worker-a/t-42) merged (planner.guards.prefilter_closed)",
    });
    expect(proposals.find((x) => x.task === "t-43")).toMatchObject({ status: "pending" });
    // The verifier is asked about the follow-up only
    const run = h.service.runs()[0];
    expect(run.verifierState).toBe("running");
    const verifier = await runVerifier(h);
    expect(promptOf(verifier)).toContain("The planner proposed 1 change(s)");

    const did = events(h, "guard_did", "planner_prefilter_closed");
    expect(did).toHaveLength(1);
    expect(did[0]).toMatchObject({ subject: run.id, data: { verdict: "skip", tasks: ["B-7", "t-42"], count: 2, triggers: 0 } });
    expect(events(h, "guard_would", "planner_prefilter_closed")).toEqual([]);
    expect(guardOf(h, "planner_prefilter_closed")).toMatchObject({ mode: "act", would: 0, did: 1 });
  });

  it("act: a task's own DONE line names its PR; once review.db records that PR merged the task is closed, a line that only mentions it isn't", async () => {
    const p = makePaths();
    const reviews = reviewsOf(p);
    writeFileSync(p.planFile, ["# Plan", "- [ ] t-50: Docs page", "- [ ] t-51: Cart page", "- [ ] t-52: Release notes"].join("\n"));
    tasks(p, "worker-a|Alice|feat-login|Login form");
    // #50 merged; its branch names no task. #51 is open
    merge(reviews, 50, "2026-03-02T11:30:00.000Z");
    const h = await boot(p, { prefilter_closed: "act" }, {}, reviews);
    await h.service.cycle();
    queue(
      p,
      "- DONE t-50 task by worker-a 11:58Z: docs page PR #50 at abcdef1",
      "- DONE t-51 task by worker-a 11:59Z: cart page PR #51 at abcdef2",
      "- PROGRESS t-52 by worker-a 11:59Z: waiting for PR #50 to land",
    );
    at(h, 10 * SEC);
    await h.service.cycle();
    at(h, 41 * SEC);
    await h.service.cycle();
    const call = await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [] }));
    const context = contextOf(call);
    expect(context.openTasks.map((t) => t.id)).toEqual(["t-51", "t-52"]);
    expect(context.closed?.tasks).toEqual([{ id: "t-50", why: "its own PR #50, which its DONE line names, merged" }]);
    expect(context.closed?.mergedPrs).toEqual([{ pr: 50, branch: null }]);
  });

  it("AT-28 observe: the context is unchanged and nothing is refused; one guard_would per run, one notice per set of closed tasks", async () => {
    const p = makePaths();
    const reviews = reviewsOf(p);
    closedWorkProject(p, reviews);
    const h = await boot(p, { prefilter_closed: "observe" }, {}, reviews);
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    const call = await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [T42] }));
    const context = contextOf(call);
    expect(context.openTasks.map((t) => t.id)).toEqual(["B-7", "t-42", "t-43"]);
    expect(context.closed).toBeUndefined();
    expect(promptOf(call)).not.toContain("closed lists finished work");
    await h.service.cycle();
    // As today: the add goes on (applied in act mode)
    expect(h.service.proposals()).toEqual([expect.objectContaining({ task: "t-42", status: "applied" })]);
    const first = h.service.runs()[0];

    // A second run with the same closed work: its own event, no second notice
    at(h, 12 * MIN);
    appendFileSync(p.planFile, "\nNotes: nothing new\n");
    await h.service.cycle();
    at(h, 12 * MIN + 31 * SEC);
    await h.service.cycle();
    await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [] }));
    await h.service.cycle();
    const second = h.service.runs()[0];
    expect(second.id).not.toBe(first.id);

    const would = events(h, "guard_would", "planner_prefilter_closed");
    expect(new Set(would.map((e) => e.subject))).toEqual(new Set([first.id, second.id]));
    for (const e of would) expect(e.data).toMatchObject({ verdict: "would_skip", tasks: ["B-7", "t-42"], count: 2 });
    expect(events(h, "guard_did", "planner_prefilter_closed")).toEqual([]);
    // The same closed work is one streak: one notice
    expect(notices(h).map((d) => [d.attention, d.evidence?.code, d.evidence?.facts.tasks])).toEqual([["notice", "would_skip", 2]]);
    expect(guardOf(h, "planner_prefilter_closed")).toMatchObject({ mode: "observe", would: 2, did: 0 });
  });
});

describe("G6 handled_messages: an owner request a task carried out is handled", () => {
  async function requestRun(guards: Record<string, unknown>) {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await boot(p, guards);
    await h.service.cycle();
    appendFileSync(p.inboxFile, "- OWNER 2026-03-02T11:59:00Z [m1]: Please add a search page\n");
    at(h, 10 * SEC);
    await h.service.cycle();
    at(h, 41 * SEC);
    await h.service.cycle();
    const call = await runPlannerAgent(h, (c) =>
      writeProposals(c, {
        proposals: [
          { op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "the owner asked", from_message: "m1" },
          { op: "add", task: "feat-cart", agent: "worker-b", text: "Cart", reason: "maybe", from_message: "m9" },
        ],
      }),
    );
    await h.service.cycle();
    // The task's DONE line arrives: the rules mark it done
    queue(p, "- DONE feat-search task by worker-b 12:05Z: search page done");
    at(h, 5 * MIN);
    await h.service.cycle();
    return { p, h, call };
  }

  /** A later planner run (a plan change triggers it), and its context. */
  async function laterRun(h: Harness, p: Paths) {
    at(h, 12 * MIN);
    appendFileSync(p.planFile, "\n- [ ] feat-x: Something else\n");
    await h.service.cycle();
    at(h, 12 * MIN + 31 * SEC);
    await h.service.cycle();
    return runPlannerAgent(h, (c) => writeProposals(c, { proposals: [] }));
  }

  it("AT-25 act: the prompt documents from_message; the message is handled once its task is done; the owner reopens and marks it", async () => {
    const { p, h, call } = await requestRun({ handled_messages: "act" });
    expect(promptOf(call)).toContain('"from_message": "<owner message id, when the proposal carries out one>"');
    expect(contextOf(call).ownerMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(h.service.proposals().map((x) => [x.task, x.status, x.refusal])).toEqual(
      expect.arrayContaining([
        ["feat-search", "applied", null],
        ["feat-cart", "rejected", "from_message m9 is not an owner message of this run's context"],
      ]),
    );
    expect(tasksText(h)).toContain("#done worker-b|Bob|feat-search|Search page");
    expect(h.service.overview().handledMessages).toEqual([{ id: "m1", task: "feat-search", at: new Date(h.clock.now()).toISOString(), by: "lair" }]);
    expect(events(h, "guard_did", "planner_handled_messages")).toEqual([
      expect.objectContaining({ subject: "m1", task: "feat-search", data: expect.objectContaining({ verdict: "skip", message: "m1" }) }),
    ]);

    // Absent from the next context, with no owner_message trigger
    const later = await laterRun(h, p);
    expect(contextOf(later).ownerMessages).toEqual([]);
    expect(h.service.runs()[0].triggers.map((t) => t.kind)).not.toContain("owner_message");
    await h.service.cycle();

    // The owner reopens it: back in, as a trigger; a second reopen changes nothing
    const reopened = await post(h, "/api/planner/messages/m1/reopen?project=demo");
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().data).toEqual({ id: "m1", handled: null });
    expect(h.service.overview().handledMessages).toEqual([]);
    const triggers = h.service.overview().triggers;
    expect(triggers.filter((t) => t.kind === "owner_message")).toHaveLength(1);
    expect((await post(h, "/api/planner/messages/m1/reopen?project=demo")).json().data).toEqual({ id: "m1", handled: null });
    expect(h.service.overview().triggers).toEqual(triggers);

    // The owner marks it handled (idempotent): its waiting trigger goes
    const marked = await post(h, "/api/planner/messages/m1/handled?project=demo");
    expect(marked.statusCode).toBe(200);
    expect(marked.json().data).toMatchObject({ id: "m1", handled: { id: "m1", task: null, by: "owner" } });
    expect((await post(h, "/api/planner/messages/m1/handled?project=demo")).json().data).toEqual(marked.json().data);
    expect(h.service.overview().triggers.filter((t) => t.kind === "owner_message")).toEqual([]);

    // An id that isn't an owner message; a malformed id
    expect((await post(h, "/api/planner/messages/m404/handled?project=demo")).statusCode).toBe(404);
    expect((await post(h, "/api/planner/messages/m404/reopen?project=demo")).statusCode).toBe(404);
    expect((await post(h, "/api/planner/messages/a%5Db/handled?project=demo")).statusCode).toBe(400);

    // Only the owner, from the dashboard: no session, a made-up one, or a cross-site page with the owner's session
    const strangers: Record<string, string>[] = [
      {},
      DASHBOARD,
      { ...DASHBOARD, [OWNER_SESSION_HEADER]: "a-made-up-session-value-0123456789" },
      { ...h.owner, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    ];
    for (const headers of strangers) {
      for (const action of ["handled", "reopen"]) {
        const res = await post(h, `/api/planner/messages/m1/${action}?project=demo`, headers);
        expect(res.statusCode, `${action} ${JSON.stringify(Object.keys(headers))}`).toBe(403);
      }
    }
    expect(h.service.overview().handledMessages.map((m) => m.by)).toEqual(["owner"]);

    // A message id is any text: one named like an object's own property is an entry like any other
    appendFileSync(p.inboxFile, "- OWNER 2026-03-02T12:30:00Z [constructor]: An odd id\n");
    await h.service.cycle();
    expect((await post(h, "/api/planner/messages/constructor/reopen?project=demo")).json().data).toEqual({ id: "constructor", handled: null });
    expect((await post(h, "/api/planner/messages/constructor/handled?project=demo")).json().data).toMatchObject({ handled: { id: "constructor", by: "owner" } });
    expect(h.service.overview().handledMessages.map((m) => m.id)).toEqual(["constructor", "m1"]);
    expect((await post(h, "/api/planner/messages/constructor/reopen?project=demo")).json().data).toEqual({ id: "constructor", handled: null });
    expect(h.service.overview().handledMessages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("AT-28 observe: the message is recorded as would-be handled and stays in the context; one guard_would and one notice", async () => {
    const { p, h } = await requestRun({ handled_messages: "observe" });
    expect(h.service.overview().handledMessages).toEqual([]);
    const would = events(h, "guard_would", "planner_handled_messages");
    expect(would).toEqual([expect.objectContaining({ subject: "m1", task: "feat-search", data: expect.objectContaining({ verdict: "would_skip" }) })]);
    expect(events(h, "guard_did", "planner_handled_messages")).toEqual([]);
    expect(notices(h).map((d) => [d.attention, d.evidence?.code, d.evidence?.facts.message])).toEqual([["notice", "would_skip", "m1"]]);
    expect(guardOf(h, "planner_handled_messages")).toMatchObject({ mode: "observe", would: 1, did: 0 });
    const later = await laterRun(h, p);
    expect(contextOf(later).ownerMessages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("the routes answer 409 while the guard is off", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    appendFileSync(p.inboxFile, "- OWNER 2026-03-02T11:59:00Z [m1]: Please add a search page\n");
    const h = await boot(p, undefined, { spend: false });
    await h.service.cycle();
    const res = await post(h, "/api/planner/messages/m1/handled?project=demo");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("planner.guards.handled_messages is off");
  });
});

describe("G6 skip_unchanged: a run on the same inputs as one that gave nothing applicable is skipped", () => {
  /** R1: a run whose only proposal is refused (an agent that isn't allowlisted). */
  async function firstRun(mode: "act" | "observe") {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const guards = { skip_unchanged: { mode, max_skip_hours: 1 } };
    const h = await boot(p, guards);
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [{ op: "add", task: "feat-x", agent: "nobody", text: "X", reason: "r" }] }));
    await h.service.cycle();
    const r1 = h.service.runs()[0];
    expect(r1).toMatchObject({ state: "done", rejected: 1, applied: 0, pending: 0 });
    return { p, h, guards, r1 };
  }

  /** New queue lines and a trigger (worker-b reports DONE with no line left), with every input of the hash the same. */
  async function sameInputsTrigger(h: Harness, p: Paths, atMs: number, text: string): Promise<void> {
    queue(p, `- DONE side-job task by worker-b 12:20Z: ${text}`);
    at(h, atMs);
    await h.service.cycle();
    at(h, atMs + 31 * SEC);
    await h.service.cycle();
  }

  it("AT-26 act: same inputs are skipped (also after a restart); a new owner message runs; after max_skip_hours a run starts anyway", async () => {
    const { p, h, guards, r1 } = await firstRun("act");
    const spawned = h.spawner.calls.length;
    await sameInputsTrigger(h, p, 20 * MIN, "tidied up");
    await h.agentsService.tick();
    expect(h.service.runs()).toHaveLength(1);
    expect(h.spawner.calls).toHaveLength(spawned);
    expect(h.service.overview().triggers).toEqual([]);
    const skipped = h.bus.filter((e) => e.type === "planner.skipped");
    expect(skipped).toEqual([{ type: "planner.skipped", data: expect.objectContaining({ earlierRunId: r1.id, triggers: ["done_no_next"] }) }]);
    expect(String(skipped[0].data.hash)).toMatch(/^[0-9a-f]{12}$/);

    // A restart doesn't undo it
    await h.planner.stop();
    await h.agents.stop();
    const h2 = await setup(p, blockOf(p, guards, {}), { clock: h.clock, dbs: h.dbs, extra: extraOf(p, {}) });
    await h2.service.cycle();
    await sameInputsTrigger(h2, p, 30 * MIN, "tidied up again");
    await h2.agentsService.tick();
    expect(h2.service.runs()).toHaveLength(1);
    expect(h2.bus.filter((e) => e.type === "planner.skipped")).toHaveLength(1);
    expect(events(h2, "guard_did", "planner_skip_unchanged").map((e) => [e.subject, e.data.verdict])).toEqual([
      [r1.id, "skip"],
      [r1.id, "skip"],
    ]);
    expect(guardOf(h2, "planner_skip_unchanged")).toMatchObject({ mode: "act", did: 2, would: 0 });

    // max_skip_hours (1) after the last run: a run starts even with the same inputs
    await sameInputsTrigger(h2, p, 62 * MIN, "and again");
    expect(h2.service.runs()).toHaveLength(2);
    await runPlannerAgent(h2, (c) => writeProposals(c, { proposals: [] }));
    await h2.service.cycle();
    expect(h2.service.runs()[0]).toMatchObject({ state: "done", proposals: 0 });

    // A new owner message is a new input: the next run starts
    appendFileSync(p.inboxFile, "- OWNER 2026-03-02T13:20:00Z [m2]: Add a cart page\n");
    at(h2, 80 * MIN);
    await h2.service.cycle();
    at(h2, 80 * MIN + 31 * SEC);
    await h2.service.cycle();
    expect(h2.service.runs()).toHaveLength(3);
    expect(h2.service.runs()[0].triggers.map((t) => t.kind)).toEqual(["owner_message"]);
  });

  it("AT-28 observe: the run starts as today; one guard_would naming the earlier run, and one notice", async () => {
    const { p, h, r1 } = await firstRun("observe");
    await sameInputsTrigger(h, p, 20 * MIN, "tidied up");
    expect(h.service.runs()).toHaveLength(2);
    expect(h.bus.filter((e) => e.type === "planner.skipped")).toEqual([]);
    const would = events(h, "guard_would", "planner_skip_unchanged");
    expect(would).toEqual([expect.objectContaining({ subject: r1.id, data: expect.objectContaining({ verdict: "would_skip", earlier_run: r1.id, run: h.service.runs()[0].id }) })]);
    expect(events(h, "guard_did", "planner_skip_unchanged")).toEqual([]);
    expect(notices(h).map((d) => d.evidence?.code)).toEqual(["would_skip"]);
    expect(guardOf(h, "planner_skip_unchanged")).toMatchObject({ mode: "observe", would: 1, did: 0 });
  });
});

describe("G6 recheck_on_change (D7): a tasks file changed during a run", () => {
  async function changedDuringRun(mode: "act" | "observe") {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form", "worker-a|Alice|feat-old|Old work");
    const h = await boot(p, { recheck_on_change: mode }, { verifier: true });
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    const before = tasksText(h);
    const changed = "# agent|name|task|description\nworker-a|Alice|feat-login|Login form, with the reset link\n#done worker-a|Alice|feat-old|Old work\n";
    await runPlannerAgent(h, (c) => {
      // While R runs: a DONE line for one proposal's task, and an outside edit to another line
      writeFileSync(h.tasksFile, changed);
      writeProposals(c, {
        proposals: [
          { op: "reword", task: "feat-login", text: "Login form with remember-me", reason: "the plan says so" },
          { op: "reword", task: "feat-old", text: "Old work, part two", reason: "more to do" },
          { op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready in the plan" },
        ],
      });
    });
    const r = h.service.runs()[0];
    await h.service.cycle();
    return { p, h, r, before, changed };
  }

  it("AT-30 act: the file keeps the edit (recorded with its diff), one notice names the run; the proposal whose task is done is refused, the others go to the verifier", async () => {
    const { h, r, changed } = await changedDuringRun("act");
    expect(tasksText(h)).toBe(changed);
    expect(h.service.history()[0]).toMatchObject({
      source: "external",
      op: "edit",
      runId: r.id,
      diff: expect.arrayContaining(["+2 worker-a|Alice|feat-login|Login form, with the reset link", "+3 #done worker-a|Alice|feat-old|Old work"]),
    });
    const [notice, ...more] = notices(h);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ attention: "notice", class: "planner.guard_notice", evidence: { code: "tasks_file_kept", facts: { run: r.id } } });
    expect(notice.title).toContain(r.id.slice(0, 8));
    // No tamper decision: nothing was put back
    expect(h.inbox.list({ project: "demo", status: "open" }).filter((d) => d.key.startsWith("tamper:"))).toEqual([]);
    expect(h.service.proposals().map((x) => [x.task, x.status, x.refusal])).toEqual(
      expect.arrayContaining([
        ["feat-login", "pending", null],
        ["feat-old", "rejected", "task feat-old is done (line 3): it has no open line to reword"],
        ["feat-search", "pending", null],
      ]),
    );
    expect(runOf(h, r.id)?.tampered).toBe(true);
    const verifier = await runVerifier(h);
    expect(promptOf(verifier)).toContain("The planner proposed 2 change(s)");
    await h.service.cycle();
    expect(h.service.runs()[0]).toMatchObject({ id: r.id, state: "done", pending: 2, rejected: 1 });
    expect(h.service.runs()[0].detail).toContain("kept, and each proposal checked against it");
    expect(runOf(h, r.id)?.tampered).toBe(true);
    expect(events(h, "guard_did", "planner_recheck_on_change")).toEqual([
      expect.objectContaining({ subject: r.id, data: expect.objectContaining({ verdict: "apply", valid: 2, refused: 1 }) }),
    ]);
    expect(guardOf(h, "planner_recheck_on_change")).toMatchObject({ mode: "act", did: 1, would: 0 });
  });

  it("AT-30/AT-28 observe: the file is put back and all 3 are refused as today, with would_apply: 2", async () => {
    const { h, r, before } = await changedDuringRun("observe");
    expect(tasksText(h)).toBe(before);
    expect(h.service.proposals().every((x) => x.status === "rejected" && x.refusal?.startsWith("the tasks file changed while this planner run was active"))).toBe(true);
    expect(h.service.proposals()).toHaveLength(3);
    expect(h.service.runs()[0]).toMatchObject({ id: r.id, state: "failed", verifierState: "skipped" });
    expect(h.inbox.list({ project: "demo", status: "open" }).map((d) => d.key)).toContain(`tamper:${r.id}`);
    expect(events(h, "guard_would", "planner_recheck_on_change")).toEqual([
      expect.objectContaining({ subject: r.id, data: expect.objectContaining({ verdict: "would_apply", would_apply: 2, refused: 1 }) }),
    ]);
    expect(events(h, "guard_did", "planner_recheck_on_change")).toEqual([]);
    expect(notices(h).map((d) => [d.evidence?.code, d.evidence?.facts.would_apply])).toEqual([["would_apply", 2]]);
    expect(guardOf(h, "planner_recheck_on_change")).toMatchObject({ mode: "observe", would: 1, did: 0 });
  });
});

describe("AT-27: G6 off is today's behaviour", () => {
  it("the context keeps closed work, the prompt has no from_message, the field is refused, an add of closed work goes on, the same inputs run again", async () => {
    const p = makePaths();
    const reviews = reviewsOf(p);
    closedWorkProject(p, reviews);
    const h = await boot(p, undefined, { spend: false }, reviews);
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    const call = await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [T42, { op: "add", task: "feat-cart", agent: "worker-b", text: "Cart", reason: "r", from_message: "m1" }] }),
    );
    const context = contextOf(call);
    expect(context.openTasks.map((t) => t.id)).toEqual(["B-7", "t-42", "t-43"]);
    expect(context.closed).toBeUndefined();
    expect(promptOf(call)).not.toContain("from_message");
    expect(promptOf(call)).not.toContain("closed lists finished work");
    await h.service.cycle();
    expect(h.service.proposals().map((x) => [x.task, x.status, x.refusal])).toEqual(
      expect.arrayContaining([
        ["t-42", "applied", null],
        ["feat-cart", "rejected", "not a proposal: (item): Unrecognized key(s) in object: 'from_message'"],
      ]),
    );
    // The same open work again (a plan edit that changes no task): a second run starts (nothing is skipped)
    appendFileSync(p.planFile, "\nNotes: nothing new\n");
    at(h, 20 * MIN);
    await h.service.cycle();
    at(h, 20 * MIN + 31 * SEC);
    await h.service.cycle();
    expect(h.service.runs()).toHaveLength(2);
    expect(h.bus.filter((e) => e.type === "planner.skipped")).toEqual([]);
    expect(notices(h)).toEqual([]);
    expect(h.agentsStore.listEvents("demo", { kinds: ["guard_would", "guard_did"], limit: 10 })).toEqual([]);
    // (A tasks file changed during a run with recheck_on_change off: planner.test.ts, "the planner agent can't edit the tasks file")
    expect(readFileSync(h.tasksFile, "utf-8")).toContain("worker-b|Bob|t-42|Search page (plan: t-42)");
  });
});
