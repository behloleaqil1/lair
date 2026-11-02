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
import {
  ACTIVE_STATES,
  type AgentEvent,
  type AgentRun,
  type Claim,
  type SpendPending,
  type SpendRow,
  type UsageRecord,
} from "./types.js";
import type { ProcessOwner } from "./probes.js";

/**
 * 1: runs, claims, events, usage. 2: idx_agents_runs_task,
 * idx_agents_events_task and idx_agents_events_run (fill looks up a task's
 * runs, releases and claim releases on every check). 3: agents_hung_info.
 * 4: AI spend (docs/design/ai-spend.md §4.3): agents_spend (one row per
 * ended run), agents_spend_daily (the daily aggregates, written from the
 * spend API's PR on) and agents_spend_pending (runs that ended while
 * agents.spend was on whose row isn't written yet). Every statement is IF
 * NOT EXISTS, so running SCHEMA migrates any older version.
 */
export const SCHEMA_VERSION = 4;

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

  CREATE TABLE IF NOT EXISTS agents_hung_info (
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    task TEXT NOT NULL,
    last_lines TEXT NOT NULL,
    last_tool TEXT,
    hung_minutes INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (project, agent, task)
  );

  CREATE TABLE IF NOT EXISTS agents_spend (
    run_id TEXT PRIMARY KEY,
    project TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, chain_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    adapter TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
    started_at INTEGER, ended_at INTEGER NOT NULL, runtime_s INTEGER NOT NULL,
    class TEXT NOT NULL, reason TEXT NOT NULL,
    session_mode TEXT NOT NULL, reload INTEGER NOT NULL, lair_restart INTEGER NOT NULL,
    usage_source TEXT NOT NULL,
    input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
    tokens INTEGER,
    requests INTEGER, turns INTEGER,
    cost REAL, context_bytes INTEGER NOT NULL,
    pr INTEGER, head_sha TEXT,
    blocker_key TEXT,
    backfilled INTEGER NOT NULL DEFAULT 0,
    usage_recorded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_agents_spend_time ON agents_spend(project, ended_at);
  CREATE INDEX IF NOT EXISTS idx_agents_spend_task ON agents_spend(project, task, ended_at);

  CREATE TABLE IF NOT EXISTS agents_spend_daily (
    project TEXT NOT NULL, day TEXT NOT NULL,
    agent TEXT NOT NULL, origin TEXT NOT NULL, provider TEXT NOT NULL,
    class TEXT NOT NULL, reason TEXT NOT NULL,
    runs INTEGER NOT NULL, reloads INTEGER NOT NULL, lair_restarts INTEGER NOT NULL,
    requests INTEGER, turns INTEGER, minutes REAL NOT NULL,
    input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
    cost REAL,
    PRIMARY KEY (project, day, agent, origin, provider, class, reason)
  );

  CREATE TABLE IF NOT EXISTS agents_spend_pending (
    run_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    ended_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_spend_pending ON agents_spend_pending(project, ended_at);
`;

/** What spend sums can be grouped by, and the column each is (a fixed map: never a column name from a request) */
const SPEND_GROUP_COLUMNS = {
  project: "project",
  agent: "agent",
  task: "task",
  reason: "reason",
  origin: "origin",
  provider: "provider",
} as const;
export type SpendGroupColumn = keyof typeof SPEND_GROUP_COLUMNS;

/** Spend summed for one group, class and reason (numbers only; null where no run reported the unit) */
export interface SpendCell {
  g: string;
  class: string;
  reason: string;
  runs: number;
  reloads: number;
  lairRestarts: number;
  requests: number | null;
  turns: number | null;
  minutes: number;
  tokens: number | null;
  cost: number | null;
  reportedRuns: number;
}

export interface SpendTaskStreak {
  task: string;
  attempts: number;
  noResult: number;
  chains: number;
  firstEndedAt: number;
  lastEndedAt: number;
}

export interface SpendReviewHead {
  pr: number;
  head: string;
  runs: number;
  reviews: number;
  failed: number;
}

interface SpendRowDb {
  run_id: string;
  project: string;
  agent: string;
  task: string;
  chain_id: string;
  origin: string;
  adapter: string;
  provider: string;
  model: string | null;
  started_at: number | null;
  ended_at: number;
  runtime_s: number;
  class: string;
  reason: string;
  session_mode: string;
  reload: number;
  lair_restart: number;
  usage_source: string;
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  tokens: number | null;
  requests: number | null;
  turns: number | null;
  cost: number | null;
  context_bytes: number;
  pr: number | null;
  head_sha: string | null;
  blocker_key: string | null;
  backfilled: number;
  usage_recorded: number;
}

function toSpendRow(row: SpendRowDb): SpendRow {
  return {
    runId: row.run_id,
    project: row.project,
    agent: row.agent,
    task: row.task,
    chainId: row.chain_id,
    origin: row.origin as SpendRow["origin"],
    adapter: row.adapter,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    runtimeS: row.runtime_s,
    class: row.class as SpendRow["class"],
    reason: row.reason,
    sessionMode: row.session_mode as SpendRow["sessionMode"],
    reload: row.reload === 1,
    lairRestart: row.lair_restart === 1,
    usageSource: row.usage_source as SpendRow["usageSource"],
    inputTokens: row.input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    outputTokens: row.output_tokens,
    tokens: row.tokens,
    requests: row.requests,
    turns: row.turns,
    cost: row.cost,
    contextBytes: row.context_bytes,
    pr: row.pr,
    headSha: row.head_sha,
    blockerKey: row.blocker_key,
    backfilled: row.backfilled === 1,
    usageRecorded: row.usage_recorded === 1,
  };
}

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

interface HungInfoRow {
  project: string;
  agent: string;
  task: string;
  last_lines: string;
  last_tool: string | null;
  hung_minutes: number;
  recorded_at: number;
}

/** Info about a hung run, recorded for the next run to see. */
export interface HungInfo {
  project: string;
  agent: string;
  task: string;
  /** Cleaned last lines from the hung run's log (control chars removed, bounded) */
  lastLines: string;
  /** The last tool call the adapter's log shows, if any */
  lastTool: string | null;
  /** How many minutes the run was hung for */
  hungMinutes: number;
  recordedAt: number;
}

function toHungInfo(row: HungInfoRow): HungInfo {
  return {
    project: row.project,
    agent: row.agent,
    task: row.task,
    lastLines: row.last_lines,
    lastTool: row.last_tool,
    hungMinutes: row.hung_minutes,
    recordedAt: row.recorded_at,
  };
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

  /** Usage the ledger holds for one run (agents.usage_patterns rows): null when it holds none. */
  usageForRun(runId: string): { tokens: number; cost: number } | null {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM agents_usage WHERE run_id = ?`)
      .get(runId) as { n: number; tokens: number; cost: number };
    return row.n === 0 ? null : { tokens: row.tokens, cost: row.cost };
  }

  // ============ AI SPEND ============

  /**
   * A run ended while agents.spend was on: its spend row is owed. Kept until the row is written, so a restart
   * between the end and the next tick loses nothing. Idempotent per run.
   */
  markSpendPending(project: string, runId: string, endedAt: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO agents_spend_pending (run_id, project, ended_at) VALUES (?, ?, ?)`)
      .run(runId, project, endedAt);
  }

  /** Runs whose spend row is owed and may be tried at `now` (a failed one waits its backoff), the earliest end first. */
  pendingSpend(project: string, now: number, limit: number): SpendPending[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, ended_at, attempts FROM agents_spend_pending WHERE project = ? AND retry_at <= ?
         ORDER BY ended_at, run_id LIMIT ?`,
      )
      .all(project, now, limit) as { run_id: string; ended_at: number; attempts: number }[];
    return rows.map((row) => ({ runId: row.run_id, endedAt: row.ended_at, attempts: row.attempts }));
  }

  /** Writing a run's spend row failed: counted, with why (bounded), and not tried again before `retryAt`. */
  spendAttemptFailed(runId: string, error: string, retryAt: number): void {
    this.db
      .prepare(`UPDATE agents_spend_pending SET attempts = attempts + 1, last_error = ?, retry_at = ? WHERE run_id = ?`)
      .run(error.slice(0, 500), retryAt, runId);
  }

  dropSpendPending(runId: string): void {
    this.db.prepare(`DELETE FROM agents_spend_pending WHERE run_id = ?`).run(runId);
  }

  /**
   * One transaction: the run's spend row (usage_recorded = 1), its usage in the ledger (when `usage` is given and
   * the row is new) and the end of its pending mark. A row that exists already is left alone and nothing is added
   * to the ledger, so a retry or a restart never counts a run's usage twice. True when the row was written.
   */
  recordSpend(row: SpendRow, usage: UsageRecord | null): boolean {
    const tx = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO agents_spend (
             run_id, project, agent, task, chain_id, origin, adapter, provider, model,
             started_at, ended_at, runtime_s, class, reason, session_mode, reload, lair_restart,
             usage_source, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, tokens,
             requests, turns, cost, context_bytes, pr, head_sha, blocker_key, backfilled, usage_recorded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          row.runId,
          row.project,
          row.agent,
          row.task,
          row.chainId,
          row.origin,
          row.adapter,
          row.provider,
          row.model,
          row.startedAt,
          row.endedAt,
          row.runtimeS,
          row.class,
          row.reason,
          row.sessionMode,
          row.reload ? 1 : 0,
          row.lairRestart ? 1 : 0,
          row.usageSource,
          row.inputTokens,
          row.cacheWriteTokens,
          row.cacheReadTokens,
          row.outputTokens,
          row.tokens,
          row.requests,
          row.turns,
          row.cost,
          row.contextBytes,
          row.pr,
          row.headSha,
          row.blockerKey,
          row.backfilled ? 1 : 0,
        );
      const written = result.changes === 1;
      if (written && usage) this.addUsage(usage);
      this.dropSpendPending(row.runId);
      return written;
    });
    return tx.immediate();
  }

  getSpend(runId: string): SpendRow | null {
    const row = this.db.prepare(`SELECT * FROM agents_spend WHERE run_id = ?`).get(runId) as SpendRowDb | undefined;
    return row ? toSpendRow(row) : null;
  }

  /** A project's spend rows (one task's, with `task`), the latest end first. */
  listSpend(project: string, options: { since?: number; limit?: number; task?: string } = {}): SpendRow[] {
    const rows = (
      options.task === undefined
        ? this.db
            .prepare(`SELECT * FROM agents_spend WHERE project = ? AND ended_at >= ? ORDER BY ended_at DESC, rowid DESC LIMIT ?`)
            .all(project, options.since ?? 0, options.limit ?? 100)
        : this.db
            .prepare(`SELECT * FROM agents_spend WHERE project = ? AND task = ? AND ended_at >= ? ORDER BY ended_at DESC, rowid DESC LIMIT ?`)
            .all(project, options.task, options.since ?? 0, options.limit ?? 100)
    ) as SpendRowDb[];
    return rows.map(toSpendRow);
  }

  /** A task's spend rows that ended before `before` (not `runId`'s), the latest first. */
  taskSpendBefore(project: string, task: string, before: number, runId: string, limit: number): SpendRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agents_spend WHERE project = ? AND task = ? AND ended_at <= ? AND run_id != ?
         ORDER BY ended_at DESC, rowid DESC LIMIT ?`,
      )
      .all(project, task, before, runId, limit) as SpendRowDb[];
    return rows.map(toSpendRow);
  }

  /** Rows still `unclassified/pending` that ended since `since`, the latest first (their class waits on a record). */
  unclassifiedSpend(project: string, since: number, limit: number): SpendRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agents_spend WHERE project = ? AND ended_at >= ? AND class = 'unclassified' AND reason = 'pending'
         ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(project, since, limit) as SpendRowDb[];
    return rows.map(toSpendRow);
  }

  /** Give an `unclassified` row its class (once: a classified row is never changed). True when it changed. */
  classifySpend(runId: string, v: { class: SpendRow["class"]; reason: string; pr: number | null; headSha: string | null; blockerKey: string | null }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE agents_spend SET class = ?, reason = ?, pr = COALESCE(?, pr), head_sha = COALESCE(?, head_sha),
             blocker_key = COALESCE(?, blocker_key)
           WHERE run_id = ? AND class = 'unclassified'`,
        )
        .run(v.class, v.reason, v.pr, v.headSha, v.blockerKey, runId).changes === 1
    );
  }

  /**
   * Spend summed per group (`groupBy` a column of agents_spend), class and reason, over runs that ended in
   * [from, to); `skipAggregatedDays`: only the runs of days with no daily aggregate (a long window adds them to the
   * aggregates). Numbers only.
   */
  spendCells(project: string, from: number, to: number, groupBy: SpendGroupColumn, skipAggregatedDays = false): SpendCell[] {
    const column = SPEND_GROUP_COLUMNS[groupBy];
    const skip = skipAggregatedDays
      ? `AND NOT EXISTS (SELECT 1 FROM agents_spend_daily d WHERE d.project = s.project
           AND d.day = strftime('%Y-%m-%d', s.ended_at / 1000, 'unixepoch'))`
      : "";
    return this.db
      .prepare(
        `SELECT ${column} AS g, class, reason, COUNT(*) AS runs, SUM(reload) AS reloads, SUM(lair_restart) AS lairRestarts,
           SUM(requests) AS requests, SUM(turns) AS turns, SUM(runtime_s) / 60.0 AS minutes, SUM(tokens) AS tokens,
           SUM(cost) AS cost, SUM(usage_source = 'reported') AS reportedRuns
         FROM agents_spend s WHERE project = ? AND ended_at >= ? AND ended_at < ? ${skip}
         GROUP BY g, class, reason`,
      )
      .all(project, from, to) as SpendCell[];
  }

  /** The daily aggregates summed the same way, for days in [fromDay, toDay) ("YYYY-MM-DD"); no per-task detail. */
  spendDailyCells(project: string, fromDay: string, toDay: string, groupBy: Exclude<SpendGroupColumn, "task">): SpendCell[] {
    const column = SPEND_GROUP_COLUMNS[groupBy];
    return this.db
      .prepare(
        `SELECT ${column} AS g, class, reason, SUM(runs) AS runs, SUM(reloads) AS reloads, SUM(lair_restarts) AS lairRestarts,
           SUM(requests) AS requests, SUM(turns) AS turns, SUM(minutes) AS minutes,
           SUM(COALESCE(input_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0))
             * (CASE WHEN COUNT(input_tokens) + COUNT(cache_write_tokens) + COUNT(output_tokens) > 0 THEN 1 ELSE NULL END) AS tokens,
           SUM(cost) AS cost, SUM(CASE WHEN cost IS NOT NULL OR input_tokens IS NOT NULL THEN runs ELSE 0 END) AS reportedRuns
         FROM agents_spend_daily WHERE project = ? AND day >= ? AND day < ?
         GROUP BY g, class, reason`,
      )
      .all(project, fromDay, toDay) as SpendCell[];
  }

  /**
   * The tasks with the most attempts since their last completion (a DONE or READY run, or any productive run of a
   * module's task), over runs that ended in [from, to), at least `min` of them.
   */
  spendTaskStreaks(project: string, from: number, to: number, min: number, limit: number): SpendTaskStreak[] {
    return this.db
      .prepare(
        `SELECT task, COUNT(*) AS attempts, SUM(class = 'no_result') AS noResult, COUNT(DISTINCT chain_id) AS chains,
           MIN(ended_at) AS firstEndedAt, MAX(ended_at) AS lastEndedAt
         FROM agents_spend s WHERE project = ? AND ended_at >= ? AND ended_at < ?
           AND NOT EXISTS (SELECT 1 FROM agents_spend c WHERE c.project = s.project AND c.task = s.task
             AND c.ended_at >= s.ended_at AND c.class = 'productive'
             AND (c.reason IN ('done', 'ready') OR c.origin IN ('review', 'planner', 'verifier', 'supervisor')))
         GROUP BY task HAVING COUNT(*) >= ? ORDER BY attempts DESC, lastEndedAt DESC LIMIT ?`,
      )
      .all(project, from, to, min, limit) as SpendTaskStreak[];
  }

  /** When the task's last completion (as spendTaskStreaks counts one) ended, or null. */
  lastSpendCompletion(project: string, task: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(ended_at) AS at FROM agents_spend WHERE project = ? AND task = ? AND class = 'productive'
           AND (reason IN ('done', 'ready') OR origin IN ('review', 'planner', 'verifier', 'supervisor'))`,
      )
      .get(project, task) as { at: number | null };
    return row.at;
  }

  /** Review runs per PR head ([from, to)) for heads with more than one: runs, reviews recorded, failed runs. */
  spendReviewHeads(project: string, from: number, to: number, limit: number): SpendReviewHead[] {
    return this.db
      .prepare(
        `SELECT pr, substr(head_sha, 1, 8) AS head, COUNT(*) AS runs, SUM(reason = 'review_recorded') AS reviews,
           SUM(class = 'no_result') AS failed
         FROM agents_spend WHERE project = ? AND origin = 'review' AND pr IS NOT NULL AND head_sha IS NOT NULL
           AND ended_at >= ? AND ended_at < ?
         GROUP BY pr, head HAVING COUNT(*) > 1 ORDER BY runs DESC, pr DESC LIMIT ?`,
      )
      .all(project, from, to, limit) as SpendReviewHead[];
  }

  /** guard_would and guard_did events in [from, to), per guard (data.guard). */
  guardCounts(project: string, from: number, to: number): { kind: "guard_would" | "guard_did"; guard: string | null; n: number }[] {
    return this.db
      .prepare(
        `SELECT kind, json_extract(data, '$.guard') AS guard, COUNT(*) AS n FROM agents_events
         WHERE project = ? AND at >= ? AND at < ? AND kind IN ('guard_would', 'guard_did') GROUP BY kind, guard`,
      )
      .all(project, from, to) as { kind: "guard_would" | "guard_did"; guard: string | null; n: number }[];
  }

  /**
   * Write one UTC day's aggregates again from its per-run rows (`day` "YYYY-MM-DD", from `start` ms for 24 h): the
   * day's old aggregate rows go first, so a group whose rows were classified since doesn't stay. Idempotent.
   * `deleteRuns`: the day's per-run rows go in the same transaction (retention), so a day is never half deleted.
   * The runs it summed (and deleted).
   */
  aggregateSpendDay(project: string, day: string, start: number, deleteRuns: boolean): number {
    const tx = this.db.transaction((): number => {
      const end = start + 86_400_000;
      const runs = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM agents_spend WHERE project = ? AND ended_at >= ? AND ended_at < ?`).get(project, start, end) as {
          n: number;
        }
      ).n;
      if (runs === 0 && deleteRuns) return 0;
      this.db.prepare(`DELETE FROM agents_spend_daily WHERE project = ? AND day = ?`).run(project, day);
      this.db
        .prepare(
          `INSERT INTO agents_spend_daily (project, day, agent, origin, provider, class, reason, runs, reloads, lair_restarts,
             requests, turns, minutes, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost)
           SELECT project, ?, agent, origin, provider, class, reason, COUNT(*), SUM(reload), SUM(lair_restart),
             SUM(requests), SUM(turns), SUM(runtime_s) / 60.0, SUM(input_tokens), SUM(cache_write_tokens),
             SUM(cache_read_tokens), SUM(output_tokens), SUM(cost)
           FROM agents_spend WHERE project = ? AND ended_at >= ? AND ended_at < ?
           GROUP BY agent, origin, provider, class, reason`,
        )
        .run(day, project, start, end);
      if (deleteRuns) this.db.prepare(`DELETE FROM agents_spend WHERE project = ? AND ended_at >= ? AND ended_at < ?`).run(project, start, end);
      return runs;
    });
    return tx.immediate();
  }

  /** The earliest end of a per-run row before `before`, or null (the next day retention prunes). */
  oldestSpendBefore(project: string, before: number): number | null {
    const row = this.db.prepare(`SELECT MIN(ended_at) AS at FROM agents_spend WHERE project = ? AND ended_at < ?`).get(project, before) as {
      at: number | null;
    };
    return row.at;
  }

  /** Delete the daily aggregates of days before `day`. The rows deleted. */
  pruneSpendDaily(project: string, day: string): number {
    return this.db.prepare(`DELETE FROM agents_spend_daily WHERE project = ? AND day < ?`).run(project, day).changes;
  }

  /** Ended runs requested in [from, to), after (requestedAt, id) for paging, oldest first: the backfill's input. */
  runsRequestedBetween(project: string, from: number, to: number, after: { requestedAt: number; id: string } | null, limit: number): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT data FROM agents_runs WHERE project = ? AND requested_at >= ? AND requested_at < ?
           AND (requested_at > ? OR (requested_at = ? AND id > ?))
         ORDER BY requested_at, id LIMIT ?`,
      )
      .all(project, from, to, after?.requestedAt ?? -1, after?.requestedAt ?? -1, after?.id ?? "", limit) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as AgentRun);
  }

  // ============ HUNG INFO ============

  /** Record hung run info for the next run to see. */
  recordHungInfo(info: HungInfo): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agents_hung_info
           (project, agent, task, last_lines, last_tool, hung_minutes, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(info.project, info.agent, info.task, info.lastLines, info.lastTool ?? null, info.hungMinutes, info.recordedAt);
  }

  /** Get hung info for an agent+task pair; null if none or cleared. */
  getHungInfo(project: string, agent: string, task: string): HungInfo | null {
    const row = this.db
      .prepare(`SELECT * FROM agents_hung_info WHERE project = ? AND agent = ? AND task = ?`)
      .get(project, agent, task) as HungInfoRow | undefined;
    return row ? toHungInfo(row) : null;
  }

  /** Clear hung info after a normal completion. */
  clearHungInfo(project: string, agent: string, task: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM agents_hung_info WHERE project = ? AND agent = ? AND task = ?`)
      .run(project, agent, task);
    return result.changes > 0;
  }
}
