/**
 * The policy table, the rule proposer, the shadow trace and the agreement view, on a real inbox store
 * (SQLite in memory or a temp file). Nothing here may answer a decision.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../../core/event-bus.js";
import type { Decision, DecisionEvidence, DecisionOption } from "../../../shared/decision-types.js";
import { DecisionInbox } from "../service.js";
import { DecisionStore } from "../store.js";
import { MemorySecretStore } from "../secrets.js";
import type { RaiseDecisionInput } from "../types.js";
import { agreementRows } from "./agreement.js";
import { DecisionPolicies } from "./index.js";
import { holds, RuleProposer } from "./rules.js";
import { PolicyShadow, shadowSource } from "./shadow.js";
import { DEFAULT_POLICIES_YAML, loadPolicyTable, MAX_POLICIES_BYTES, parsePolicyTable } from "./table.js";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const dirs: string[] = [];
const stores: DecisionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-policies-"));
  dirs.push(dir);
  return dir;
}

function evidence(code: string, facts: DecisionEvidence["facts"] = {}, rest: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return { code, facts, cause_cleared: false, linked_issue: null, ...rest };
}

const WAIT_STOP: DecisionOption[] = [
  { id: "wait", label: "Wait", consequences: "Waits.", effect: "reversible" },
  { id: "stop", label: "Stop", consequences: "Stops.", effect: "frees_task" },
];

function raiseInput(over: Partial<RaiseDecisionInput> & { module?: string }): RaiseDecisionInput {
  const { module = "agents", ...rest } = over;
  return {
    project: "demo",
    kind: "escalation",
    title: "Every profile is failing",
    context: "Rate limited.",
    options: WAIT_STOP,
    recommended: { optionId: "wait", reasoning: "It clears by itself." },
    source: { module, ref: "chain:1" },
    key: `k-${Math.random()}`,
    class: "agents.provider_limit",
    evidence: evidence("provider_rate_limit", { agent: "agent-a", profiles_failing: 2 }),
    ...rest,
  };
}

function setup(dbPath = ":memory:") {
  const store = new DecisionStore(dbPath);
  stores.push(store);
  const events = new EventBus();
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events, clock: { now: () => NOW.getTime() } });
  return { store, inbox, events };
}

/** A decision as the rules read it, without an inbox. */
function decision(over: Partial<Decision> & { code?: string; facts?: DecisionEvidence["facts"]; ev?: Partial<DecisionEvidence> }): Decision {
  return {
    id: "d1", project: "demo", kind: "escalation", attention: "action", title: "t", context: "c",
    options: WAIT_STOP, recommended: { optionId: "wait", reasoning: "r" }, source: { module: "agents", ref: "r" },
    key: "k", blocks: [], links: [], createdAt: NOW.toISOString(), overdue: false, status: "open", raisedVia: "server",
    class: "agents.provider_limit",
    evidence: evidence(over.code ?? "provider_rate_limit", over.facts ?? {}, over.ev),
    ...over,
  } as Decision;
}

