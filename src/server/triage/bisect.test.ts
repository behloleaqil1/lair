/**
 * Bisect and revert. The state machine on its own, then the whole path
 * through TriageService: a red default branch opens an incident, the merges
 * since the last green commit are bisected with only the failing tests, the
 * culprit is proven (green before, red after, the same cause twice), and a
 * revert is opened or proposed per policy, never automatically for a
 * protected merge or one that is not proven. The test plays the gate runner:
 * it answers each probe the fake command runner received.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DecisionInbox, DecisionStore, MemorySecretStore } from "../decisions/index.js";
import { applyProbe, maxProbes, nextStep, startBisect } from "./bisect.js";
import { actingTriage, fixture, gate, harness, junitPassing, sha, step, type Harness } from "./testing/harness.js";

describe("bisect state machine", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => sha(x));

  it("halves the range, then confirms the culprit before calling it proven", () => {
    let state = startBisect([a, b, c, d], d);
    let next = nextStep(state);
    expect(next).toEqual({ type: "probe", sha: b, confirm: false });
    state = { ...state, probes: [...state.probes, { sha: b, recheckId: "r1", outcome: "pending" }] };
    state = applyProbe(state, state.probes[1], "pass", "passed");
    next = nextStep(state);
    expect(next).toEqual({ type: "probe", sha: c, confirm: false });
    state = { ...state, probes: [...state.probes, { sha: c, recheckId: "r2", outcome: "pending" }] };
    state = applyProbe(state, state.probes[2], "fail", "same cause");
    expect(nextStep(state)).toEqual({ type: "probe", sha: c, confirm: true });
    state = { ...state, probes: [...state.probes, { sha: c, recheckId: "r3", confirm: true, outcome: "pending" }] };
    state = applyProbe(state, state.probes[3], "fail", "same cause");
    expect(nextStep(state)).toMatchObject({ type: "found", culprit: c, proven: true });
  });

  it("a single candidate is the red commit: it needs one confirmation", () => {
    const state = startBisect([d], d);
    expect(nextStep(state)).toEqual({ type: "probe", sha: d, confirm: true });
  });

  it("skips commits that can't be tested, and gives suspects when nothing is left", () => {
    let state = startBisect([a, b, c, d], d);
    state = { ...state, probes: [...state.probes, { sha: b, recheckId: "r1", outcome: "pending" }] };
    state = applyProbe(state, state.probes[1], "skip", "infra");
    expect(nextStep(state)).toEqual({ type: "probe", sha: a, confirm: false });
    state = { ...state, skipped: [0, 1, 2] };
    expect(nextStep(state)).toMatchObject({ type: "inconclusive", suspects: [a, b, c, d] });
  });

  it("a culprit that passes when run again is not proven", () => {
    let state = startBisect([d], d);
    state = { ...state, probes: [...state.probes, { sha: d, recheckId: "r1", confirm: true, outcome: "pending" }] };
    state = applyProbe(state, state.probes[1], "pass", "passed");
    expect(nextStep(state)).toMatchObject({ type: "inconclusive", suspects: [d] });
  });

  it("an empty range is inconclusive, and probes are bounded", () => {
    expect(startBisect([], d).status).toBe("inconclusive");
    expect(maxProbes(64)).toBe(18);
  });
});

// ============ THROUGH THE SERVICE ============

let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const c0 = sha("c0");
const merges = [1, 2, 3, 4, 5].map((i) => sha(`m${i}`));
const heads = [1, 2, 3, 4, 5].map((i) => sha(`f${i}`));
const report = `<testsuite name="com.example.shop.CartTest"><testcase classname="com.example.shop.CartTest" name="addsItem()">
<failure message="expected 2 items" type="java.lang.AssertionError">java.lang.AssertionError: expected 2 items
	at com.example.shop.CartTest.addsItem(CartTest.java:10)
</failure></testcase></testsuite>`;

function history(t: Harness, options: { body?: (i: number) => string } = {}): void {
  t.git.commitOnMain(c0);
  for (let i = 0; i < 4; i++) {
    t.git.commitOnMain(merges[i], {
      pr: heads[i],
      subject: `Merge pull request #${11 + i} from example/feat-${i + 1}`,
      body: options.body?.(i) ?? "",
    });
  }
}

/** The project's history: c0 green, four merges, the PRs' own gates, and main red at the last merge. */
async function redMain(t: Harness): Promise<string> {
  await t.ingest({ result: gate({ sha: c0, branch: "main", status: "passed" }) });
  for (let i = 0; i < 4; i++) {
    await t.ingest({
      result: gate({ sha: heads[i], branch: `feat/${i + 1}`, status: "passed" }),
      context: { agent: `worker-${"abcd"[i]}`, pr: 11 + i },
    });
  }
  const red = await t.ingest({ result: gate({ id: "main-red", sha: merges[3], branch: "main" }), reports: [{ content: report }] });
  expect(red.incident).not.toBeNull();
  return red.incident!.id;
}

