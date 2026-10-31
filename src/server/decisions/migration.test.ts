/**
 * Decision store files from every older schema version (1 to 5), as the server of that version wrote them,
 * opened the way the server opens them (mountDecisions on data/decisions.db): each comes out at the current
 * version with the policy trace table (6), its columns and indexes the same as a new file's, and every row it
 * held intact, including the structure (4) and outcome (5) columns. The decision policies then trace on it.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth } from "../human-auth/index.js";
import { mountDecisions } from "./mount.js";
import { mountDecisionPolicies } from "./policies/index.js";
import { DecisionStore, SCHEMA_VERSION } from "./store.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-decisions-migrate-"));
  dirs.push(dir);
  return dir;
}

// The decisions table's columns as each version created them (git history of store.ts)
const V1_COLUMNS = `
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL,
    options TEXT NOT NULL, recommended_option TEXT NOT NULL, recommended_reasoning TEXT NOT NULL,
    source_module TEXT NOT NULL, source_ref TEXT NOT NULL, dedupe_key TEXT NOT NULL, links TEXT NOT NULL,
    secret_name TEXT, default_option TEXT, created_at TEXT NOT NULL, expires_at TEXT, overdue_at TEXT,
    status TEXT NOT NULL, answer_option TEXT, answer_note TEXT, answer_secret_supplied INTEGER NOT NULL DEFAULT 0,
    answered_by TEXT, answered_at TEXT, withdrawn_reason TEXT, closed_at TEXT, delivered_at TEXT,
    delivery_error TEXT`;
const COLUMNS: Record<number, string> = {
  1: V1_COLUMNS,
  2: `${V1_COLUMNS}, raised_via TEXT NOT NULL DEFAULT 'server'`,
  3: `${V1_COLUMNS}, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action'`,
  4: `${V1_COLUMNS}, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action', class TEXT, evidence TEXT`,
  5: `${V1_COLUMNS}, raised_via TEXT NOT NULL DEFAULT 'server', attention TEXT NOT NULL DEFAULT 'action', class TEXT, evidence TEXT,
     outcome TEXT, outcome_at TEXT, outcome_evidence TEXT`,
};
// Versions 1 and 2 had one open decision per key; 3 made it per key and way in
const OPEN_KEY_INDEX: Record<number, string> = {
  1: `CREATE UNIQUE INDEX idx_decisions_open_key ON decisions(project, source_module, dedupe_key) WHERE status = 'open';`,
  2: `CREATE UNIQUE INDEX idx_decisions_open_key ON decisions(project, source_module, dedupe_key) WHERE status = 'open';`,
  3: `CREATE UNIQUE INDEX idx_decisions_open_key_via ON decisions(project, source_module, dedupe_key, raised_via) WHERE status = 'open';`,
  4: `CREATE UNIQUE INDEX idx_decisions_open_key_via ON decisions(project, source_module, dedupe_key, raised_via) WHERE status = 'open';`,
  5: `CREATE UNIQUE INDEX idx_decisions_open_key_via ON decisions(project, source_module, dedupe_key, raised_via) WHERE status = 'open';
      CREATE INDEX idx_decisions_await_outcome ON decisions(answered_at) WHERE status = 'answered' AND outcome IS NULL;`,
};

const OPTIONS = JSON.stringify([
  { id: "wait", label: "Wait", consequences: "The task starts when the cooldown ends.", effect: "reversible" },
  { id: "stop", label: "Stop", consequences: "The task is freed.", effect: "frees_task" },
]);
const EVIDENCE = JSON.stringify({
  code: "provider_rate_limit",
  facts: { agent: "agent-a", profiles_failing: 2, limit_resets_at: "2026-03-03T00:00:00Z" },
  cause_cleared: false,
  linked_issue: null,
});
const OPEN_ID = "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b";
const ANSWERED_ID = "1c6d3d4f-8b54-4a8f-8e3b-1e5c2f3a4b5c";

/** A decisions file exactly as the server at `version` left it: its tables, its indexes, an open and an answered decision. */
function oldFile(path: string, version: number): void {
  const db = new Database(path);
  const has = (v: number) => version >= v;
  db.exec(`
    CREATE TABLE decisions (${COLUMNS[version]});
    ${OPEN_KEY_INDEX[version]}
    CREATE INDEX idx_decisions_status ON decisions(status, project);
    CREATE TABLE decision_blocks (decision_id TEXT NOT NULL REFERENCES decisions(id), ref TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
    CREATE INDEX idx_decision_blocks_ref ON decision_blocks(ref);
    CREATE TABLE decision_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL REFERENCES decisions(id), at TEXT NOT NULL,
      action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE INDEX idx_decision_audit ON decision_audit(decision_id, id);
  `);
  const columns = ["id", "project", "kind", "title", "context", "options", "recommended_option", "recommended_reasoning",
    "source_module", "source_ref", "dedupe_key", "links", "created_at", "status", "answer_option", "answered_by", "answered_at", "closed_at"];
  const extra = (row: Record<string, unknown>) => [
    ...(has(2) ? [["raised_via", "server"]] : []),
    ...(has(3) ? [["attention", "action"]] : []),
    ...(has(4) ? [["class", row.class], ["evidence", row.evidence]] : []),
    ...(has(5) ? [["outcome", row.outcome], ["outcome_at", row.outcome_at], ["outcome_evidence", row.outcome_evidence]] : []),
  ] as [string, unknown][];
  const insert = (base: unknown[], row: Record<string, unknown>) => {
    const more = extra(row);
    const names = [...columns, ...more.map(([n]) => n)];
    db.prepare(`INSERT INTO decisions (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...base, ...more.map(([, v]) => v));
  };
  insert(
    [OPEN_ID, "demo", "escalation", "Every profile is rate limited", "Both profiles hit a limit.", OPTIONS, "wait", "It clears.",
      "agents", "chain:c1", "exhausted:c1", "[]", "2026-03-01T00:00:00.000Z", "open", null, null, null, null],
    { class: "agents.provider_limit", evidence: EVIDENCE, outcome: null, outcome_at: null, outcome_evidence: null },
  );
  insert(
    [ANSWERED_ID, "demo", "escalation", "An older limit", "One profile hit a limit.", OPTIONS, "wait", "It clears.",
      "agents", "chain:c0", "exhausted:c0", "[]", "2026-02-28T00:00:00.000Z", "answered", "wait", "owner",
      "2026-02-28T01:00:00.000Z", "2026-02-28T01:00:00.000Z"],
    { class: "agents.provider_limit", evidence: EVIDENCE, outcome: "good", outcome_at: "2026-02-28T08:00:00.000Z", outcome_evidence: '{"rule":"hold","fact":"task_done"}' },
  );
  db.prepare(`INSERT INTO decision_blocks (decision_id, ref) VALUES (?, ?)`).run(OPEN_ID, "agents:demo:task:feat-login");
  db.prepare(`INSERT INTO decision_audit (decision_id, at, action, actor, detail) VALUES (?, ?, 'raised', 'agents', 'raised')`).run(OPEN_ID, "2026-03-01T00:00:00.000Z");
  db.pragma(`user_version = ${version}`);
  db.close();
}

interface Shape {
  version: number;
  tables: Record<string, string[]>;
  indexes: string[];
}

function shape(path: string): Shape {
  const db = new Database(path, { readonly: true });
  try {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    const tables: Record<string, string[]> = {};
    for (const name of names) {
      tables[name] = (db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(name) as Record<string, unknown>[])
        .map((c) => `${String(c.name)} ${String(c.type)}${c.notnull ? " NOT NULL" : ""}${c.dflt_value !== null ? ` DEFAULT ${String(c.dflt_value)}` : ""}${c.pk ? ` PK${String(c.pk)}` : ""}`)
        .sort();
    }
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    return { version: db.pragma("user_version", { simple: true }) as number, tables, indexes };
  } finally {
    db.close();
  }
}

/** The server's start: the inbox mounted on the file, and (optionally) the decision policies on, over it. */
async function start(dbPath: string, policies: boolean) {
  const dir = tempDir();
  const app = Fastify({ logger: false });
  apps.push(app);
  const events = new EventBus();
  const humanAuth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  const inbox = await mountDecisions(app, { dbPath, humanAuth, defaultProject: () => "demo", events, clock: { now: () => NOW } });
  let mounted: Awaited<ReturnType<typeof mountDecisionPolicies>> | null = null;
  if (policies) {
    const configPath = join(dir, "server.yaml");
    writeFileSync(configPath, "decision_policies:\n  enabled: true\n");
    chmodSync(configPath, 0o600);
    mounted = await mountDecisionPolicies(app, { configPath, policiesPath: join(dir, "policies.yaml"), inbox, events, humanAuth, log: () => undefined });
  }
  await app.ready();
  return { app, inbox, policies: mounted };
}

describe("decision store files from older schema versions", () => {
  it("the schema is at version 6, the policy trace", () => {
    expect(SCHEMA_VERSION).toBe(6);
  });

  for (const version of [1, 2, 3, 4, 5]) {
    it(`a version ${version} file opens at version ${SCHEMA_VERSION} with the policy trace and keeps every row`, async () => {
      const dir = tempDir();
      const fresh = join(dir, "fresh.db");
      new DecisionStore(fresh).close();
      const expected = shape(fresh);
      expect(expected.tables.policy_trace).toBeDefined();

      const path = join(dir, "decisions.db");
      oldFile(path, version);
      expect(shape(path).tables.policy_trace).toBeUndefined();

      const { app, inbox, policies } = await start(path, true);
      // The open decision with a class gets its proposal from the catch-up at start
      expect(await policies!.caughtUp).toBe(version >= 4 ? 1 : 0);

      const open = inbox.get(OPEN_ID)!;
      expect(open).toMatchObject({ status: "open", title: "Every profile is rate limited", attention: "action", raisedVia: "server", blocks: ["agents:demo:task:feat-login"] });
      expect(open.options.map((o) => o.id)).toEqual(["wait", "stop"]);
      expect(open.audit?.map((a) => a.action)).toEqual(["raised"]);
      const answered = inbox.get(ANSWERED_ID)!;
      expect(answered).toMatchObject({ status: "answered", answer: { optionId: "wait" }, answeredBy: "owner" });
      if (version >= 4) {
        // The structure columns (4) are intact
        for (const d of [open, answered]) {
          expect(d.class).toBe("agents.provider_limit");
          expect(d.evidence).toEqual(JSON.parse(EVIDENCE));
        }
        expect(inbox.policyTraces()).toMatchObject([{ decisionId: OPEN_ID, policy: "c1-wait", option: "wait" }]);
      } else {
        expect(open.class).toBeUndefined();
        expect(open.evidence).toBeUndefined();
        expect(inbox.policyTraces()).toEqual([]);
      }
      if (version >= 5) {
        // The outcome columns (5) are intact, and an answer with an outcome is not waiting for one
        expect(answered).toMatchObject({ outcome: "good", outcomeAt: "2026-02-28T08:00:00.000Z", outcomeEvidence: { rule: "hold", fact: "task_done" } });
        expect(inbox.awaitingOutcome(10).map((d) => d.id)).toEqual([]);
      } else {
        expect(answered.outcome).toBeUndefined();
        expect(inbox.awaitingOutcome(10).map((d) => d.id)).toEqual([ANSWERED_ID]);
      }

      // A trace row can be written on the upgraded file, once, and is counted against the answer
      const row = { decisionId: ANSWERED_ID, proposer: "test", version: "v1", class: "agents.provider_limit", policy: "p", option: "wait", reasonCode: "r", confidence: 1, at: new Date(NOW).toISOString() };
      expect(inbox.recordPolicyTrace(row)).toBe(true);
      expect(inbox.recordPolicyTrace(row)).toBe(false);
      expect(inbox.hasPolicyTrace(ANSWERED_ID, "test", "v1")).toBe(true);
      expect(inbox.policyAgreement().find((r) => r.proposer === "test")).toMatchObject({ traced: 1, compared: 1, agreed: 1 });
      // The file is still the inbox's: a new decision raises
      expect((await inbox.raise({ project: "demo", kind: "other", title: "New", context: "c", options: [{ id: "ok", label: "OK", consequences: "x" }], recommended: { optionId: "ok", reasoning: "r" }, source: { module: "agents", ref: "r" }, key: "new" })).created).toBe(true);
      await app.close();
      apps.splice(apps.indexOf(app), 1);

      // Its tables, columns and indexes are a new file's; the old one-per-key index is gone
      const upgraded = shape(path);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(upgraded.tables).toEqual(expected.tables);
      expect(upgraded.indexes).toEqual(expected.indexes);
      expect(upgraded.indexes).not.toContain("idx_decisions_open_key");

      // Opening it again changes nothing and writes no second trace row
      const again = await start(path, true);
      expect(await again.policies!.caughtUp).toBe(0);
      expect(again.inbox.policyTraces()).toHaveLength(version >= 4 ? 2 : 1);
      expect(again.inbox.get(ANSWERED_ID)).toMatchObject({ status: "answered", answer: { optionId: "wait" } });
      await again.app.close();
      apps.splice(apps.indexOf(again.app), 1);
      expect(shape(path)).toEqual(upgraded);
    });
  }
});