describe("policy table validation", () => {
  it("the built-in table is valid and covers C1, C2, C3, C4 and C11 in shadow", () => {
    const t = parsePolicyTable(DEFAULT_POLICIES_YAML);
    expect(t.errors).toEqual([]);
    expect(t.policies.map((p) => p.class).sort()).toEqual(
      ["agents.cannot_start", "agents.provider_limit", "supervisor.check_failing", "watchdog.idle_capacity", "watchdog.orphan_claim"].sort(),
    );
    expect(t.policies.every((p) => p.state === "shadow" && p.maxTier === 1)).toBe(true);
  });

  const entry = (extra: string) => `version: 1\npolicies:\n  - id: p1\n    class: agents.provider_limit\n    answer: wait\n    reason_code: r\n    state: shadow\n    max_tier: 1\n${extra}`;

  it("refuses the entry, not the file, for an unknown class, a foreign code, a state not built, a bad op and a duplicate id", () => {
    const text = (s: string) => parsePolicyTable(s);
    expect(text(entry("")).errors).toEqual([]);
    expect(text(entry("")).policies).toHaveLength(1);
    expect(text(entry("").replace("agents.provider_limit", "agents.nope")).errors[0]).toContain("is not in the policy table");
    const bad = (line: string) => parsePolicyTable(entry("").replace(/ {4}max_tier: 1\n/, line));
    expect(bad("    max_tier: 1\n    codes: [check_failing]\n").errors[0]).toContain("has no evidence code check_failing");
    expect(bad("    max_tier: 4\n").errors[0]).toContain("max_tier");
    expect(parsePolicyTable(entry("").replace("shadow", "act")).errors[0]).toContain("state");
    expect(parsePolicyTable(entry("").replace("shadow", "suggest")).errors[0]).toContain("state");
    expect(bad("    max_tier: 1\n    when:\n      - { fact: x, op: gte, value: abc }\n").errors[0]).toContain("compares numbers");
    expect(bad("    max_tier: 1\n    when:\n      - { fact: x, op: in, value: 3 }\n").errors[0]).toContain("in needs a list");
    expect(bad("    max_tier: 1\n    unknown_key: 1\n").errors[0]).toContain("unknown_key");
    expect(parsePolicyTable(entry("") + entry("").split("policies:\n")[1]).errors).toEqual(["policy p1: id: used twice"]);
  });

  it("a file that is not YAML, has the wrong shape or is too large gives no policies at all", () => {
    expect(parsePolicyTable("policies: [").policies).toEqual([]);
    expect(parsePolicyTable("policies: [").errors[0]).toContain("not valid YAML");
    expect(parsePolicyTable("version: 2\npolicies: []").policies).toEqual([]);
    const dir = tempDir();
    writeFileSync(join(dir, "big.yaml"), "x".repeat(MAX_POLICIES_BYTES + 1));
    const big = loadPolicyTable(join(dir, "big.yaml"));
    expect(big.table.policies).toEqual([]);
    expect(big.table.errors[0]).toContain("larger than");
    expect(loadPolicyTable(join(dir, "missing.yaml")).source).toBe("built-in");
  });

  it("the version changes with any change to a policy", () => {
    const a = parsePolicyTable(entry(""));
    const b = parsePolicyTable(entry("").replace("answer: wait", "answer: stop"));
    expect(a.version).not.toBe(b.version);
    expect(a.version).toBe(parsePolicyTable(entry("")).version);
  });
});

