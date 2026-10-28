/**
 * Verifier acceptance tests: the planner verifier checks each proposal against
 * reality before asking the owner. These tests verify the verifier's behavior
 * with pass, fail, and defer verdicts, auto-apply rules, and decision changes.
 *
 * Each test here must fail on the base commit (7e90e73) where the verifier
 * doesn't exist.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  at,
  cleanup,
  makePaths,
  MIN,
  plannerBlock,
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
import { parseTasksFile } from "../agents/fill.js";

afterEach(cleanup);

const open = (h: Harness) => h.inbox.list({ project: "demo", status: "open" }).filter((d) => d.source.module === "planner");
const taskIds = (h: Harness) => parseTasksFile(tasksText(h)).flatMap((e) => (e.kind === "task" ? [e.task] : []));
const runsOf = (h: Harness) => h.service.runs();

/** A planner block with verifier configured. */
function plannerWithVerifier(p: Paths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return plannerBlock(p, {
    ...over,
    verifier: {
      id: "verifier",
      prompt_file: "verifier.md",
      max_runs_per_day: 48,
      skip_ops: ["finish"],
    },
  });
}

/** Set up a test with verifier configured. */
async function setupWithVerifier(p: Paths, over: Record<string, unknown> = {}): Promise<Harness> {
  // Add verifier agent to project config
  const h = await setup(p, plannerWithVerifier(p, over), {
    extra: {
      dragons: {
        "worker-a": { id: "worker-a", name: "Alice", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
        "worker-b": { id: "worker-b", name: "Bob", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
        planner: { id: "planner", name: "Planner", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
        verifier: { id: "verifier", name: "Verifier", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
      },
    } as never,
  });
  // Create verifier prompt file
  writeFileSync(join(p.promptsDir, "verifier.md"), "You are the verifier. Check each proposal against the project's actual state.\n");
  return h;
}

/** Run the planner agent and let it complete. */
async function startPlannerRun(h: Harness, atMs: number): Promise<void> {
  at(h, atMs);
  await h.service.cycle();
}

/** Run the verifier agent: the agents tick spawns it, then it writes verdicts and exits. */
async function runVerifierAgent(h: Harness, write: (call: SpawnCall) => void, exitCode = 0): Promise<SpawnCall> {
  const before = h.spawner.calls.length;
  h.spawner.behaviour = (call) => {
    if (call.env.LAIR_AGENT === "verifier") write(call);
  };
  await h.agentsService.tick();
  const call = h.spawner.calls[before];
  if (!call) throw new Error("the verifier agent was not spawned");
  h.spawner.behaviour = undefined;
  h.clock.t += 2 * MIN;
  const { appendFileSync, utimesSync } = await import("fs");
  appendFileSync(call.logPath, "verified\n");
  const t = new Date(h.clock.now());
  utimesSync(call.logPath, t, t);
  h.spawner.exit(call.pid, exitCode);
  await h.agentsService.tick();
  return call;
}

/** Write verdicts file in the verifier run. */
function writeVerdicts(call: SpawnCall, verdicts: unknown): void {
  const promptFile = call.argv[call.argv.indexOf("--prompt") + 1];
  const match = /Write your verdicts as JSON to this file, and nothing else: (\S+)/.exec(readFileSync(promptFile, "utf-8"));
  if (!match) throw new Error("no verdicts path in the prompt");
  writeFileSync(match[1], typeof verdicts === "string" ? verdicts : JSON.stringify(verdicts));
}

// ============ ACCEPTANCE TESTS ============

describe("verifier acceptance tests", () => {
  it("1. verifier runs after planner proposals pass checks and before asking the owner", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    // Planner proposes an add
    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready in the plan" }] }),
    );
    await h.service.cycle();

    // Run should be in verifier state, not done
    const [run] = runsOf(h);
    expect(run.verifierState).toBe("running");
    expect(run.state).toBe("running");

    // Verifier agent should have been requested
    expect(h.spawner.calls.some((c) => c.env.LAIR_AGENT === "verifier")).toBe(true);
  });

  it("2. verifier pass verdict allows auto-apply when approval is 'never'", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    // Planner proposes an add (approval: never by default)
    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" }] }),
    );
    await h.service.cycle();

    // Run verifier with pass verdict
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, { verdicts: [{ proposal: 0, verdict: "pass", reason: "the plan shows feat-search ready" }] }),
    );
    await h.service.cycle();

    // Proposal should be applied without asking owner
    expect(taskIds(h)).toContain("feat-search");
    expect(open(h)).toHaveLength(0);
    const [run] = runsOf(h);
    expect(run.verifierState).toBe("done");
    expect(run.state).toBe("done");
  });

  it("3. verifier fail verdict rejects the proposal with the verifier's reason", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" }] }),
    );
    await h.service.cycle();

    // Verifier says fail
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, { verdicts: [{ proposal: 0, verdict: "fail", reason: "feat-search depends on feat-auth which is not done" }] }),
    );
    await h.service.cycle();

    // Proposal should be rejected
    const proposals = h.service.proposals();
    expect(proposals[0].status).toBe("rejected");
    expect(proposals[0].refusal).toContain("verifier: feat-search depends on feat-auth");
    expect(proposals[0].verifierVerdict).toBe("fail");
    expect(taskIds(h)).not.toContain("feat-search");
    expect(open(h)).toHaveLength(0);
  });

  it("4. verifier defer verdict makes proposal wait for owner even when approval is 'never'", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" }] }),
    );
    await h.service.cycle();

    // Verifier defers
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, { verdicts: [{ proposal: 0, verdict: "defer", reason: "unclear if dependencies are ready" }] }),
    );
    await h.service.cycle();

    // Proposal should wait for owner
    const proposals = h.service.proposals({ status: "pending" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].verifierVerdict).toBe("defer");
    expect(open(h)).toHaveLength(1);
    expect(taskIds(h)).not.toContain("feat-search");
  });

  it("5. decision shows verifier verdicts for each proposal", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    // Planner proposes two changes
    await runPlannerAgent(h, (c) =>
      writeProposals(c, {
        proposals: [
          { op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" },
          { op: "reword", task: "feat-login", text: "Login form with SSO", reason: "add SSO note" },
        ],
      }),
    );
    await h.service.cycle();

    // Verifier passes one, defers one
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, {
        verdicts: [
          { proposal: 0, verdict: "pass", reason: "ready in the plan" },
          { proposal: 1, verdict: "defer", reason: "need to check SSO requirements" },
        ],
      }),
    );
    await h.service.cycle();

    // Add was auto-applied (pass + approval never)
    expect(taskIds(h)).toContain("feat-search");

    // Reword waits (also approval never, but verdict defer)
    const [decision] = open(h);
    expect(decision).toBeDefined();
    expect(decision.context).toContain("reword feat-login");
    expect(decision.context).toContain("[verifier: defer");
  });

  it("6. skip_ops bypasses verification for specified ops", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    // Planner proposes a finish (in skip_ops by default)
    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "finish", task: "feat-login", reason: "merged" }] }),
    );
    await h.service.cycle();

    // Verifier should not run for finish-only proposals
    const [run] = runsOf(h);
    expect(run.verifierState).toBe("skipped");

    // Finish still waits for owner (approval: always by default for finish)
    expect(open(h)).toHaveLength(1);
    expect(h.spawner.calls.filter((c) => c.env.LAIR_AGENT === "verifier")).toHaveLength(0);
  });

  it("7. proposals without verifier verdict are treated as defer", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    // Planner proposes two changes
    await runPlannerAgent(h, (c) =>
      writeProposals(c, {
        proposals: [
          { op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" },
          { op: "add", task: "feat-cart", agent: "worker-b", text: "Cart page", reason: "ready too" },
        ],
      }),
    );
    await h.service.cycle();

    // Verifier only gives verdict for proposal 0
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, { verdicts: [{ proposal: 0, verdict: "pass", reason: "ready" }] }),
    );
    await h.service.cycle();

    // Proposal 0 (pass) should be auto-applied
    expect(taskIds(h)).toContain("feat-search");

    // Proposal 1 (no verdict = defer) should wait
    const pending = h.service.proposals({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].task).toBe("feat-cart");
    expect(pending[0].verifierVerdict).toBe("defer");
    expect(pending[0].verifierReason).toContain("no verdict");
  });

  it("8. malformed verdicts file fails verifier but proposals proceed as defer", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    await runPlannerAgent(h, (c) =>
      writeProposals(c, { proposals: [{ op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" }] }),
    );
    await h.service.cycle();

    // Verifier writes malformed JSON
    await runVerifierAgent(h, (c) => writeVerdicts(c, "{not json"));
    await h.service.cycle();

    // Verifier should fail
    const [run] = runsOf(h);
    expect(run.verifierState).toBe("failed");
    expect(run.detail).toContain("verdicts file is not JSON");

    // But the proposal should proceed as defer (wait for owner)
    expect(open(h)).toHaveLength(1);
    expect(taskIds(h)).not.toContain("feat-search");
  });

  it("9. run detail includes verifier verdict counts", async () => {
    const p = makePaths();
    tasks(p, "worker-a|Alice|feat-login|Login form");
    const h = await setupWithVerifier(p);
    await h.service.cycle();
    await startPlannerRun(h, 31 * SEC);

    await runPlannerAgent(h, (c) =>
      writeProposals(c, {
        proposals: [
          { op: "add", task: "feat-search", agent: "worker-b", text: "Search page", reason: "ready" },
          { op: "add", task: "feat-cart", agent: "worker-b", text: "Cart page", reason: "ready" },
          { op: "reword", task: "feat-login", text: "Login form v2", reason: "update" },
        ],
      }),
    );
    await h.service.cycle();

    // Verifier: pass, fail, defer
    await runVerifierAgent(h, (c) =>
      writeVerdicts(c, {
        verdicts: [
          { proposal: 0, verdict: "pass", reason: "ready" },
          { proposal: 1, verdict: "fail", reason: "depends on checkout" },
          { proposal: 2, verdict: "defer", reason: "unclear scope" },
        ],
      }),
    );
    await h.service.cycle();

    const [run] = runsOf(h);
    expect(run.state).toBe("done");
    expect(run.detail).toContain("verifier: 1 pass, 1 fail, 1 defer");
  });
});