function requestOf(argv: string[]): string {
  return argv.find((a) => a.startsWith("--request="))!.slice("--request=".length);
}

/**
 * Answer every probe the runner was asked for: commits from `firstBad` on
 * fail with the target test, earlier ones pass. `answer` overrides one.
 */
async function playRunner(t: Harness, firstBad: string, answer?: (sha: string, n: number) => "pass" | "fail" | "infra" | undefined) {
  const answered = new Set<string>();
  const order = [c0, ...merges];
  for (let n = 0; n < 30; n++) {
    const call = t.runner.callsTo("./bin/recheck").find((argv) => !answered.has(requestOf(argv)));
    if (!call) return;
    const id = requestOf(call);
    answered.add(id);
    const recheck = t.manager.getStore()!.getRecheck(id)!;
    const outcome =
      answer?.(recheck.sha, n) ?? (order.indexOf(recheck.sha) >= order.indexOf(firstBad) ? "fail" : "pass");
    // The runner's answer: the re-check's id as the result id, and the report showing the target test
    await t.ingest({
      result: gate({
        id,
        sha: recheck.sha,
        branch: "main",
        status: outcome === "pass" ? "passed" : "failed",
        steps: [step("test", outcome === "pass" ? "passed" : "failed")],
      }),
      reports: [
        {
          content:
            outcome === "fail"
              ? report
              : outcome === "infra"
                ? fixture("junit-context-failure.xml")
                : junitPassing([{ suite: "com.example.shop.CartTest", name: "addsItem()" }]),
        },
      ],
      context: { recheckId: id },
    });
  }
}

