/**
 * The structured side of a decision (docs/design/decision-policies.md §4):
 * class, evidence and an effect on each option, checked when it is raised.
 * Decisions raised without them still work.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DecisionInbox } from "./service.js";
import { DecisionError, parseRaiseInput } from "./validate.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import { KNOWN_DECISION_CLASSES, isKnownDecisionClass } from "./structure.js";
import type { RaiseDecisionInput } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

const dirs: string[] = [];
const stores: DecisionStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(dbPath = ":memory:") {
  const store = new DecisionStore(dbPath);
  stores.push(store);
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: { now: () => NOW } });
  return { inbox, store };
}

function structured(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "escalation",
    title: "Every profile is rate limited",
    context: "Both profiles answered with a rate limit.",
    options: [
      { id: "wait", label: "Wait", consequences: "The task starts when a cooldown ends.", effect: "reversible" },
      { id: "stop", label: "Stop", consequences: "The task is freed.", effect: "frees_task" },
    ],
    recommended: { optionId: "wait", reasoning: "A provider limit clears by itself." },
    source: { module: "agents", ref: "chain:c1" },
    key: "exhausted:c1",
    class: "agents.provider_limit",
    evidence: {
      code: "provider_rate_limit",
      facts: { agent: "agent-a", profiles_failing: 2, limit_resets_at: "2026-03-03T00:00:00Z", exhausted: true, note: null },
      cause_cleared: false,
      linked_issue: null,
    },
    ...overrides,
  };
}

/** The object without the named keys. */
function omit<T extends object>(value: T, ...keys: string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
}

function errorsOf(raw: unknown): string[] {
  const parsed = parseRaiseInput(raw, NOW);
  return parsed.ok ? [] : parsed.errors;
}

