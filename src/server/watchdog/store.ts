/**
 * Watchdog store - persistence for SLOs, breaches, and playbook runs
 */
import type Database from "better-sqlite3";
import type {
  SLODefinition,
  SLOState,
  SLOBreach,
  PlaybookRun,
  PlaybookRunStatus,
} from "./types.js";

/** Database row type for SLO definitions */
interface SLODefinitionRow {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  enabled: number;
  threshold: number;
  unit: string;
  type: string;
  condition: string | null;
  created_at: string;
  updated_at: string;
}

/** Database row type for SLO states */
interface SLOStateRow {
  slo_id: string;
  status: string;
  current_value: number;
  threshold: number;
  state_changed_at: string;
  evidence: string;
  last_checked_at: string;
}

/** Database row type for breaches */
interface SLOBreachRow {
  id: string;
  slo_id: string;
  detected_at: string;
  evidence: string;
  value: number;
  threshold: number;
  playbook_runs: string;
  resolved: number;
  resolved_at: string | null;
}

/** Database row type for playbook runs */
interface PlaybookRunRow {
  id: string;
  playbook_id: string;
  breach_id: string;
  status: string;
  attempt: number;
  started_at: string;
  completed_at: string | null;
  step_results: string;
  diagnosis: string | null;
  error: string | null;
}

/**
 * SQL for creating watchdog tables
 */
export const WATCHDOG_SCHEMA = `
  -- SLO definitions
  CREATE TABLE IF NOT EXISTS slo_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    project_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    threshold REAL NOT NULL,
    unit TEXT NOT NULL,
    type TEXT NOT NULL,
    condition TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SLO current state
  CREATE TABLE IF NOT EXISTS slo_states (
    slo_id TEXT PRIMARY KEY REFERENCES slo_definitions(id),
    status TEXT NOT NULL DEFAULT 'healthy',
    current_value REAL NOT NULL DEFAULT 0,
    threshold REAL NOT NULL,
    state_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    evidence TEXT NOT NULL DEFAULT '[]',
    last_checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SLO breaches
  CREATE TABLE IF NOT EXISTS slo_breaches (
    id TEXT PRIMARY KEY,
    slo_id TEXT NOT NULL REFERENCES slo_definitions(id),
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    evidence TEXT NOT NULL DEFAULT '[]',
    value REAL NOT NULL,
    threshold REAL NOT NULL,
    playbook_runs TEXT NOT NULL DEFAULT '[]',
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_breaches_slo ON slo_breaches(slo_id);
  CREATE INDEX IF NOT EXISTS idx_breaches_resolved ON slo_breaches(resolved);

  -- Playbook runs
  CREATE TABLE IF NOT EXISTS playbook_runs (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    breach_id TEXT NOT NULL REFERENCES slo_breaches(id),
    status TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    step_results TEXT NOT NULL DEFAULT '[]',
    diagnosis TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_breach ON playbook_runs(breach_id);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON playbook_runs(status);
`;

/**
 * Watchdog store operations
 */
export class WatchdogStore {
  constructor(private db: Database.Database) {}

  /**
   * Initialize schema
   */
  initialize(): void {
    this.db.exec(WATCHDOG_SCHEMA);
  }

  // ============ SLO Definitions ============

  /**
   * Create or update an SLO definition
   */
  upsertSLODefinition(slo: SLODefinition): void {
    const stmt = this.db.prepare(`
      INSERT INTO slo_definitions (id, name, description, project_id, enabled, threshold, unit, type, condition, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        project_id = excluded.project_id,
        enabled = excluded.enabled,
        threshold = excluded.threshold,
        unit = excluded.unit,
        type = excluded.type,
        condition = excluded.condition,
        updated_at = datetime('now')
    `);
    stmt.run(
      slo.id,
      slo.name,
      slo.description,
      slo.projectId,
      slo.enabled ? 1 : 0,
      slo.threshold,
      slo.unit,
      slo.type,
      slo.condition ?? null
    );
  }

  /**
   * Get an SLO definition by ID
   */
  getSLODefinition(id: string): SLODefinition | null {
    const row = this.db.prepare(`SELECT * FROM slo_definitions WHERE id = ?`).get(id) as SLODefinitionRow | undefined;
    if (!row) return null;
    return this.rowToSLODefinition(row);
  }