describe("rule proposer", () => {
  const proposer = new RuleProposer(() => parsePolicyTable(DEFAULT_POLICIES_YAML));
  const propose = (d: Decision) => proposer.propose(d, NOW);

  it("C1: wait on a provider limit while its cause stands", () => {
    expect(propose(decision({}))).toMatchObject({ option: "wait", policy: "c1-wait", confidence: 1 });
    expect(propose(decision({ code: "provider_quota" }))?.option).toBe("wait");
  });
  it("C1: abstains once the limit has reset (cause cleared), and for a code the rule does not cover", () => {
    expect(propose(decision({ ev: { cause_cleared: true } }))).toMatchObject({ option: null, reasonCode: "guard" });
    expect(propose(decision({ code: "provider_unreachable" }))).toBeNull();
  });
  it("C2: noted only when an issue tracks the check", () => {
    const check = (linked: number | null) =>
      decision({ class: "supervisor.check_failing", code: "check_failing", ev: { linked_issue: linked }, options: [{ id: "noted", label: "Noted", consequences: "c", effect: "reversible" }], kind: "other", attention: "notice" });
    expect(propose(check(41))).toMatchObject({ option: "noted", policy: "c2-noted" });
    expect(propose(check(null))).toMatchObject({ option: null, reasonCode: "conditions_not_met" });
  });
  it("C3: stand down after two playbook attempts, never with nothing running", () => {
    const idle = (facts: DecisionEvidence["facts"]) =>
      decision({ class: "watchdog.idle_capacity", code: "idle_capacity", facts, options: [{ id: "run", label: "Run", consequences: "c", effect: "outward" }, { id: "stand_down", label: "Leave", consequences: "c", effect: "reversible" }] });
    expect(propose(idle({ playbook_attempts: 2, running_count: 3 }))).toMatchObject({ option: "stand_down", policy: "c3-stand-down" });
    expect(propose(idle({ playbook_attempts: 1, running_count: 3 }))?.option).toBeNull();
    expect(propose(idle({ playbook_attempts: 2, running_count: 0 }))).toMatchObject({ option: null, reasonCode: "guard" });
    // a guard whose fact is missing cannot be evaluated: abstain
    expect(propose(idle({ playbook_attempts: 2 }))).toMatchObject({ option: null, reasonCode: "guard" });
  });
  it("C4: stand down when a runner is alive", () => {
    const claim = (facts: DecisionEvidence["facts"]) =>
      decision({ class: "watchdog.orphan_claim", code: "claim_orphan", facts, options: [{ id: "stand_down", label: "Leave", consequences: "c", effect: "reversible" }] });
    expect(propose(claim({ process_found: true }))?.option).toBe("stand_down");
    expect(propose(claim({ process_found: false }))?.option).toBeNull();
    expect(propose(claim({ process_found: "true" }))?.option).toBeNull();
  });
  it("C11: keep held for a probe error", () => {
    const d = decision({ class: "agents.cannot_start", code: "probe_failed", options: [{ id: "keep_held", label: "Keep", consequences: "c", effect: "reversible" }, { id: "retry_now", label: "Retry", consequences: "c", effect: "reversible" }] });
    expect(propose(d)).toMatchObject({ option: "keep_held", policy: "c11-keep-held" });
  });

  it("abstains when the option is not offered, has no effect, or is irreversible or outward", () => {
    expect(propose(decision({ options: [WAIT_STOP[1]] }))).toMatchObject({ option: null, reasonCode: "option_not_offered" });
    expect(propose(decision({ options: [{ id: "wait", label: "W", consequences: "c" }, WAIT_STOP[1]] }))).toMatchObject({ reasonCode: "effect_not_reversible" });
    for (const effect of ["irreversible", "outward"] as const) {
      expect(propose(decision({ options: [{ id: "wait", label: "W", consequences: "c", effect }, WAIT_STOP[1]] }))).toMatchObject({ option: null, reasonCode: "effect_not_reversible" });
    }
  });
  it("never proposes for a decision of a kind that always waits for a person, or without class and evidence", () => {
    expect(propose(decision({ kind: "spend" }))).toMatchObject({ option: null, reasonCode: "tier_3" });
    expect(propose({ ...decision({}), class: undefined })).toBeNull();
    expect(propose({ ...decision({}), evidence: undefined })).toBeNull();
  });
  it("a tier 3 policy, an off policy and an expired policy never propose", () => {
    const yaml = (extra: string) => `version: 1\npolicies:\n  - id: p\n    class: agents.provider_limit\n    answer: wait\n    reason_code: r\n    max_tier: 1\n    state: shadow\n${extra}`;
    const run = (text: string) => new RuleProposer(() => parsePolicyTable(text)).propose(decision({}), NOW);
    expect(run(yaml(""))?.option).toBe("wait");
    expect(run(yaml("").replace("max_tier: 1", "max_tier: 3"))).toMatchObject({ option: null, reasonCode: "tier_3" });
    expect(run(yaml("").replace("shadow", "off"))).toBeNull();
    expect(run(yaml("    expires: '2026-03-01T00:00:00Z'\n"))).toMatchObject({ option: null, reasonCode: "policy_expired" });
    expect(run(yaml("    expires: '2026-04-01T00:00:00Z'\n"))?.option).toBe("wait");
  });

  it("conditions fail closed on a missing fact or a type mismatch", () => {
    const d = decision({ facts: { n: 3, s: "a", b: true, z: null } });
    expect(holds({ fact: "n", op: "gte", value: 3 }, d)).toBe(true);
    expect(holds({ fact: "n", op: "lt", value: 3 }, d)).toBe(false);
    expect(holds({ fact: "missing", op: "eq", value: 1 }, d)).toBeNull();
    expect(holds({ fact: "n", op: "eq", value: "3" }, d)).toBeNull();
    expect(holds({ fact: "s", op: "gt", value: 1 }, d)).toBeNull();
    expect(holds({ fact: "z", op: "eq", value: 1 }, d)).toBeNull();
    expect(holds({ fact: "z", op: "present" }, d)).toBe(false);
    expect(holds({ fact: "s", op: "in", value: ["a", "b"] }, d)).toBe(true);
    expect(holds({ fact: "cause_cleared", op: "eq", value: false }, d)).toBe(true);
    expect(holds({ fact: "constructor", op: "present" }, d)).toBeNull();
  });
});