describe("decision class, evidence and option effects", () => {
  it("are kept: raised, stored and read back", async () => {
    const { inbox } = setup();
    const { decision } = await inbox.raise(structured());
    expect(decision.class).toBe("agents.provider_limit");
    expect(decision.classKnown).toBe(true);
    expect(decision.evidence).toEqual({
      code: "provider_rate_limit",
      facts: { agent: "agent-a", profiles_failing: 2, limit_resets_at: "2026-03-03T00:00:00Z", exhausted: true, note: null },
      cause_cleared: false,
      linked_issue: null,
    });
    expect(decision.options.map((o) => o.effect)).toEqual(["reversible", "frees_task"]);
    expect(inbox.get(decision.id)).toMatchObject({ class: "agents.provider_limit", options: decision.options });
  });

  it("an invalid evidence object is refused at raise time, naming the field", async () => {
    const { inbox } = setup();
    const bad = (evidence: unknown) => structured({ evidence: evidence as RaiseDecisionInput["evidence"] });
    const ok = structured().evidence!;
    await expect(inbox.raise(bad({ ...ok, code: "Provider Limit" }))).rejects.toThrow(/evidence\.code/);
    await expect(inbox.raise(bad({ ...ok, cause_cleared: "no" }))).rejects.toThrow(/evidence\.cause_cleared/);
    await expect(inbox.raise(bad({ ...ok, linked_issue: 0 }))).rejects.toThrow(/evidence\.linked_issue/);
    await expect(inbox.raise(bad({ ...ok, facts: { nested: { a: 1 } } }))).rejects.toThrow(/evidence\.facts\.nested/);
    await expect(inbox.raise(bad({ ...ok, facts: { "Bad Name": 1 } }))).rejects.toThrow(/evidence\.facts/);
    await expect(inbox.raise(bad({ ...ok, facts: { n: Number.NaN } }))).rejects.toThrow(/evidence\.facts\.n/);
    await expect(inbox.raise(bad({ ...ok, extra: 1 }))).rejects.toThrow(/evidence/);
    await expect(inbox.raise(bad({ code: "provider_rate_limit" }))).rejects.toBeInstanceOf(DecisionError);
    expect(inbox.counts().open).toBe(0);
  });

  it("a class needs evidence, evidence needs a class, and every option needs an effect", () => {
    const noEvidence = omit(structured(), "evidence");
    const noClass = omit(structured(), "class");
    expect(errorsOf(noEvidence)).toEqual(["evidence: a class needs evidence"]);
    expect(errorsOf(noClass)).toEqual(["class: evidence needs a class"]);
    const noEffect = structured({
      options: [
        { id: "wait", label: "Wait", consequences: "c", effect: "reversible" },
        { id: "stop", label: "Stop", consequences: "c" },
      ],
    });
    expect(errorsOf(noEffect)).toEqual(["options.1.effect: a decision with a class needs an effect on every option"]);
    expect(errorsOf(structured({ options: [{ id: "wait", label: "Wait", consequences: "c", effect: "sometimes" as never }] }))[0]).toContain(
      "options.0.effect",
    );
  });

  it("the class is module.name and starts with the raising module", () => {
    expect(errorsOf(structured({ class: "provider_limit" }))[0]).toContain("class:");
    expect(errorsOf(structured({ class: "Agents.Limit" }))[0]).toContain("class:");
    expect(errorsOf(structured({ class: "watchdog.provider_limit" }))).toEqual([
      "class: must start with the raising module's name and a '.'",
    ]);
  });

  it("a known class takes only its own evidence codes", () => {
    const evidence = { ...structured().evidence!, code: "docker_down" };
    expect(errorsOf(structured({ evidence }))).toEqual([
      `evidence.code: agents.provider_limit takes one of ${KNOWN_DECISION_CLASSES["agents.provider_limit"].codes.join(", ")}`,
    ]);
  });

  it("an unknown class is allowed but flagged, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inbox } = setup();
    const raise = (key: string) => inbox.raise(structured({ class: "agents.new_thing", evidence: { ...structured().evidence!, code: "anything" }, key }));
    const { decision } = await raise("a");
    expect(decision).toMatchObject({ class: "agents.new_thing", classKnown: false });
    expect(inbox.get(decision.id)?.audit?.[0].detail).toContain("class agents.new_thing is not in the policy table");
    await raise("b");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("agents.new_thing"))).toHaveLength(1);
  });

  it("the classes of the policy table are the eleven of the design, each in module.name", () => {
    const policies = Object.values(KNOWN_DECISION_CLASSES).map((c) => c.policy);
    expect(policies.sort()).toEqual(["C1", "C10", "C11", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"].sort());
    for (const id of Object.keys(KNOWN_DECISION_CLASSES)) expect(isKnownDecisionClass(id)).toBe(true);
    expect(isKnownDecisionClass("toString")).toBe(false);
  });

  it("a decision without any of them is still raised and shown", async () => {
    const { inbox } = setup();
    const plain = omit(structured(), "class", "evidence");
    const { decision } = await inbox.raise({
      ...plain,
      options: plain.options.map((option) => omit(option, "effect")),
    });
    expect(decision.class).toBeUndefined();
    expect(decision.evidence).toBeUndefined();
    expect(decision.options[0].effect).toBeUndefined();
  });

  it("effects without a class are refused: they would be unreachable by a policy", () => {
    const plain = omit(structured(), "class", "evidence");
    expect(errorsOf(plain)).toEqual(["class: options carry an effect, so the decision needs a class and evidence"]);
  });

  it("a store from schema version 3 gains the columns: its decisions load without them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-decisions-"));
    dirs.push(dir);
    const dbPath = join(dir, "decisions.db");
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL,
        options TEXT NOT NULL, recommended_option TEXT NOT NULL, recommended_reasoning TEXT NOT NULL,
        source_module TEXT NOT NULL, source_ref TEXT NOT NULL, dedupe_key TEXT NOT NULL, links TEXT NOT NULL,
        secret_name TEXT, default_option TEXT, created_at TEXT NOT NULL, expires_at TEXT, overdue_at TEXT,
        status TEXT NOT NULL, answer_option TEXT, answer_note TEXT, answer_secret_supplied INTEGER NOT NULL DEFAULT 0,
        answered_by TEXT, answered_at TEXT, withdrawn_reason TEXT, closed_at TEXT, delivered_at TEXT,
        delivery_error TEXT, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action'
      );
      INSERT INTO decisions (id, project, kind, title, context, options, recommended_option, recommended_reasoning,
        source_module, source_ref, dedupe_key, links, created_at, status)
      VALUES ('0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b', 'demo', 'other', 'Old one', 'c',
        '[{"id":"ok","label":"OK","consequences":"x"}]', 'ok', 'r', 'agents', 'r', 'k', '[]',
        '2026-03-01T00:00:00.000Z', 'open');
    `);
    old.pragma("user_version = 3");
    old.close();

    const { inbox } = setup(dbPath);
    const loaded = inbox.get("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b");
    expect(loaded).toMatchObject({ title: "Old one", status: "open" });
    expect(loaded?.class).toBeUndefined();
    expect(loaded?.evidence).toBeUndefined();
    const { decision } = await inbox.raise(structured());
    expect(inbox.get(decision.id)?.class).toBe("agents.provider_limit");
  });
});
