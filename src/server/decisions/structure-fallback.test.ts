/**
 * A class, evidence or effect the schema refuses never drops a decision a
 * module inside Lair raised: it is raised without them, and the refusal is
 * recorded (audit entry, event). Driven through the real inbox and through
 * real callers (HoldDecisions, the pipelines' request bridge, the
 * watchdog's decisionFor) with one bad fact each. Over HTTP the 400 stays.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import { HoldDecisions } from "./holds.js";
import { toDecisionInput } from "./request-bridge.js";
import { decisionFor } from "../watchdog/escalation.js";
import { DETECTOR_IDS } from "../watchdog/types.js";
import type { Breach } from "../watchdog/types.js";
import type { WatchdogContext } from "../watchdog/view.js";
import { DecisionError } from "./validate.js";
import type { DecisionProducer, RaiseDecisionInput } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const stores: DecisionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new DecisionStore(":memory:");
  stores.push(store);
  const bus = new EventBus();
  const events: Event[] = [];
  bus.on("*", (event) => {
    events.push(event);
  });
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus, clock: { now: () => NOW } });
  return { inbox, store, events };
}

/** The inbox, with each raise's evidence given one more fact the schema refuses (over 200 characters). */
function withBadFact(inbox: DecisionInbox): DecisionProducer {
  return new Proxy(inbox, {
    get(target, prop) {
      if (prop === "raise") {
        return (input: RaiseDecisionInput) =>
          target.raise(
            input.evidence
              ? { ...input, evidence: { ...input.evidence, facts: { ...input.evidence.facts, bad: "x".repeat(300) } } }
              : input,
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DecisionProducer;
}

function plain(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: "Pick the default page size",
    context: "The list view needs a page size.",
    options: [
      { id: "small", label: "20 rows", consequences: "Faster pages.", effect: "reversible" },
      { id: "large", label: "100 rows", consequences: "Fewer pages.", effect: "reversible" },
    ],
    recommended: { optionId: "small", reasoning: "Most lists are short." },
    source: { module: "planner", ref: "card-12" },
    key: "page-size",
    class: "planner.unblock",
    evidence: { code: "needs_owner", facts: { task: "t1" }, cause_cleared: false, linked_issue: null },
    ...overrides,
  };
}

describe("a refused structure never drops a decision a module raised", () => {
  const bad: [string, Partial<RaiseDecisionInput>][] = [
    ["a fact over 200 characters", { evidence: { code: "needs_owner", facts: { task: "x".repeat(201) }, cause_cleared: false, linked_issue: null } }],
    ["a fact with a control character", { evidence: { code: "needs_owner", facts: { task: "a\u0007b" }, cause_cleared: false, linked_issue: null } }],
    ["a fact that is undefined", { evidence: { code: "needs_owner", facts: { task: undefined as unknown as null }, cause_cleared: false, linked_issue: null } }],
    ["a code the class does not take", { evidence: { code: "not_a_code", facts: {}, cause_cleared: false, linked_issue: null } }],
    ["a class of another module", { class: "agents.gave_up", evidence: { code: "dead_on_start", facts: {}, cause_cleared: false, linked_issue: null } }],
    ["an option without an effect", { options: [{ id: "small", label: "20 rows", consequences: "Faster pages." }, { id: "large", label: "100 rows", consequences: "Fewer pages.", effect: "reversible" }] }],
    ["a class without evidence", { evidence: undefined }],
  ];

  for (const [name, overrides] of bad) {
    it(`is raised plain, with the refusal on record: ${name}`, async () => {
      const { inbox, store, events } = setup();
      const { decision, created } = await inbox.raise(plain(overrides));
      expect(created).toBe(true);
      expect(decision.status).toBe("open");
      expect(decision.class).toBeUndefined();
      expect(decision.evidence).toBeUndefined();
      expect(decision.options.every((o) => o.effect === undefined)).toBe(true);
      expect(store.audit(decision.id).map((a) => a.action)).toContain("structure_refused");
      expect(events.map((e) => e.type)).toContain("decision.structure_refused");
      expect(events.map((e) => e.type)).toContain("decision.raised");
    });
  }

  it("a valid structure is kept, with no refusal on record", async () => {
    const { inbox, store, events } = setup();
    const { decision } = await inbox.raise(plain());
    expect(decision.class).toBe("planner.unblock");
    expect(store.audit(decision.id).map((a) => a.action)).not.toContain("structure_refused");
    expect(events.map((e) => e.type)).not.toContain("decision.structure_refused");
  });

  it("a decision that is invalid for its own content is still refused", async () => {
    const { inbox } = setup();
    await expect(inbox.raise(plain({ title: "" }))).rejects.toBeInstanceOf(DecisionError);
  });

  it("over HTTP the 400 stays", async () => {
    const { inbox } = setup();
    const refused = await inbox
      .raiseFromHttp(plain({ source: { module: "someone", ref: "r" }, class: "someone.thing", evidence: { code: "c", facts: { a: "x".repeat(201) }, cause_cleared: false, linked_issue: null } }))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DecisionError);
    expect((refused as DecisionError).statusCode).toBe(400);
  });
});

describe("real callers with a bad fact still end with an open decision", () => {
  it("a hold (decisions/holds.ts)", async () => {
    const { inbox, store } = setup();
    const holds = new HoldDecisions("review-holds", "demo");
    holds.use(withBadFact(inbox), async () => {});
    const created = await holds.ensure({
      key: "hold:1",
      ref: "pr:7",
      title: "A merge is held",
      context: "Held by the owner.",
      releaseLabel: "Release it",
      releaseConsequences: "The merge goes on.",
      keepLabel: "Keep holding",
      keepConsequences: "Nothing changes.",
    });
    expect(created).toBe(true);
    const decision = holds.decisionFor("hold:1");
    expect(decision?.status).toBe("open");
    expect(store.audit(decision!.id).map((a) => a.action)).toContain("structure_refused");
  });

  it("a request in the pipelines' and review's shape with fewer effects than options (request-bridge.ts)", async () => {
    const { inbox } = setup();
    const input = toDecisionInput({
      key: "pipelines:budget:2026-03",
      project: "demo",
      kind: "spend",
      question: "Allow more runner minutes?",
      context: "The budget is used.",
      options: ["Keep the budget", "Raise the budget"],
      recommended: "Keep the budget",
      why: "Spending needs approval.",
      reversible: true,
      onTimeout: "wait",
      requestedBy: "pipelines",
      structure: {
        class: "pipelines.budget",
        evidence: { code: "budget_exceeded", facts: { month: "2026-03" }, cause_cleared: false, linked_issue: null },
        effects: ["reversible"],
      },
    });
    const { decision } = await inbox.raise(input);
    expect(decision.status).toBe("open");
    expect(decision.kind).toBe("spend");
    expect(decision.options.map((o) => o.label)).toEqual(["Keep the budget", "Raise the budget"]);
  });

  it("every watchdog detector's escalation (watchdog/escalation.ts decisionFor)", async () => {
    const { inbox } = setup();
    const ctx = { project: "demo", config: {}, settings: { actions: {} } } as unknown as WatchdogContext;
    for (const detector of DETECTOR_IDS) {
      const breach = {
        id: `b-${detector}`,
        project: "demo",
        detector,
        key: detector,
        summary: `Breach of ${detector}`,
        evidence: ["one line"],
        vars: { ready: "3", queued: "1", running: "0", last_start: "", claim_age_min: "42", process_found: "false" },
        status: "open",
        detectedAt: "2026-03-02T11:00:00.000Z",
        lastSeenAt: "2026-03-02T11:30:00.000Z",
      } as unknown as Breach;
      const input = decisionFor(ctx, breach, "escalated");
      const { decision } = await inbox.raise({ ...input, evidence: { ...input.evidence!, facts: { ...input.evidence!.facts, bad: "x".repeat(300) } } });
      expect(decision.status, detector).toBe("open");
    }
  });
});