/** The shadow's reader over a real inbox, as DecisionPolicies builds it. */
function reader(inbox: DecisionInbox) {
  return shadowSource({
    get: (id) => inbox.get(id),
    openPage: (after, limit) => inbox.openClassified(after, limit),
    recordPolicyTrace: (r) => inbox.recordPolicyTrace(r),
    hasPolicyTrace: (a, b, c) => inbox.hasPolicyTrace(a, b, c),
  });
}

describe("shadow: trace and agreement on the real inbox", () => {
  async function wired(dbPath?: string) {
    const s = setup(dbPath);
    const policies = new DecisionPolicies({ policiesPath: join(tempDir(), "none.yaml"), inbox: s.inbox, events: s.events, enabled: true });
    const unsubscribe = policies.subscribe();
    await policies.caughtUp;
    return { ...s, policies, unsubscribe };
  }

  it("writes one proposal for a matching decision and changes nothing on it", async () => {
    const { inbox, policies } = await wired();
    const { decision: raised } = await inbox.raise(raiseInput({}));
    const traces = inbox.policyTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ decisionId: raised.id, proposer: "rules", class: "agents.provider_limit", policy: "c1-wait", option: "wait", reasonCode: "provider_limit_clears", confidence: 1, status: "open", answer: null });
    // the decision is exactly as raised: still open, no answer, nothing delivered
    const after = inbox.get(raised.id)!;
    expect({ ...after, audit: undefined }).toEqual({ ...raised, audit: undefined });
    expect(after.status).toBe("open");
    expect(after.answer).toBeUndefined();
    expect(inbox.get(raised.id)!.audit?.map((a) => a.action)).not.toContain("answered");
    expect(policies.status().agreement[0]).toMatchObject({ traced: 1, pending: 1, compared: 0, agreement: null });
  });

  it("writes nothing for a class without a policy and for a decision without structure", async () => {
    const { inbox } = await wired();
    await inbox.raise(raiseInput({ module: "agents", class: "agents.gave_up", evidence: evidence("dead_on_start"), recommended: { optionId: "release", reasoning: "r" }, options: [{ id: "fresh_session", label: "F", consequences: "c", effect: "reversible" }, { id: "release", label: "R", consequences: "c", effect: "frees_task" }] }));
    await inbox.raise({ ...raiseInput({ key: "plain" }), class: undefined, evidence: undefined, options: WAIT_STOP.map(({ effect: _e, ...o }) => o) });
    expect(inbox.policyTraces()).toEqual([]);
  });

  it("a repeated event or a restart writes no second row; a new table version does", async () => {
    const dir = tempDir();
    const db = join(dir, "decisions.db");
    const first = await wired(db);
    const { decision: raised } = await first.inbox.raise(raiseInput({}));
    await first.events.emit("decision.raised", { decisionId: raised.id });
    await first.events.emit("decision.raised", { decisionId: raised.id });
    expect(first.inbox.policyTraces()).toHaveLength(1);
    first.unsubscribe();
    first.store.close();
    // restart: the same file, the catch-up at subscribe finds the row there
    const second = await wired(db);
    expect(second.inbox.policyTraces()).toHaveLength(1);
    // a decision raised while Lair was down gets its row at the next start (no event was ever seen)
    second.unsubscribe();
    await second.inbox.raise(raiseInput({ key: "late" }));
    expect(second.inbox.policyTraces()).toHaveLength(1);
    second.store.close();
    const third = new DecisionStore(db);
    stores.push(third);
    const inbox = new DecisionInbox({ store: third, secrets: new MemorySecretStore(), clock: { now: () => NOW.getTime() } });
    const shadow = new PolicyShadow(
      reader(inbox),
      () => [new RuleProposer(() => parsePolicyTable(DEFAULT_POLICIES_YAML))],
      () => NOW,
    );
    expect(await shadow.catchUp()).toBe(1);
    expect(await shadow.catchUp()).toBe(0);
    // a changed table is a new version: the open decision is proposed for again, beside the first row
    const changed = parsePolicyTable(DEFAULT_POLICIES_YAML.replace("reason_code: provider_limit_clears", "reason_code: other_code"));
    const shadow2 = new PolicyShadow(
      reader(inbox),
      () => [new RuleProposer(() => changed)],
      () => NOW,
    );
    expect(await shadow2.catchUp()).toBe(2);
    expect(inbox.policyTraces()).toHaveLength(4);
  });

  it("agreement is computed against the answer a person gave; withdrawn and open decisions are counted apart", async () => {
    const { inbox, policies } = await wired();
    const a = (await inbox.raise(raiseInput({ key: "a" }))).decision;
    const b = (await inbox.raise(raiseInput({ key: "b" }))).decision;
    const c = (await inbox.raise(raiseInput({ key: "c" }))).decision;
    await inbox.raise(raiseInput({ key: "open" }));
    // d: cause cleared at the raise, so the rule abstains
    const d = (await inbox.raise(raiseInput({ key: "d", evidence: evidence("provider_rate_limit", {}, { cause_cleared: true }) }))).decision;
    await inbox.answer(a.id, { optionId: "wait" });
    await inbox.answer(b.id, { optionId: "stop" });
    await inbox.withdraw(c.id, { module: "agents", reason: "It moved on" });
    await inbox.answer(d.id, { optionId: "wait" });
    const [row] = policies.status().agreement;
    expect(row).toMatchObject({ class: "agents.provider_limit", proposer: "rules", traced: 5, compared: 3, agreed: 1, disagreed: 1, abstained: 1, withdrawn: 1, pending: 1, unsafeDisagreements: 0 });
    expect(row.agreement).toBe(0.5);
    expect(row.coverage).toBeCloseTo(2 / 3);
    // the answers are the people's, untouched by the trace
    expect(inbox.get(a.id)!.answer?.optionId).toBe("wait");
    expect(inbox.get(b.id)!.answer?.optionId).toBe("stop");
  });

  it("a disagreement on an outward or irreversible proposal counts as unsafe; one on a reversible option does not", async () => {
    const { inbox } = setup();
    const trace = (decisionId: string, option: string) =>
      inbox.recordPolicyTrace({ decisionId, proposer: "manual", version: "v", class: "agents.provider_limit", policy: "p", option, reasonCode: "r", confidence: 1, at: NOW.toISOString() });
    const goHold: DecisionOption[] = [
      { id: "go", label: "Go", consequences: "c", effect: "outward" },
      { id: "hold", label: "Hold", consequences: "c", effect: "reversible" },
    ];
    const unsafe = (await inbox.raise(raiseInput({ key: "u", options: goHold, recommended: { optionId: "hold", reasoning: "r" } }))).decision;
    const safe = (await inbox.raise(raiseInput({ key: "s" }))).decision;
    trace(unsafe.id, "go");
    trace(safe.id, "stop");
    await inbox.answer(unsafe.id, { optionId: "hold" });
    await inbox.answer(safe.id, { optionId: "wait" });
    const [row] = agreementRows(inbox.policyAgreement());
    expect(row).toMatchObject({ proposer: "manual", traced: 2, compared: 2, agreed: 0, disagreed: 2, unsafeDisagreements: 1, agreement: 0, coverage: 1 });
  });

  it("status() counts in SQL and never loads the trace rows", async () => {
    const { inbox, policies } = await wired();
    for (const key of ["a", "b", "c"]) await inbox.raise(raiseInput({ key }));
    inbox.policyTraces = () => {
      throw new Error("the whole trace was read");
    };
    expect(policies.status().agreement).toMatchObject([{ class: "agents.provider_limit", traced: 3, pending: 3 }]);
  });

  it("the catch-up pages through every open decision, yielding to the event loop between pages", async () => {
    const { inbox } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await inbox.raise(raiseInput({ key: `k${i}` }))).decision.id);
    // neither a decision without a class nor a closed one is walked, and neither stops the walk
    await inbox.raise({ ...raiseInput({ key: "plain" }), class: undefined, evidence: undefined, options: WAIT_STOP.map(({ effect: _e, ...o }) => o) });
    await inbox.answer(ids[2], { optionId: "wait" });
    const shadow = new PolicyShadow(reader(inbox), () => [new RuleProposer(() => parsePolicyTable(DEFAULT_POLICIES_YAML))], () => NOW);
    const walking = shadow.catchUp({ batch: 2 });
    // only the first page ran before the walk gave the event loop a turn
    expect(inbox.policyTraces()).toHaveLength(2);
    expect(await walking).toBe(6);
    expect(new Set(inbox.policyTraces().map((t) => t.decisionId))).toEqual(new Set(ids.filter((_, i) => i !== 2)));
  });

  it("the catch-up stops between pages once it is told to (the server is closing)", async () => {
    const { inbox } = setup();
    for (let i = 0; i < 5; i++) await inbox.raise(raiseInput({ key: `k${i}` }));
    const shadow = new PolicyShadow(reader(inbox), () => [new RuleProposer(() => parsePolicyTable(DEFAULT_POLICIES_YAML))], () => NOW);
    let stopped = false;
    const walking = shadow.catchUp({ batch: 2, stopped: () => stopped });
    stopped = true;
    expect(await walking).toBe(2);
    expect(inbox.policyTraces()).toHaveLength(2);
  });

  it("off, it proposes nothing, catches up on nothing and reads no trace", async () => {
    const s = setup();
    await s.inbox.raise(raiseInput({ key: "before" }));
    const policies = new DecisionPolicies({ policiesPath: join(tempDir(), "none.yaml"), inbox: s.inbox, events: s.events, enabled: false });
    policies.subscribe();
    expect(await policies.caughtUp).toBe(0);
    await s.inbox.raise(raiseInput({ key: "after" }));
    expect(s.inbox.policyTraces()).toEqual([]);
    s.inbox.policyAgreement = () => {
      throw new Error("the trace was read");
    };
    expect(policies.status()).toMatchObject({ enabled: false, source: "built-in", agreement: [] });
    expect(policies.status().policies).toHaveLength(5);
  });

  it("the shadow holds a reader and a trace writer, and nothing that answers", () => {
    const { inbox } = setup();
    const src = reader(inbox);
    expect(Object.keys(src).sort()).toEqual(["get", "hasPolicyTrace", "openPage", "recordPolicyTrace"]);
    expect(Object.isFrozen(src)).toBe(true);
  });

  it("a failing proposer never holds up the decision", async () => {
    const { inbox } = setup();
    const logs: string[] = [];
    const shadow = new PolicyShadow(
      reader(inbox),
      () => [{ id: "boom", version: () => "1", propose: () => { throw new Error("broken"); } }],
      () => NOW,
      (l) => logs.push(l),
    );
    const { decision: raised } = await inbox.raise(raiseInput({}));
    expect(shadow.propose(raised.id)).toEqual([]);
    expect(logs[0]).toContain("broken");
  });
});
