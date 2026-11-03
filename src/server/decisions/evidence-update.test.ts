/**
 * The update path of `cause_cleared` and `linked_issue` (docs/design/decision-policies.md §4): only the
 * module that raised an open decision, only those two facts, audited, idempotent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import type { RaiseDecisionInput } from "./types.js";
import { DecisionError } from "./validate.js";

const stores: DecisionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

let now = Date.parse("2026-03-02T12:00:00Z");
function setup() {
  now = Date.parse("2026-03-02T12:00:00Z");
  const store = new DecisionStore(":memory:");
  stores.push(store);
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: { now: () => now } });
}

/** An exit0_no_report hold as fill raises it (fill.ts raiseHold), with the v3 facts */
const gaveUp = (over: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput =>
  input({
    title: "agent-a is paused on feat-login: its last 3 run(s) ended without reporting it done",
    options: [
      { id: "start_again", label: "Start it again", consequences: "Starts.", effect: "reversible" },
      { id: "keep_held", label: "Keep it paused", consequences: "Waits.", effect: "reversible" },
    ],
    recommended: { optionId: "keep_held", reasoning: "r" },
    source: { module: "agents", ref: "fill:feat-login" },
    key: "fill:feat-login:r1",
    class: "agents.gave_up",
    evidence: {
      code: "exit0_no_report",
      facts: { agent: "agent-a", task: "feat-login", attempt_count: 1, last_exit: 0, task_state: "open", pr: 12, next_move: "other", gate_at_head: "queued" },
      cause_cleared: false,
      linked_issue: null,
    },
    ...over,
  });

const input = (over: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput => ({
  project: "demo",
  kind: "escalation",
  title: "Every profile is failing",
  context: "Rate limited.",
  options: [
    { id: "wait", label: "Wait", consequences: "Waits.", effect: "reversible" },
    { id: "stop", label: "Stop", consequences: "Stops.", effect: "frees_task" },
  ],
  recommended: { optionId: "wait", reasoning: "It clears." },
  source: { module: "agents", ref: "chain:1" },
  key: "k1",
  class: "agents.provider_limit",
  evidence: { code: "provider_rate_limit", facts: { agent: "a" }, cause_cleared: false, linked_issue: null },
  ...over,
});

const rejects = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(DecisionError);
  expect((e as DecisionError).statusCode).toBe(status);
};

describe("updateEvidence", () => {
  it("sets cause_cleared and linked_issue, keeps the facts and the rest of the decision, and audits each change", async () => {
    const inbox = setup();
    const { decision } = await inbox.raise(input());
    const a = await inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true });
    expect(a.evidence).toEqual({ code: "provider_rate_limit", facts: { agent: "a" }, cause_cleared: true, linked_issue: null });
    const b = await inbox.updateEvidence(decision.id, { module: "agents", linked_issue: 41 });
    expect(b.evidence).toMatchObject({ cause_cleared: true, linked_issue: 41 });
    const c = await inbox.updateEvidence(decision.id, { module: "agents", linked_issue: null });
    expect(c.evidence?.linked_issue).toBeNull();
    expect({ ...c, evidence: undefined, evidenceRev: undefined, audit: undefined }).toEqual({ ...decision, evidence: undefined, evidenceRev: undefined, audit: undefined });
    // Each real change is one revision; none of them is a re-read of the live facts
    expect(decision.evidenceRev).toBe(0);
    expect(c.evidenceRev).toBe(3);
    expect(c.factsAt).toBeUndefined();
    const audit = inbox.get(decision.id)!.audit!.filter((x) => x.action === "evidence_updated");
    expect(audit.map((x) => x.detail)).toEqual([
      "agents updated the evidence: cause_cleared false -> true",
      "agents updated the evidence: linked_issue none -> 41",
      "agents updated the evidence: linked_issue 41 -> none",
    ]);
    expect(audit.every((x) => x.actor === "agents")).toBe(true);
  });

  it("the same value again changes nothing and writes no audit entry", async () => {
    const inbox = setup();
    const { decision } = await inbox.raise(input());
    await inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true });
    await inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true });
    await inbox.updateEvidence(decision.id, { module: "agents", linked_issue: null });
    expect(inbox.get(decision.id)!.audit!.filter((x) => x.action === "evidence_updated")).toHaveLength(1);
  });

  it("only the raising module, only while open, only with evidence, and only valid values", async () => {
    const inbox = setup();
    const { decision } = await inbox.raise(input());
    await rejects(inbox.updateEvidence(decision.id, { module: "triage", cause_cleared: true }), 403);
    await rejects(inbox.updateEvidence("00000000-0000-4000-8000-000000000000", { module: "agents", cause_cleared: true }), 404);
    await rejects(inbox.updateEvidence(decision.id, { module: "agents" }), 400);
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", linked_issue: 0 }), 400);
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", linked_issue: 1.5 }), 400);
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: "yes" as unknown as boolean }), 400);
    expect(inbox.get(decision.id)!.evidence?.cause_cleared).toBe(false);
    // no evidence
    const plain = (await inbox.raise({ ...input({ key: "plain" }), class: undefined, evidence: undefined, options: input().options.map(({ effect: _e, ...o }) => o) })).decision;
    await rejects(inbox.updateEvidence(plain.id, { module: "agents", cause_cleared: true }), 409);
    // closed
    await inbox.answer(decision.id, { optionId: "wait" });
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true }), 409);
    expect(inbox.get(decision.id)!.evidence?.cause_cleared).toBe(false);
  });

  it("liveFactsOnlyListed: a listed fact moves, an unlisted one or another module is refused, a re-read stamps facts_at", async () => {
    const inbox = setup();
    const { decision } = await inbox.raise(gaveUp());
    expect(decision).toMatchObject({ evidenceRev: 0 });
    expect(decision.factsAt).toBeUndefined();

    // A listed fact that changed: applied, audited, one revision, factsAt set; the other facts stay
    now += 60_000;
    const a = await inbox.updateEvidence(decision.id, { module: "agents", facts: { gate_at_head: "pass", next_move: "other", task_state: "open" } });
    expect(a.evidence?.facts).toEqual({ ...gaveUp().evidence!.facts, gate_at_head: "pass" });
    expect(a).toMatchObject({ evidenceRev: 1, factsAt: new Date(now).toISOString() });
    const audit = () => inbox.get(decision.id)!.audit!.filter((x) => x.action === "evidence_updated");
    expect(audit().map((x) => x.detail)).toEqual(["agents updated the evidence: gate_at_head queued -> pass"]);

    // A fact not in agents.gave_up's live list (the PR is set at the raise): the whole update is refused
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", facts: { pr: 13 } }), 400);
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", facts: { task_state: "closed", agent: "agent-b" } }), 400);
    // A value that is not a fact value
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", facts: { task_state: { a: 1 } as unknown as string } }), 400);
    expect(inbox.get(decision.id)).toMatchObject({ evidenceRev: 1, evidence: { facts: { pr: 12, task_state: "open", agent: "agent-a" } } });

    // The same values again: factsAt moves, nothing else, no audit entry
    now += 60_000;
    const b = await inbox.updateEvidence(decision.id, { module: "agents", facts: { gate_at_head: "pass", task_state: "open" } });
    expect(b).toMatchObject({ evidenceRev: 1, factsAt: new Date(now).toISOString() });
    expect(b.evidence).toEqual(a.evidence);
    expect(audit()).toHaveLength(1);

    // Another module: refused, nothing moves (factsAt neither)
    now += 60_000;
    await rejects(inbox.updateEvidence(decision.id, { module: "triage", facts: { task_state: "closed" } }), 403);
    expect(inbox.get(decision.id)).toMatchObject({ evidenceRev: 1, factsAt: b.factsAt, evidence: { facts: { task_state: "open" } } });
  });

  it("a class without a live list takes no fact, and a closed decision takes no re-read", async () => {
    const inbox = setup();
    const { decision } = await inbox.raise(input());
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", facts: { agent: "b" } }), 400);
    const held = (await inbox.raise(gaveUp())).decision;
    await inbox.answer(held.id, { optionId: "keep_held" });
    await rejects(inbox.updateEvidence(held.id, { module: "agents", facts: { task_state: "closed" } }), 409);
    expect(inbox.get(held.id)).toMatchObject({ evidenceRev: 0, evidence: { facts: { task_state: "open" } } });
    expect(inbox.get(held.id)!.factsAt).toBeUndefined();
  });

  it("the raise's 30-fact cap holds after an update: a live fact that would be the 31st is refused, and nothing moves", async () => {
    const inbox = setup();
    // 30 facts at the raise (the most the raise takes), without review_at_head
    const facts: Record<string, string | number | null> = { agent: "agent-a", task: "feat-login", task_state: "open", pr: 12, next_move: "other" };
    for (let i = 0; Object.keys(facts).length < 30; i++) facts[`extra_${i}`] = i;
    const { decision } = await inbox.raise(gaveUp({ evidence: { code: "exit0_no_report", facts, cause_cleared: false, linked_issue: null } }));
    expect(Object.keys(decision.evidence!.facts)).toHaveLength(30);
    // A fact it already has still moves
    await inbox.updateEvidence(decision.id, { module: "agents", facts: { next_move: "agent" } });
    expect(inbox.get(decision.id)).toMatchObject({ evidenceRev: 1, evidence: { facts: { next_move: "agent" } } });
    // A new live fact would be the 31st: refused, the whole update with it
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", facts: { task_state: "closed", review_at_head: "approve" } }), 400);
    expect(inbox.get(decision.id)).toMatchObject({ evidenceRev: 1, evidence: { facts: { task_state: "open" } } });
    expect(Object.keys(inbox.get(decision.id)!.evidence!.facts)).toHaveLength(30);
  });

  it("not for a decision raised over HTTP, whatever module name the caller gave", async () => {
    const inbox = setup();
    const { decision } = await inbox.raiseFromHttp(input({ key: "http" }));
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true }), 403);
  });
});
