/**
 * AI spend's classes for the planner's runs (docs/design/ai-spend.md §4.2, AT-9) and its acceptance in the spend API:
 * the production planner and agents module (testing/harness.ts) with agents.spend on and the planner's record wired
 * as the server wires it (src/server/index.ts). Only the process spawner and the clock are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, writeFileSync } from "fs";
import { at, cleanup, makePaths, MIN, plannerBlock, projectConfig, runPlannerAgent, SEC, setup, tasks, writeProposals } from "./testing/harness.js";
import { NO_VERDICT_REASON } from "./service.js";
import { PlannerStore } from "./store.js";

afterEach(cleanup);

async function plannerWithSpend() {
  const p = makePaths();
  writeFileSync(p.planFile, ["# Plan", "- [ ] feat-search: Search page"].join("\n"));
  tasks(p, "worker-a|Alice|feat-login|Login form");
  const agents = projectConfig(p, {}).agents as Record<string, unknown>;
  const h = await setup(p, plannerBlock(p), { extra: { agents: { ...agents, spend: { enabled: true } } } as never });
  h.agents.useSpendFacts({
    planner: (project, run) => h.planner.spendRun(project, "planner", run),
    verifier: (project, run) => h.planner.spendRun(project, "verifier", run),
    plannerAcceptance: (project, from, to) => h.planner.spendAcceptance(project, from, to),
  });
  return { p, h };
}

describe("AI spend: the planner's runs", () => {
  it("a planner run is pending until the planner reads its output, then productive with proposals and idle without", async () => {
    const { p, h } = await plannerWithSpend();
    await h.service.cycle();
    at(h, 31 * SEC);
    await h.service.cycle();
    const add = { op: "add", task: "feat-search", agent: "worker-a", text: "Search page (plan: feat-search)", reason: "ready in the plan" };
    await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [add] }));
    const first = h.service.runs()[0];
    const rowOf = (runId: string | null) => h.agentsStore.getSpend(runId ?? "");
    // Ended, but the planner hasn't read its proposals yet
    expect(rowOf(first.agentRunId)).toMatchObject({ origin: "planner", class: "unclassified", reason: "pending" });
    await h.service.cycle();
    await h.agentsService.tick();
    expect(rowOf(first.agentRunId)).toMatchObject({ class: "productive", reason: "proposals" });

    // A plan change: the next run proposes nothing
    at(h, 4 * MIN);
    appendFileSync(p.planFile, "\n- [ ] feat-cart: Cart\n");
    await h.service.cycle();
    at(h, 41 * SEC + 600 * SEC);
    await h.service.cycle();
    expect(h.service.runs()).toHaveLength(2);
    await runPlannerAgent(h, (c) => writeProposals(c, { proposals: [] }));
    await h.service.cycle();
    await h.agentsService.tick();
    const second = h.service.runs()[0];
    expect(rowOf(second.agentRunId)).toMatchObject({ origin: "planner", class: "idle", reason: "no_proposals" });

    // The spend API's planner acceptance: two runs, one with its proposal applied
    const report = h.agentsService.spendReport("today", "origin");
    expect(report.planner).toMatchObject({ runs: 2, runsWithApplied: 1, proposals: { applied: 1, declined: 0, rejected: 0, pending: 0 }, wasteShare: 0.5, costPerApplied: null });
    expect(report.groups.find((g) => g.key === "planner")).toMatchObject({ productive: { runs: 1 }, idle: { runs: 1 } });
  });

  it("a verifier run is productive once it gave a verdict; the stand-in for a missing one is no verdict", async () => {
    const { h } = await plannerWithSpend();
    const store = new PlannerStore(h.dbs.planner);
    const base = {
      project: "demo",
      state: "done" as const,
      agent: "planner",
      task: "planner-x",
      agentRunId: null,
      chainId: null,
      dir: h.work,
      triggers: [],
      requestedAt: h.clock.now(),
      endedAt: null,
      detail: "",
      tampered: false,
      decisionId: null,
      verifierTask: "verifier-x",
    };
    const proposal = (runId: string) =>
      store.insertProposal({
        project: "demo",
        runId,
        index: 0,
        op: "add",
        task: "feat-x",
        agent: "worker-a",
        text: "X",
        reason: "r",
        status: "pending",
        refusal: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: h.clock.now(),
        verifierVerdict: null,
        verifierReason: null,
        verifierEvidence: null,
      });
    store.insertRun({ ...base, id: "p-verdict", verifierState: "done", verifierRunId: "v-1", verifierChainId: "vc-1" });
    store.setVerifierVerdict(proposal("p-verdict").id, "approve", "the plan lists it", null);
    store.insertRun({ ...base, id: "p-missing", verifierState: "done", verifierRunId: "v-2", verifierChainId: "vc-2" });
    store.setVerifierVerdict(proposal("p-missing").id, "unsure", NO_VERDICT_REASON, null);
    store.insertRun({ ...base, id: "p-running", verifierState: "running", verifierRunId: "v-3", verifierChainId: "vc-3" });
    store.close();
    const ref = (id: string, chainId: string) => ({ id, chainId, requestedAt: h.clock.now() });
    // By its chain: the run the planner recorded may be the chain's first, and a restart's run counts the same
    expect(h.planner.spendRun("demo", "verifier", ref("v-1-restarted", "vc-1"))).toBe("productive");
    expect(h.planner.spendRun("demo", "verifier", ref("v-2", "vc-2"))).toBe("idle");
    expect(h.planner.spendRun("demo", "verifier", ref("v-3", "vc-3"))).toBe("pending");
    expect(h.planner.spendRun("demo", "verifier", ref("v-9", "vc-9"))).toBeNull();
  });
});
