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

function setup() {
  const store = new DecisionStore(":memory:");
  stores.push(store);
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: { now: () => Date.parse("2026-03-02T12:00:00Z") } });
}

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
    expect({ ...c, evidence: undefined, audit: undefined }).toEqual({ ...decision, evidence: undefined, audit: undefined });
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

  it("not for a decision raised over HTTP, whatever module name the caller gave", async () => {
    const inbox = setup();
    const { decision } = await inbox.raiseFromHttp(input({ key: "http" }));
    await rejects(inbox.updateEvidence(decision.id, { module: "agents", cause_cleared: true }), 403);
  });
});