  /**
   * Get all SLO definitions
   */
  getAllSLODefinitions(): SLODefinition[] {
    const rows = this.db.prepare(`SELECT * FROM slo_definitions ORDER BY type, name`).all() as SLODefinitionRow[];
    return rows.map(this.rowToSLODefinition);
  }

  /**
   * Get enabled SLO definitions
   */
  getEnabledSLODefinitions(): SLODefinition[] {
    const rows = this.db.prepare(`SELECT * FROM slo_definitions WHERE enabled = 1 ORDER BY type, name`).all() as SLODefinitionRow[];
    return rows.map(this.rowToSLODefinition);
  }

  private rowToSLODefinition(row: SLODefinitionRow): SLODefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      projectId: row.project_id,
      enabled: row.enabled === 1,
      threshold: row.threshold,
      unit: row.unit as SLODefinition["unit"],
      type: row.type as SLODefinition["type"],
      condition: row.condition ?? undefined,
    };
  }

  // ============ SLO States ============

  /**
   * Update SLO state
   */
  updateSLOState(state: SLOState): void {
    const stmt = this.db.prepare(`
      INSERT INTO slo_states (slo_id, status, current_value, threshold, state_changed_at, evidence, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slo_id) DO UPDATE SET
        status = excluded.status,
        current_value = excluded.current_value,
        threshold = excluded.threshold,
        state_changed_at = CASE WHEN slo_states.status != excluded.status THEN excluded.state_changed_at ELSE slo_states.state_changed_at END,
        evidence = excluded.evidence,
        last_checked_at = excluded.last_checked_at
    `);
    stmt.run(
      state.sloId,
      state.status,
      state.currentValue,
      state.threshold,
      state.stateChangedAt,
      JSON.stringify(state.evidence),
      state.lastCheckedAt
    );
  }

  /**
   * Get SLO state by ID
   */
  getSLOState(sloId: string): SLOState | null {
    const row = this.db.prepare(`SELECT * FROM slo_states WHERE slo_id = ?`).get(sloId) as SLOStateRow | undefined;
    if (!row) return null;
    return this.rowToSLOState(row);
  }

  /**
   * Get all SLO states
   */
  getAllSLOStates(): SLOState[] {
    const rows = this.db.prepare(`SELECT * FROM slo_states`).all() as SLOStateRow[];
    return rows.map(this.rowToSLOState);
  }

  private rowToSLOState(row: SLOStateRow): SLOState {
    return {
      sloId: row.slo_id,
      status: row.status as SLOState["status"],
      currentValue: row.current_value,
      threshold: row.threshold,
      stateChangedAt: row.state_changed_at,
      evidence: JSON.parse(row.evidence),
      lastCheckedAt: row.last_checked_at,
    };
  }

  // ============ Breaches ============

  /**
   * Create a new breach
   */
  createBreach(breach: Omit<SLOBreach, "playbookRuns" | "resolved" | "resolvedAt">): SLOBreach {
    const stmt = this.db.prepare(`
      INSERT INTO slo_breaches (id, slo_id, detected_at, evidence, value, threshold)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      breach.id,
      breach.sloId,
      breach.detectedAt,
      JSON.stringify(breach.evidence),
      breach.value,
      breach.threshold
    );
    return this.getBreach(breach.id)!;
  }

  /**
   * Get a breach by ID
   */
  getBreach(id: string): SLOBreach | null {
    const row = this.db.prepare(`SELECT * FROM slo_breaches WHERE id = ?`).get(id) as SLOBreachRow | undefined;
    if (!row) return null;
    return this.rowToBreach(row);
  }

  /**
   * Get active (unresolved) breaches
   */
  getActiveBreaches(): SLOBreach[] {
    const rows = this.db.prepare(`SELECT * FROM slo_breaches WHERE resolved = 0 ORDER BY detected_at DESC`).all() as SLOBreachRow[];
    return rows.map(this.rowToBreach);
  }

  /**
   * Get breaches for an SLO
   */
  getBreachesForSLO(sloId: string, limit = 10): SLOBreach[] {
    const rows = this.db.prepare(`SELECT * FROM slo_breaches WHERE slo_id = ? ORDER BY detected_at DESC LIMIT ?`).all(sloId, limit) as SLOBreachRow[];
    return rows.map(this.rowToBreach);
  }

  /**
   * Add a playbook run to a breach
   */
  addPlaybookRunToBreach(breachId: string, runId: string): void {
    const breach = this.getBreach(breachId);
    if (!breach) return;
    const runs = [...breach.playbookRuns, runId];
    this.db.prepare(`UPDATE slo_breaches SET playbook_runs = ? WHERE id = ?`).run(JSON.stringify(runs), breachId);
  }

  /**
   * Resolve a breach
   */
  resolveBreach(id: string): void {
    this.db.prepare(`UPDATE slo_breaches SET resolved = 1, resolved_at = datetime('now') WHERE id = ?`).run(id);
  }

  private rowToBreach(row: SLOBreachRow): SLOBreach {
    return {
      id: row.id,
      sloId: row.slo_id,
      detectedAt: row.detected_at,
      evidence: JSON.parse(row.evidence),
      value: row.value,
      threshold: row.threshold,
      playbookRuns: JSON.parse(row.playbook_runs),
      resolved: row.resolved === 1,
      resolvedAt: row.resolved_at ?? undefined,
    };
  }

  // ============ Playbook Runs ============

  /**
   * Create a playbook run
   */
  createPlaybookRun(run: Omit<PlaybookRun, "stepResults" | "completedAt" | "diagnosis" | "error">): PlaybookRun {
    const stmt = this.db.prepare(`
      INSERT INTO playbook_runs (id, playbook_id, breach_id, status, attempt, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(run.id, run.playbookId, run.breachId, run.status, run.attempt, run.startedAt);
    return this.getPlaybookRun(run.id)!;
  }

  /**
   * Get a playbook run by ID
   */
  getPlaybookRun(id: string): PlaybookRun | null {
    const row = this.db.prepare(`SELECT * FROM playbook_runs WHERE id = ?`).get(id) as PlaybookRunRow | undefined;
    if (!row) return null;
    return this.rowToPlaybookRun(row);
  }

  /**
   * Update a playbook run
   */
  updatePlaybookRun(
    id: string,
    updates: Partial<Pick<PlaybookRun, "status" | "completedAt" | "stepResults" | "diagnosis" | "error">>
  ): void {
    const run = this.getPlaybookRun(id);
    if (!run) return;

    const newRun = { ...run, ...updates };
    this.db.prepare(`
      UPDATE playbook_runs SET
        status = ?,
        completed_at = ?,
        step_results = ?,
        diagnosis = ?,
        error = ?
      WHERE id = ?
    `).run(
      newRun.status,
      newRun.completedAt ?? null,
      JSON.stringify(newRun.stepResults),
      newRun.diagnosis ? JSON.stringify(newRun.diagnosis) : null,
      newRun.error ?? null,
      id
    );
  }

  /**
   * Get runs for a breach
   */
  getRunsForBreach(breachId: string): PlaybookRun[] {
    const rows = this.db.prepare(`SELECT * FROM playbook_runs WHERE breach_id = ? ORDER BY started_at DESC`).all(breachId) as PlaybookRunRow[];
    return rows.map(this.rowToPlaybookRun);
  }

  /**
   * Get recent playbook runs
   */
  getRecentRuns(limit = 20): PlaybookRun[] {
    const rows = this.db.prepare(`SELECT * FROM playbook_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as PlaybookRunRow[];
    return rows.map(this.rowToPlaybookRun);
  }

  /**
   * Get running playbook runs
   */
  getRunningRuns(): PlaybookRun[] {
    const rows = this.db.prepare(`SELECT * FROM playbook_runs WHERE status IN ('pending', 'running') ORDER BY started_at`).all() as PlaybookRunRow[];
    return rows.map(this.rowToPlaybookRun);
  }

  private rowToPlaybookRun(row: PlaybookRunRow): PlaybookRun {
    return {
      id: row.id,
      playbookId: row.playbook_id,
      breachId: row.breach_id,
      status: row.status as PlaybookRunStatus,
      attempt: row.attempt,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      stepResults: JSON.parse(row.step_results),
      diagnosis: row.diagnosis ? JSON.parse(row.diagnosis) : undefined,
      error: row.error ?? undefined,
    };
  }
}