describe("a red default branch", () => {
  it("bisects the merges with only the failing tests, proves the culprit, reverts it (auto) and tells its author", async () => {
    h = harness(actingTriage({ bisect: { revert: "auto" } }));
    history(h);
    h.runner.when((argv) => argv[0] === "./bin/revert", () => ({ code: 0, stdout: "revert-pr-77\n", stderr: "" }));
    const incidentId = await redMain(h);
    expect(h.git.calls).toContain(`range ${c0}..${merges[3]}`);

    await playRunner(h, merges[2]);

    const incident = h.manager.getStore()!.getIncident(incidentId)!;
    expect(incident.bisect).toMatchObject({ status: "found", culprit: merges[2], proven: true, candidates: merges.slice(0, 4) });
    expect(incident.bisect.probes.map((p) => [p.sha, p.confirm ?? false, p.outcome])).toEqual([
      [merges[3], false, "fail"],
      [merges[1], false, "pass"],
      [merges[2], false, "fail"],
      [merges[2], true, "fail"],
    ]);
    // Each probe ran only the failing test class, at that commit
    const probes = h.runner.callsTo("./bin/recheck");
    expect(probes).toHaveLength(3);
    for (const argv of probes) expect(argv.slice(3)).toEqual(["--steps=test", "com.example.shop.CartTest"]);
    expect(probes.map((argv) => argv[1])).toEqual([`--sha=${merges[1]}`, `--sha=${merges[2]}`, `--sha=${merges[2]}`]);

    expect(h.runner.callsTo("./bin/revert")).toEqual([["./bin/revert", merges[2], `--incident=${incidentId}`]]);
    expect(incident.revert).toMatchObject({ status: "opened", ref: "revert-pr-77", protected: false });

    const notes = h.runner.callsTo("./bin/notify");
    expect(notes).toHaveLength(1);
    expect(notes[0][1]).toBe("worker-c");
    expect(notes[0][2]).toContain(`your change ${merges[2].slice(0, 8)} broke main`);
    expect(h.inbox()).toBe("");
  });

  it("never reverts a merge a human marked protected: it proposes through a decision instead", async () => {
    h = harness(actingTriage({ bisect: { revert: "auto" } }));
    history(h);
    h.service.protect(merges[2], "hotfix the owner wants kept");
    const incidentId = await redMain(h);
    await playRunner(h, merges[2]);

    const incident = h.manager.getStore()!.getIncident(incidentId)!;
    expect(incident.bisect).toMatchObject({ status: "found", culprit: merges[2], proven: true });
    expect(h.runner.callsTo("./bin/revert")).toEqual([]);
    expect(incident.revert).toMatchObject({ status: "protected", protected: true });
    expect(incident.revert.detail).toBe("never reverted automatically: a human marked it protected in Lair");
    const inbox = h.inbox();
    expect(inbox).toContain(`Revert ${merges[2].slice(0, 8)} to make main green again?`);
    expect(inbox).toContain("(recommended: Keep it and fix forward)");
    expect(inbox).toContain("Not reverted automatically: a human marked it protected in Lair.");
  });

  it("a protection trailer in the merge message is only a hint: the revert is proposed, never automatic", async () => {
    h = harness(actingTriage({ bisect: { revert: "auto" } }));
    history(h, { body: (i) => (i === 2 ? "Lair-Protected: yes" : "") });
    const incidentId = await redMain(h);
    await playRunner(h, merges[2]);
    expect(h.runner.callsTo("./bin/revert")).toEqual([]);
    const revert = h.manager.getStore()!.getIncident(incidentId)!.revert;
    // Not "protected": whoever merged it wrote the trailer, no human marked it
    expect(revert).toMatchObject({ status: "proposed", protected: false });
    expect(revert.detail).toContain("written by whoever merged it, not a human's mark");
    expect(h.inbox()).toContain("(recommended: Revert");
  });

  it("propose (the default): asks through a decision, and a human's answer opens the revert", async () => {
    h = harness(actingTriage());
    history(h);
    const incidentId = await redMain(h);
    await playRunner(h, merges[2]);
    expect(h.runner.callsTo("./bin/revert")).toEqual([]);
    expect(h.manager.getStore()!.getIncident(incidentId)!.revert.status).toBe("proposed");
    expect(h.inbox()).toContain(`(recommended: Revert ${merges[2].slice(0, 8)})`);

    const after = await h.service.requestRevert(incidentId, { actor: "owner session s1" });
    expect(h.runner.callsTo("./bin/revert")).toEqual([["./bin/revert", merges[2], `--incident=${incidentId}`]]);
    expect(after.revert).toMatchObject({ status: "opened", by: "owner session s1" });
    const revert = h.manager.getStore()!.actionsFor({ incidentId }).find((a) => a.kind === "revert");
    expect(revert).toMatchObject({ status: "done", actor: "owner session s1" });
    expect(revert?.detail).toContain("asked by owner session s1");
  });

  it("through the Decision Inbox: the revert question is a decision, and the owner's answer opens the revert", async () => {
    h = harness(actingTriage());
    const inbox = new DecisionInbox({ store: new DecisionStore(":memory:"), secrets: new MemorySecretStore() });
    h.manager.useDecisions(inbox);
    history(h);
    const incidentId = await redMain(h);
    await playRunner(h, merges[2]);
    await h.manager.idle();
    const [decision] = inbox.list().filter((d) => d.source.module === "triage");
    expect(decision).toMatchObject({
      project: "demo",
      kind: "other",
      title: `Revert ${merges[2].slice(0, 8)} to make main green again?`,
      source: { module: "triage", ref: `revert:${incidentId}` },
    });
    expect(decision.options.map((o) => o.id)).toEqual(["revert", "keep"]);
    expect(h.inbox()).toBe("");
    expect(h.manager.getStore()!.getIncident(incidentId)!.decisionRef).toBe(decision.id);

    await inbox.answer(decision.id, { optionId: "revert" });
    await h.manager.idle();
    expect(h.runner.callsTo("./bin/revert")).toEqual([["./bin/revert", merges[2], `--incident=${incidentId}`]]);
    expect(h.manager.getStore()!.getIncident(incidentId)!.revert.status).toBe("opened");
    await inbox.stop();
  });

  it("a culprit that passes on confirmation is not proven, and is never reverted", async () => {
    h = harness(actingTriage({ bisect: { revert: "auto" } }));
    history(h);
    const incidentId = await redMain(h);
    let atCulprit = 0;
    await playRunner(h, merges[2], (commit) => {
      if (commit !== merges[2]) return undefined;
      atCulprit++;
      return atCulprit === 1 ? "fail" : "pass";
    });
    const incident = h.manager.getStore()!.getIncident(incidentId)!;
    expect(incident.bisect).toMatchObject({ status: "inconclusive", proven: false, suspects: [merges[2]] });
    expect(incident.bisect.detail).toContain("not reproducible");
    expect(h.runner.callsTo("./bin/revert")).toEqual([]);
    expect(incident.revert.status).toBe("proposed");
    expect(h.inbox()).toContain("(recommended: Investigate)");

    // An unproven suspect is reverted only on an explicit decision
    await expect(h.service.requestRevert(incidentId)).rejects.toThrow("is not proven to have broken main");
    expect(h.runner.callsTo("./bin/revert")).toEqual([]);
    const after = await h.service.requestRevert(incidentId, { acknowledgeUnproven: true, actor: "owner session s1" });
    expect(after.revert.status).toBe("opened");
    expect(h.runner.callsTo("./bin/revert")).toEqual([["./bin/revert", merges[2], `--incident=${incidentId}`]]);
  });

  it("probes a commit again when infrastructure failed the probe", async () => {
    h = harness(actingTriage({ bisect: { revert: "auto" } }));
    history(h);
    const incidentId = await redMain(h);
    let first = true;
    await playRunner(h, merges[2], (commit) => {
      if (commit === merges[1] && first) {
        first = false;
        return "infra";
      }
      return undefined;
    });
    const incident = h.manager.getStore()!.getIncident(incidentId)!;
    expect(incident.bisect).toMatchObject({ status: "found", culprit: merges[2], proven: true });
    expect(incident.bisect.probes.filter((p) => p.sha === merges[1]).map((p) => [p.outcome, p.retried ?? false])).toEqual([
      ["skip", true],
      ["pass", false],
    ]);
  });

  it("a green default branch resolves the incident and cancels its pending probes", async () => {
    h = harness(actingTriage());
    history(h);
    h.git.commitOnMain(merges[4], { pr: heads[4] });
    const incidentId = await redMain(h);
    const pending = h.manager.getStore()!.rechecksFor({ incidentId });
    expect(pending.map((r) => r.status)).toEqual(["requested"]);

    await h.ingest({ result: gate({ sha: merges[4], branch: "main", status: "passed" }) });
    const incident = h.manager.getStore()!.getIncident(incidentId)!;
    expect(incident).toMatchObject({ status: "resolved" });
    expect(incident.bisect.status).toBe("cancelled");
    expect(h.manager.getStore()!.getRecheck(pending[0].id)!.status).toBe("cancelled");
  });

  it("without a green result there is nothing to bisect from", async () => {
    h = harness(actingTriage());
    history(h);
    const red = await h.ingest({ result: gate({ sha: merges[3], branch: "main" }), reports: [{ content: report }] });
    expect(red.incident?.bisect.status).toBe("no_baseline");
    expect(h.runner.callsTo("./bin/recheck")).toEqual([]);
  });
});
