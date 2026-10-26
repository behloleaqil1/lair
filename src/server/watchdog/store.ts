/**
 * Watchdog store: breaches, playbook runs, escalations, SLO status and the
 * few samples detectors need across ticks (container restart counts, how long
 * a condition has held). SQLite, so all of it survives a restart.
 *
 * Times are written from the watchdog's Clock, never SQLite's datetime(), so
 * tests with a fake clock get exact values.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  Breach,
  BreachDecision,
  BreachDecisionState,
  BreachResolution,
  BreachStatus,
  DetectorId,
  Escalation,
  Finding,
  PlaybookId,
  PlaybookRun,
  RunMode,
  RunOutcome,
  RunStatus,
  SloState,
  SloStatus,
  StepResult,
} from "./types.js";

// 2: watchdog_breach_decisions (every statement is IF NOT EXISTS, so a
// version 1 file gets the new table and keeps its data)
const SCHEMA_VERSION = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS watchdog_breaches (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    detector TEXT NOT NULL,
    key TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL,
    vars TEXT NOT NULL,
    status TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    escalated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wd_breaches_project ON watchdog_breaches(project, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wd_breaches_open_key
    ON watchdog_breaches(project, key) WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS watchdog_runs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    breach_id TEXT NOT NULL REFERENCES watchdog_breaches(id),
    playbook_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    attempt INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    steps TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wd_runs_breach ON watchdog_runs(breach_id);
  CREATE INDEX IF NOT EXISTS idx_wd_runs_project ON watchdog_runs(project, started_at);

  CREATE TABLE IF NOT EXISTS watchdog_escalations (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    breach_id TEXT NOT NULL UNIQUE REFERENCES watchdog_breaches(id),
    created_at TEXT NOT NULL,
    file TEXT,
    text TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS watchdog_container_samples (
    project TEXT NOT NULL,
    container TEXT NOT NULL,
    at INTEGER NOT NULL,
    restart_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wd_samples ON watchdog_container_samples(project, container, at);

  CREATE TABLE IF NOT EXISTS watchdog_conditions (
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (project, key)
  );

  CREATE TABLE IF NOT EXISTS watchdog_slo_status (
    project TEXT NOT NULL,
    detector TEXT NOT NULL,
    state TEXT NOT NULL,
    open_breaches INTEGER NOT NULL,
    detail TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (project, detector)
  );

  CREATE TABLE IF NOT EXISTS watchdog_breach_decisions (
    breach_id TEXT PRIMARY KEY REFERENCES watchdog_breaches(id),
    project TEXT NOT NULL,
    decision_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

interface BreachRow {
  id: string;
  project: string;
  detector: string;
  key: string;
  summary: string;
  evidence: string;
  vars: string;
  status: string;
  detected_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution: string | null;
  escalated_at: string | null;
}

interface RunRow {
  id: string;
  project: string;
  breach_id: string;
  playbook_id: string;
  mode: string;
  status: string;
  outcome: string | null;
  attempt: number;
  started_at: string;
  completed_at: string | null;
  steps: string;
  error: string | null;
}

interface EscalationRow {
  id: string;
  project: string;
  breach_id: string;
  created_at: string;
  file: string | null;
  text: string;
  suppressed: number;
}

interface SloRow {
  project: string;
  detector: string;
  state: string;
  open_breaches: number;
  detail: string;
  checked_at: string;
}

export class WatchdogStore {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ BREACHES ============

  createBreach(project: string, finding: Finding, at: string): Breach {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO watchdog_breaches
           (id, project, detector, key, summary, evidence, vars, status, detected_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        project,
        finding.detector,
        finding.key,
        finding.summary,
        JSON.stringify(finding.evidence),
        JSON.stringify(finding.vars),
        at,
        at,
      );
    return this.getBreach(id)!;
  }

  /** Refresh an open breach with the latest evidence. */
  touchBreach(id: string, finding: Finding, at: string): void {
    this.db
      .prepare(
        `UPDATE watchdog_breaches SET summary = ?, evidence = ?, vars = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(finding.summary, JSON.stringify(finding.evidence), JSON.stringify(finding.vars), at, id);
  }

  resolveBreach(id: string, resolution: BreachResolution, at: string): void {
    this.db
      .prepare(
        `UPDATE watchdog_breaches SET status = 'resolved', resolution = ?, resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(resolution, at, id);
  }

  markEscalated(id: string, at: string): void {
    this.db
      .prepare(`UPDATE watchdog_breaches SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL`)
      .run(at, id);
  }

  getBreach(id: string): Breach | null {
    const row = this.db.prepare(`SELECT * FROM watchdog_breaches WHERE id = ?`).get(id) as
      | BreachRow
      | undefined;
    return row ? toBreach(row) : null;
  }

  openBreaches(project: string): Breach[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_breaches WHERE project = ? AND status = 'open' ORDER BY detected_at, rowid`,
      )
      .all(project) as BreachRow[];
    return rows.map(toBreach);
  }

  listBreaches(
    project: string,
    options: { status?: BreachStatus | "all"; limit?: number } = {},
  ): Breach[] {
    const status = options.status ?? "all";
    const limit = options.limit ?? 100;
    const rows = (
      status === "all"
        ? this.db
            .prepare(
              `SELECT * FROM watchdog_breaches WHERE project = ? ORDER BY detected_at DESC, rowid DESC LIMIT ?`,
            )
            .all(project, limit)
        : this.db
            .prepare(
              `SELECT * FROM watchdog_breaches WHERE project = ? AND status = ? ORDER BY detected_at DESC, rowid DESC LIMIT ?`,
            )
            .all(project, status, limit)
    ) as BreachRow[];
    return rows.map(toBreach);
  }

  // ============ PLAYBOOK RUNS ============

  createRun(run: Omit<PlaybookRun, "id">): PlaybookRun {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO watchdog_runs
           (id, project, breach_id, playbook_id, mode, status, outcome, attempt, started_at, completed_at, steps, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.project,
        run.breachId,
        run.playbookId,
        run.mode,
        run.status,
        run.outcome ?? null,
        run.attempt,
        run.startedAt,
        run.completedAt ?? null,
        JSON.stringify(run.steps),
        run.error ?? null,
      );
    return this.getRun(id)!;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<PlaybookRun, "status" | "outcome" | "completedAt" | "steps" | "error">>,
  ): void {
    const run = this.getRun(id);
    if (!run) return;
    const next = { ...run, ...patch };
    this.db
      .prepare(
        `UPDATE watchdog_runs SET status = ?, outcome = ?, completed_at = ?, steps = ?, error = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.outcome ?? null,
        next.completedAt ?? null,
        JSON.stringify(next.steps),
        next.error ?? null,
        id,
      );
  }

  getRun(id: string): PlaybookRun | null {
    const row = this.db.prepare(`SELECT * FROM watchdog_runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return row ? toRun(row) : null;
  }

  /** A breach's runs, newest first. */
  runsForBreach(breachId: string): PlaybookRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_runs WHERE breach_id = ? ORDER BY started_at DESC, rowid DESC`)
      .all(breachId) as RunRow[];
    return rows.map(toRun);
  }

  /** A project's runs, newest first. */
  listRuns(project: string, options: { limit?: number } = {}): PlaybookRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_runs WHERE project = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(project, options.limit ?? 100) as RunRow[];
    return rows.map(toRun);
  }

  // ============ ESCALATIONS ============

  /** Record an escalation; false when the breach already has one. */
  recordEscalation(escalation: Omit<Escalation, "id">): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO watchdog_escalations (id, project, breach_id, created_at, file, text, suppressed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        escalation.project,
        escalation.breachId,
        escalation.createdAt,
        escalation.file ?? null,
        escalation.text,
        escalation.suppressed ? 1 : 0,
      );
    return result.changes > 0;
  }

  hasEscalation(breachId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM watchdog_escalations WHERE breach_id = ?`).get(breachId) !==
      undefined
    );
  }

  /** When a breach with this key was last escalated (not suppressed), or null. */
  lastEscalationForKey(project: string, key: string): string | null {
    const row = this.db
      .prepare(
        `SELECT e.created_at FROM watchdog_escalations e
         JOIN watchdog_breaches b ON b.id = e.breach_id
         WHERE e.project = ? AND b.key = ? AND e.suppressed = 0
         ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
      )
      .get(project, key) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  listEscalations(project: string, options: { limit?: number } = {}): Escalation[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, d.decision_id FROM watchdog_escalations e
         LEFT JOIN watchdog_breach_decisions d ON d.breach_id = e.breach_id
         WHERE e.project = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      )
      .all(project, options.limit ?? 100) as (EscalationRow & { decision_id: string | null })[];
    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      breachId: row.breach_id,
      createdAt: row.created_at,
      file: row.file ?? undefined,
      text: row.text,
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      suppressed: row.suppressed === 1,
    }));
  }

  // ============ DECISION INBOX ============

  /** Link a breach to the decision raised for it (replacing an earlier one), state open. */
  linkDecision(breachId: string, project: string, decisionId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO watchdog_breach_decisions (breach_id, project, decision_id, state, updated_at)
         VALUES (?, ?, ?, 'open', ?)
         ON CONFLICT(breach_id) DO UPDATE SET
           decision_id = excluded.decision_id, state = 'open', updated_at = excluded.updated_at`,
      )
      .run(breachId, project, decisionId, at);
  }

  breachDecision(breachId: string): BreachDecision | null {
    const row = this.db
      .prepare(`SELECT * FROM watchdog_breach_decisions WHERE breach_id = ?`)
      .get(breachId) as
      | { breach_id: string; project: string; decision_id: string; state: string; updated_at: string }
      | undefined;
    return row
      ? {
          breachId: row.breach_id,
          project: row.project,
          decisionId: row.decision_id,
          state: row.state as BreachDecisionState,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /**
   * Record the answer to a breach's open decision. Only an open link to this
   * decision changes, so a repeated delivery or an answer to a replaced
   * decision does nothing. True when it changed.
   */
  answerDecision(decisionId: string, state: BreachDecisionState, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE watchdog_breach_decisions SET state = ?, updated_at = ? WHERE decision_id = ? AND state = 'open'`,
        )
        .run(state, at, decisionId).changes > 0
    );
  }

  /** Move a breach's decision link from one state to another; true when it was in `from`. */
  moveDecision(breachId: string, from: BreachDecisionState, to: BreachDecisionState, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE watchdog_breach_decisions SET state = ?, updated_at = ? WHERE breach_id = ? AND state = ?`,
        )
        .run(to, at, breachId, from).changes > 0
    );
  }

  // ============ SAMPLES AND CONDITIONS ============

  addContainerSample(project: string, container: string, at: number, restartCount: number): void {
    this.db
      .prepare(
        `INSERT INTO watchdog_container_samples (project, container, at, restart_count) VALUES (?, ?, ?, ?)`,
      )
      .run(project, container, at, restartCount);
  }

  /** Samples taken at or after `sinceMs`, oldest first; older ones are deleted. */
  containerSamples(
    project: string,
    container: string,
    sinceMs: number,
  ): { at: number; restartCount: number }[] {
    this.db
      .prepare(`DELETE FROM watchdog_container_samples WHERE project = ? AND container = ? AND at < ?`)
      .run(project, container, sinceMs);
    const rows = this.db
      .prepare(
        `SELECT at, restart_count FROM watchdog_container_samples
         WHERE project = ? AND container = ? ORDER BY at, rowid`,
      )
      .all(project, container) as { at: number; restart_count: number }[];
    return rows.map((r) => ({ at: r.at, restartCount: r.restart_count }));
  }

  /**
   * Track how long a condition has held: returns when it first became true
   * (kept across restarts), or null after clearing it when it is false.
   */
  conditionSince(project: string, key: string, holds: boolean, now: number): number | null {
    if (!holds) {
      this.db.prepare(`DELETE FROM watchdog_conditions WHERE project = ? AND key = ?`).run(project, key);
      return null;
    }
    this.db
      .prepare(`INSERT OR IGNORE INTO watchdog_conditions (project, key, since) VALUES (?, ?, ?)`)
      .run(project, key, now);
    const row = this.db
      .prepare(`SELECT since FROM watchdog_conditions WHERE project = ? AND key = ?`)
      .get(project, key) as { since: number };
    return row.since;
  }

  // ============ SLO STATUS ============

  setSloStatus(project: string, statuses: SloStatus[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO watchdog_slo_status (project, detector, state, open_breaches, detail, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, detector) DO UPDATE SET
         state = excluded.state, open_breaches = excluded.open_breaches,
         detail = excluded.detail, checked_at = excluded.checked_at`,
    );
    const write = this.db.transaction((rows: SloStatus[]) => {
      for (const s of rows) {
        upsert.run(project, s.detector, s.state, s.openBreaches, s.detail, s.checkedAt);
      }
    });
    write(statuses);
  }

  sloStatus(project: string): SloStatus[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_slo_status WHERE project = ? ORDER BY rowid`)
      .all(project) as SloRow[];
    return rows.map((row) => ({
      detector: row.detector as DetectorId,
      state: row.state as SloState,
      openBreaches: row.open_breaches,
      detail: row.detail,
      checkedAt: row.checked_at,
    }));
  }
}

function toBreach(row: BreachRow): Breach {
  return {
    id: row.id,
    project: row.project,
    detector: row.detector as DetectorId,
    key: row.key,
    summary: row.summary,
    evidence: JSON.parse(row.evidence) as string[],
    vars: JSON.parse(row.vars) as Record<string, string>,
    status: row.status as BreachStatus,
    detectedAt: row.detected_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolution: (row.resolution as BreachResolution | null) ?? undefined,
    escalatedAt: row.escalated_at ?? undefined,
  };
}

function toRun(row: RunRow): PlaybookRun {
  return {
    id: row.id,
    project: row.project,
    breachId: row.breach_id,
    playbookId: row.playbook_id as PlaybookId,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    outcome: (row.outcome as RunOutcome | null) ?? undefined,
    attempt: row.attempt,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    steps: JSON.parse(row.steps) as StepResult[],
    error: row.error ?? undefined,
  };
}
