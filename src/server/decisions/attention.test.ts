/**
 * Decision kinds by attention: an `action` needs the owner's answer, a
 * `notice` is for their information. On the real store and inbox, with a
 * fixed clock; the HTTP summary through the real routes.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HumanAuth } from "../human-auth/index.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore, SCHEMA_VERSION } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import { mountDecisions } from "./mount.js";
import type { RaiseDecisionInput } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

const dirs: string[] = [];
const stores: DecisionStore[] = [];

afterEach(() => {
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

function escalation(overrides: Partial<RaiseDecisionInput> = {}): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "escalation",
    title: "No merge for 4.2 h",
    context: "The merge rate dropped.",
    options: [{ id: "stand_down", label: "Leave it to me", consequences: "Lair runs nothing for it." }],
    recommended: { optionId: "stand_down", reasoning: "Only you can fix it." },
    source: { module: "watchdog", ref: "b1" },
    key: "breach:b1",
    ...overrides,
  };
}

describe("decision attention: action or notice", () => {
  it("a decision needs an answer unless it is raised as a notice", async () => {
    const { inbox } = setup();
    const { decision: asked } = await inbox.raise(escalation({ key: "a" }));
    const { decision: fyi } = await inbox.raise(escalation({ key: "b", attention: "notice" }));
    expect(asked.attention).toBe("action");
    expect(fyi.attention).toBe("notice");
    expect(inbox.get(fyi.id)?.audit?.[0].detail).toContain("notice raised by watchdog");
  });

  it("refuses a notice for a kind that always waits for a human, and a notice with a default", async () => {
    const { inbox } = setup();
    await expect(
      inbox.raise(
        escalation({
          kind: "spend",
          attention: "notice",
          options: [{ id: "ok", label: "OK", consequences: "Nothing." }],
          recommended: { optionId: "ok", reasoning: "r" },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("can't be a notice") });
    await expect(
      inbox.raise(
        escalation({ attention: "notice", expiresAt: "2026-03-02T13:00:00.000Z", defaultOptionId: "stand_down" }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("a notice has no default") });
    await expect(inbox.raise(escalation({ attention: "later" as never }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("counts: open is every open decision; action and overdue count only what needs an answer", async () => {
    const { inbox } = setup();
    await inbox.raise(escalation({ key: "a" }));
    await inbox.raise(escalation({ key: "b", attention: "notice" }));
    await inbox.raise(escalation({ key: "c", attention: "notice", project: "other" }));
    expect(inbox.counts()).toEqual({ open: 3, overdue: 0, action: 1, notices: 2 });
    expect(inbox.counts("demo")).toEqual({ open: 2, overdue: 0, action: 1, notices: 1 });
    expect(inbox.list({ status: "open", attention: "notice" }).map((d) => d.key).sort()).toEqual(["b", "c"]);
    expect(inbox.list({ status: "open", attention: "action" }).map((d) => d.key)).toEqual(["a"]);
  });

  it("find() returns a module's latest decision for a key whatever its status; openOf() its open ones", async () => {
    const { inbox } = setup();
    expect(inbox.find("demo", "watchdog", "a")).toBeNull();
    const { decision: first } = await inbox.raise(escalation({ key: "a" }));
    await inbox.withdraw(first.id, { module: "watchdog", reason: "gone" });
    expect(inbox.find("demo", "watchdog", "a")).toMatchObject({ id: first.id, status: "withdrawn" });
    const { decision: second } = await inbox.raise(escalation({ key: "a" }));
    expect(inbox.find("demo", "watchdog", "a")).toMatchObject({ id: second.id, status: "open" });
    await inbox.answer(second.id, { optionId: "stand_down" });
    expect(inbox.find("demo", "watchdog", "a")).toMatchObject({ id: second.id, status: "answered" });
    // Another module's or project's decision with the same key is not this one's
    expect(inbox.find("demo", "agents", "a")).toBeNull();
    expect(inbox.find("other", "watchdog", "a")).toBeNull();

    await inbox.raise(escalation({ key: "b" }));
    await inbox.raise(escalation({ key: "c", source: { module: "agents", ref: "x" } }));
    expect(inbox.openOf("demo", "watchdog").map((d) => d.key)).toEqual(["b"]);
    expect(inbox.openOf("demo", "agents").map((d) => d.key)).toEqual(["c"]);
  });

  it("a store from schema version 2 gains the column: its decisions are actions", async () => {
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
        delivery_error TEXT, raised_via TEXT NOT NULL DEFAULT 'server'
      );
      INSERT INTO decisions (id, project, kind, title, context, options, recommended_option, recommended_reasoning,
        source_module, source_ref, dedupe_key, links, created_at, status)
      VALUES ('0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b', 'demo', 'other', 'Old one', 'c',
        '[{"id":"ok","label":"OK","consequences":"x"}]', 'ok', 'r', 'agents', 'r', 'k', '[]',
        '2026-03-01T00:00:00.000Z', 'open');
    `);
    old.pragma("user_version = 2");
    old.close();

    const { inbox, store } = setup(dbPath);
    expect(inbox.get("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b")).toMatchObject({ attention: "action", title: "Old one" });
    expect(inbox.counts()).toMatchObject({ open: 1, action: 1, notices: 0 });
    await inbox.raise(escalation({ attention: "notice" }));
    expect(inbox.counts()).toMatchObject({ open: 2, action: 1, notices: 1 });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Database(dbPath);
    expect(reopened.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  it("GET /api/decisions/summary counts action decisions for the badge, notices apart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-decisions-"));
    dirs.push(dir);
    const app = Fastify();
    const auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
    const inbox = await mountDecisions(app, { dbPath: ":memory:", humanAuth: auth, defaultProject: () => "demo" });
    await app.ready();
    try {
      await inbox.raise(escalation({ key: "a" }));
      await inbox.raise(escalation({ key: "b", attention: "notice" }));
      const summary = (await app.inject({ url: "/api/decisions/summary" })).json().data;
      expect(summary).toMatchObject({ open: 2, action: 1, notices: 1, overdue: 0 });
      const notices = (await app.inject({ url: "/api/decisions?status=open&attention=notice" })).json().data;
      expect(notices.map((d: { key: string }) => d.key)).toEqual(["b"]);
      expect((await app.inject({ url: "/api/decisions?attention=maybe" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
