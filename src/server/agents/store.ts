/**
 * Agents store: runs, claims, events (recoveries, lock breaks, failovers,
 * budget alerts, raised decisions) and the usage ledger. SQLite
 * (data/agents.db), so all of it survives a restart.
 *
 * A claim is one row per (project, task). Claiming runs in an IMMEDIATE
 * transaction, so two servers on one database can't both win: the second
 * sees the first's row and is refused while its owner is alive.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { AgentEventKind, AgentRunState } from "../../shared/agents-types.js";
import { ACTIVE_STATES, type AgentEvent, type AgentRun, type Claim, type UsageRecord } from "./types.js";
import type { ProcessOwner } from "./probes.js";

/**
 * 1: runs, claims, events, usage. 2: idx_agents_runs_task,
 * idx_agents_events_task and idx_agents_events_run (fill looks up a task's
 * runs, releases and claim releases on every check). Every statement is IF
 * NOT EXISTS, so running SCHEMA migrates any older version.
 */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents_runs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    agent TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    state TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agents_runs_state ON agents_runs(project, state);
  CREATE INDEX IF NOT EXISTS idx_agents_runs_agent ON agents_runs(project, agent, requested_at);
  CREATE INDEX IF NOT EXISTS idx_agents_runs_chain ON agents_runs(chain_id);
  CREATE INDEX IF NOT EXISTS idx_agents_runs_task ON agents_runs(project, task, requested_at);

  CREATE TABLE IF NOT EXISTS agents_claims (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    run_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_started_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (project, task)
  );

  CREATE TABLE IF NOT EXISTS agents_events (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT,
    task TEXT,
    run_id TEXT,
    subject TEXT,
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL,
    data TEXT NOT NULL,
    dedupe_key TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agents_events_project ON agents_events(project, at);
  CREATE INDEX IF NOT EXISTS idx_agents_events_task ON agents_events(project, task, kind, at);
  CREATE INDEX IF NOT EXISTS idx_agents_events_run ON agents_events(project, run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_events_dedupe
    ON agents_events(project, dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS agents_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    agent TEXT,
    provider TEXT NOT NULL,
    run_id TEXT,
    tokens INTEGER NOT NULL,
    cost REAL NOT NULL,
    at INTEGER NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_usage ON agents_usage(project, at);
`;

interface ClaimRow {
  project: string;
  task: string;
  run_id: string;
  agent: string;
  owner_pid: number;
  owner_started_at: number;
  claimed_at: number;
}

interface EventRow {
  id: string;
  project: string;
  kind: string;
  agent: string | null;
  task: string | null;
  run_id: string | null;
  subject: string | null;
  summary: string;
  evidence: string;
  data: string;
  dedupe_key: string | null;
  at: number;
}

function toClaim(row: ClaimRow): Claim {
  return {
    project: row.project,
    task: row.task,
    runId: row.run_id,
    agent: row.agent,
    ownerPid: row.owner_pid,
    ownerStartedAt: row.owner_started_at,
    claimedAt: row.claimed_at,
  };
}

function toEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind as AgentEventKind,
    agent: row.agent ?? undefined,
    task: row.task ?? undefined,
    runId: row.run_id ?? undefined,
    subject: row.subject ?? undefined,
    summary: row.summary,
    evidence: JSON.parse(row.evidence) as string[],
    data: JSON.parse(row.data) as Record<string, unknown>,
    dedupeKey: row.dedupe_key ?? undefined,
    at: row.at,
  };
}

export type ClaimResult =
  | { ok: true; claim: Claim; replaced?: Claim }
  | { ok: false; holder: Claim };

const ACTIVE_SQL = ACTIVE_STATES.map((s) => `'${s}'`).join(", ");

export class AgentsStore {
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
      this.db.pragma("busy_timeout = 5000");
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

  // ============ RUNS ============

  insertRun(run: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agents_runs (id, project, task, agent, chain_id, state, requested_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.project, run.task, run.agent, run.chainId, run.state, run.requestedAt, JSON.stringify(run));
  }

  saveRun(run: AgentRun): void {
    this.db
      .prepare(`UPDATE agents_runs SET state = ?, data = ? WHERE id = ?`)
      .run(run.state, JSON.stringify(run), run.id);
  }

  getRun(id: string): AgentRun | null {
    const row = this.db.prepare(`SELECT data FROM agents_runs WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as AgentRun) : null;
  }

  private runs(sql: string, ...params: (string | number)[]): AgentRun[] {
    const rows = this.db.prepare(sql).all(...params) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as AgentRun);
  }

  /** Runs still in progress, oldest request first. */
  activeRuns(project: string): AgentRun[] {
    return this.runs(
      `SELECT data FROM agents_runs WHERE project = ? AND state IN (${ACTIVE_SQL}) ORDER BY requested_at, rowid`,
      project,
    );
  }

  activeRunForAgent(project: string, agent: string): AgentRun | null {
    return (
      this.runs(
        `SELECT data FROM agents_runs WHERE project = ? AND agent = ? AND state IN (${ACTIVE_SQL})
         ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
        project,
        agent,
      )[0] ?? null
    );
  }

  latestRunForAgent(project: string, agent: string): AgentRun | null {
    return (
      this.runs(
        `SELECT data FROM agents_runs WHERE project = ? AND agent = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
        project,
        agent,
      )[0] ?? null
    );
  }

  /** A task's newest run (of any agent). */
  latestRunForTask(project: string, task: string): AgentRun | null {
    return (
      this.runs(
        `SELECT data FROM agents_runs WHERE project = ? AND task = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
        project,
        task,
      )[0] ?? null
    );
  }

  /** The first run of `agent` on another task than `task` requested after the run `after`, or null. */
  firstRunForAgentAfter(project: string, agent: string, task: string, after: AgentRun): AgentRun | null {
    return (
      this.runs(
        `SELECT data FROM agents_runs WHERE project = ? AND agent = ? AND task != ?
           AND (requested_at > ? OR (requested_at = ? AND rowid > (SELECT rowid FROM agents_runs WHERE id = ?)))
         ORDER BY requested_at, rowid LIMIT 1`,
        project,
        agent,
        task,
        after.requestedAt,
        after.requestedAt,
        after.id,
      )[0] ?? null
    );
  }

  /** The first runs of a task's newest chains (a chain's id is its first run's), newest first. */
  chainHeadsForTask(project: string, task: string, limit: number): AgentRun[] {
    return this.runs(
      `SELECT data FROM agents_runs WHERE project = ? AND task = ? AND id = chain_id
       ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
      project,
      task,
      limit,
    );
  }

  /** A chain's runs, first attempt first. */
  chainRuns(chainId: string): AgentRun[] {
    return this.runs(`SELECT data FROM agents_runs WHERE chain_id = ? ORDER BY requested_at, rowid`, chainId);
  }

  /** A project's runs, newest first. */
  listRuns(project: string, options: { limit?: number; state?: AgentRunState } = {}): AgentRun[] {
    const limit = options.limit ?? 100;
    return options.state
      ? this.runs(
          `SELECT data FROM agents_runs WHERE project = ? AND state = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
          project,
          options.state,
          limit,
        )
      : this.runs(
          `SELECT data FROM agents_runs WHERE project = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
          project,
          limit,
        );
  }

  /** Agent ids that have runs in a project. */
  runAgents(project: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT agent FROM agents_runs WHERE project = ? ORDER BY agent`)
      .all(project) as { agent: string }[];
    return rows.map((row) => row.agent);
  }

  // ============ CLAIMS ============

  getClaim(project: string, task: string): Claim | null {
    const row = this.db
      .prepare(`SELECT * FROM agents_claims WHERE project = ? AND task = ?`)
      .get(project, task) as ClaimRow | undefined;
    return row ? toClaim(row) : null;
  }

  listClaims(project: string): Claim[] {
    const rows = this.db
      .prepare(`SELECT * FROM agents_claims WHERE project = ? ORDER BY claimed_at, task`)
      .all(project) as ClaimRow[];
    return rows.map(toClaim);
  }

  /**
   * Claim a task for a run, owned by `owner`. Refused while another run's
   * claim has a live owner (`isAlive`). A claim whose owner is dead is
   * replaced and returned as `replaced`, also when it is the same run's
   * (its previous owner, a server that stopped, is gone). Re-claiming by the
   * same run from a live owner just updates the owner.
   */
  claim(
    project: string,
    task: string,
    runId: string,
    agent: string,
    owner: ProcessOwner,
    at: number,
    isAlive: (pid: number, startedAt: number) => boolean,
  ): ClaimResult {
    const tx = this.db.transaction((): ClaimResult => {
      const existing = this.getClaim(project, task);
      if (existing && existing.runId !== runId && isAlive(existing.ownerPid, existing.ownerStartedAt)) {
        return { ok: false, holder: existing };
      }
      this.db
        .prepare(
          `INSERT INTO agents_claims (project, task, run_id, agent, owner_pid, owner_started_at, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, task) DO UPDATE SET
             claimed_at = CASE WHEN agents_claims.run_id = excluded.run_id
                               THEN agents_claims.claimed_at ELSE excluded.claimed_at END,
             run_id = excluded.run_id, agent = excluded.agent, owner_pid = excluded.owner_pid,
             owner_started_at = excluded.owner_started_at`,
        )
        .run(project, task, runId, agent, owner.pid, owner.startedAt, at);
      const claim = this.getClaim(project, task)!;
      const replaced =
        existing !== null &&
        (existing.runId !== runId ||
          ((existing.ownerPid !== owner.pid || existing.ownerStartedAt !== owner.startedAt) &&
            !isAlive(existing.ownerPid, existing.ownerStartedAt)));
      return replaced && existing ? { ok: true, claim, replaced: existing } : { ok: true, claim };
    });
    return tx.immediate();
  }

  /**
   * Hand a claim from one run to the next (a restart) or to a new owner
   * process. False when `fromRunId` no longer holds it.
   */
  transferClaim(project: string, task: string, fromRunId: string, toRunId: string, owner: ProcessOwner): boolean {
    const result = this.db
      .prepare(
        `UPDATE agents_claims SET run_id = ?, owner_pid = ?, owner_started_at = ?
         WHERE project = ? AND task = ? AND run_id = ?`,
      )
      .run(toRunId, owner.pid, owner.startedAt, project, task, fromRunId);
    return result.changes === 1;
  }

  /** Release a claim; only when `runId` holds it, if given. True when one was removed. */
  releaseClaim(project: string, task: string, runId?: string): boolean {
    const result =
      runId === undefined
        ? this.db.prepare(`DELETE FROM agents_claims WHERE project = ? AND task = ?`).run(project, task)
        : this.db
            .prepare(`DELETE FROM agents_claims WHERE project = ? AND task = ? AND run_id = ?`)
            .run(project, task, runId);
    return result.changes > 0;
  }

  // ============ EVENTS ============

  /** Record an event. With a dedupeKey already recorded, nothing is written and null is returned. */
  addEvent(event: Omit<AgentEvent, "id">): AgentEvent | null {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agents_events
           (id, project, kind, agent, task, run_id, subject, summary, evidence, data, dedupe_key, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.project,
        event.kind,
        event.agent ?? null,
        event.task ?? null,
        event.runId ?? null,
        event.subject ?? null,
        event.summary,
        JSON.stringify(event.evidence),
        JSON.stringify(event.data),
        event.dedupeKey ?? null,
        event.at,
      );
    return result.changes === 1 ? { ...event, id } : null;
  }

  hasEvent(project: string, dedupeKey: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM agents_events WHERE project = ? AND dedupe_key = ?`)
        .get(project, dedupeKey) !== undefined
    );
  }

  /** The event recorded with this dedupe key, or null. */
  getEventByKey(project: string, dedupeKey: string): AgentEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM agents_events WHERE project = ? AND dedupe_key = ?`)
      .get(project, dedupeKey) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  /** A project's events, newest first. */
  listEvents(
    project: string,
    options: {
      kinds?: readonly AgentEventKind[];
      agent?: string;
      task?: string;
      runId?: string;
      subject?: string;
      since?: number;
      limit?: number;
    } = {},
  ): AgentEvent[] {
    const where = ["project = ?"];
    const params: (string | number)[] = [project];
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }
    if (options.agent !== undefined) {
      where.push("agent = ?");
      params.push(options.agent);
    }
    if (options.task !== undefined) {
      where.push("task = ?");
      params.push(options.task);
    }
    if (options.runId !== undefined) {
      where.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.subject !== undefined) {
      where.push("subject = ?");
      params.push(options.subject);
    }
    if (options.since !== undefined) {
      where.push("at >= ?");
      params.push(options.since);
    }
    params.push(options.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM agents_events WHERE ${where.join(" AND ")} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(...params) as EventRow[];
    return rows.map(toEvent);
  }

  countEvents(project: string, kind: AgentEventKind, subject?: string): number {
    const row = (
      subject === undefined
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM agents_events WHERE project = ? AND kind = ?`).get(project, kind)
        : this.db
            .prepare(`SELECT COUNT(*) AS n FROM agents_events WHERE project = ? AND kind = ? AND subject = ?`)
            .get(project, kind, subject)
    ) as { n: number };
    return row.n;
  }

  // ============ USAGE ============

  addUsage(usage: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents_usage (project, agent, provider, run_id, tokens, cost, at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.project,
        usage.agent ?? null,
        usage.provider,
        usage.runId ?? null,
        Math.round(usage.tokens),
        usage.cost,
        usage.at,
        usage.reason ?? null,
      );
  }

  /** Tokens and cost since `since` for a project, or one agent in it. */
  usageSince(project: string, agent: string | null, since: number): { tokens: number; cost: number } {
    const row = (
      agent === null
        ? this.db
            .prepare(
              `SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
               FROM agents_usage WHERE project = ? AND at >= ?`,
            )
            .get(project, since)
        : this.db
            .prepare(
              `SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
               FROM agents_usage WHERE project = ? AND agent = ? AND at >= ?`,
            )
            .get(project, agent, since)
    ) as { tokens: number; cost: number };
    return { tokens: row.tokens, cost: row.cost };
  }
}
