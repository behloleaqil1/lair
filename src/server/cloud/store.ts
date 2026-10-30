/**
 * Cloud store (data/cloud.db): the runs the meter counts (each launch and
 * stop the provider described), the provider's last cost reading per
 * account, and the guard's trips (each kept, with who cleared it). SQLite,
 * so the meter, the reading's cache (each read may cost money) and a trip
 * survive a restart. Times are the cloud Clock's milliseconds.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CloudProviderSpend } from "../../shared/cloud-types.js";
import type { CloudBudgetSettings, CloudMachineSettings } from "./config.js";
import type { StoredTrip } from "./guard.js";
import type { MeterRun } from "./meter.js";
import { STOPPED_STATES, type MachineDescription, type PowerState } from "./provider.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cloud_runs (
    project TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    machine TEXT NOT NULL,
    launched_at INTEGER NOT NULL,
    stopped_at INTEGER,
    stop_known INTEGER NOT NULL DEFAULT 0,
    price_per_hour REAL NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (project, instance_id, launched_at)
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_runs_open ON cloud_runs(project, instance_id, stopped_at);

  -- Each instance as Lair last saw it (a successful describe): what may have run unseen since is a gap
  CREATE TABLE IF NOT EXISTS cloud_seen (
    project TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    launched_at INTEGER NOT NULL,
    PRIMARY KEY (project, instance_id)
  );

  -- Time Lair did not see an instance that may have run: counted at its price (a short gap), or blind (a long one,
  -- or the time before Lair first saw it) until a cost reading covers it
  CREATE TABLE IF NOT EXISTS cloud_gaps (
    project TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    machine TEXT NOT NULL,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL,
    counted INTEGER NOT NULL,
    price_per_hour REAL NOT NULL,
    PRIMARY KEY (project, instance_id, from_ms)
  );

  CREATE TABLE IF NOT EXISTS cloud_spend (
    project TEXT NOT NULL,
    profile TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    state TEXT NOT NULL,
    amount REAL,
    detail TEXT,
    -- An "unknown" reading whose answer held no cost at all (not "no data yet")
    empty INTEGER NOT NULL DEFAULT 0,
    read_at INTEGER NOT NULL,
    -- Kept across readings and periods: the first reading ever, and the last one with an amount
    first_read_at INTEGER NOT NULL,
    amount_at INTEGER,
    PRIMARY KEY (project, profile)
  );

  CREATE TABLE IF NOT EXISTS cloud_trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    spend REAL NOT NULL,
    reason TEXT NOT NULL,
    tripped_at INTEGER NOT NULL,
    cleared_at INTEGER,
    cleared_by TEXT,
    clear_note TEXT
  );
  -- One trip stands per project until the owner clears it, whatever the limit or the period says now
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_trips_standing ON cloud_trips(project) WHERE cleared_at IS NULL;
`;

/** Runs that ended this long ago are dropped (a period is at most a few years) */
const RUN_RETENTION_MS = 3 * 366 * 86_400_000;
/**
 * A gap starts this long before the sighting it follows: a clock up to a
 * minute ahead of the provider's would otherwise make it short.
 */
const GAP_MARGIN_MS = 60_000;

/** Time Lair did not see an instance that may have run, which only a cost reading can cover */
export interface BlindWindow {
  machine: string;
  instanceId: string;
  /** 0: everything before the first sighting */
  from: number;
  to: number;
}

interface RunRow {
  machine: string;
  launched_at: number;
  stopped_at: number | null;
  price_per_hour: number;
}

interface SpendRow {
  profile: string;
  period_start: string;
  period_end: string;
  state: string;
  amount: number | null;
  detail: string | null;
  empty: number;
  read_at: number;
  first_read_at: number;
  amount_at: number | null;
}

/** A cost reading as read: what it says, and when */
export type SpendReadingRecord = Omit<CloudProviderSpend, "readAt"> & {
  readAtMs: number;
  /** An "unknown" whose answer held no cost at all */
  empty: boolean;
};

/** A cost reading as stored, with the account's history: its first reading ever and its last amount */
export type StoredSpend = CloudProviderSpend & {
  readAtMs: number | null;
  empty: boolean;
  firstReadAtMs: number | null;
  amountAtMs: number | null;
};

function toSpend(row: SpendRow): StoredSpend {
  const state = row.state === "amount" || row.state === "unknown" || row.state === "error" ? row.state : "error";
  return {
    profile: row.profile,
    state,
    amount: row.amount,
    detail: row.detail,
    readAt: new Date(row.read_at).toISOString(),
    readAtMs: row.read_at,
    empty: row.empty === 1,
    firstReadAtMs: row.first_read_at,
    amountAtMs: row.amount_at,
  };
}

export class CloudStore {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`${dbPath} has schema version ${version}, newer than this Lair (${SCHEMA_VERSION})`);
    }
    if (version < SCHEMA_VERSION) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ RUNS ============

  /**
   * Record what the provider said about a machine. Its last launch is a run;
   * while the machine is not stopped the run is open. A stop the provider
   * does not date is taken as the moment Lair first saw it stopped, and an
   * older run still open ends at the newer launch at the latest.
   *
   * Then what Lair did not see. The provider dates only the last launch, so
   * a launch newer than the one Lair saw last, after it last saw the machine
   * stopped, may hide runs between that sighting and the launch: a gap. A
   * gap up to `countUpToMs` long (about two checks) is counted at the
   * machine's price, as if it ran throughout; a longer one (Lair was down,
   * or describes failed) is blind: the guard refuses until a cost reading
   * covers it. The first sighting of an instance is blind up to its launch:
   * Lair can't know what ran before.
   */
  recordDescription(project: string, machine: CloudMachineSettings, desc: MachineDescription, now: number, countUpToMs: number): void {
    const launchedAt = desc.launchedAt;
    this.db.transaction(() => {
      const seen = this.db
        .prepare(`SELECT seen_at, state, launched_at FROM cloud_seen WHERE project = ? AND instance_id = ?`)
        .get(project, machine.instanceId) as { seen_at: number; state: string; launched_at: number } | undefined;
      let gap: { from: number; counted: boolean } | null = null;
      if (!seen) {
        gap = { from: 0, counted: false };
      } else if (launchedAt > seen.launched_at && STOPPED_STATES.has(seen.state as PowerState)) {
        const from = seen.seen_at - GAP_MARGIN_MS;
        if (launchedAt > from) gap = { from, counted: launchedAt - from <= countUpToMs };
      }
      if (gap) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO cloud_gaps (project, instance_id, machine, from_ms, to_ms, counted, price_per_hour)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(project, machine.instanceId, machine.id, gap.from, launchedAt, gap.counted ? 1 : 0, machine.pricePerHour);
      }
      this.db
        .prepare(
          `INSERT INTO cloud_seen (project, instance_id, seen_at, state, launched_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project, instance_id) DO UPDATE SET
             seen_at = excluded.seen_at, state = excluded.state, launched_at = MAX(launched_at, excluded.launched_at)`,
        )
        .run(project, machine.instanceId, now, desc.state, launchedAt);

      this.db
        .prepare(
          `UPDATE cloud_runs SET stopped_at = ?, stop_known = 0
           WHERE project = ? AND instance_id = ? AND stopped_at IS NULL AND launched_at < ?`,
        )
        .run(launchedAt, project, machine.instanceId, launchedAt);
      const row = this.db
        .prepare(`SELECT stopped_at, stop_known FROM cloud_runs WHERE project = ? AND instance_id = ? AND launched_at = ?`)
        .get(project, machine.instanceId, launchedAt) as { stopped_at: number | null; stop_known: number } | undefined;
      let stoppedAt: number | null = null;
      let stopKnown = 0;
      if (STOPPED_STATES.has(desc.state)) {
        if (desc.stoppedAt !== null && desc.stoppedAt >= launchedAt) {
          stoppedAt = desc.stoppedAt;
          stopKnown = 1;
        } else if (row && row.stopped_at !== null) {
          stoppedAt = row.stopped_at;
          stopKnown = row.stop_known;
        } else {
          stoppedAt = now;
        }
      }
      this.db
        .prepare(
          `INSERT INTO cloud_runs (project, instance_id, machine, launched_at, stopped_at, stop_known, price_per_hour, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, instance_id, launched_at) DO UPDATE SET
             machine = excluded.machine,
             stopped_at = excluded.stopped_at,
             stop_known = excluded.stop_known,
             price_per_hour = MAX(price_per_hour, excluded.price_per_hour),
             seen_at = excluded.seen_at`,
        )
        .run(project, machine.instanceId, machine.id, launchedAt, stoppedAt, stopKnown, machine.pricePerHour, now);
    })();
  }

  /** The runs of a project that overlap [startMs, endMs), counted gaps included (as runs from gap to launch) */
  runs(project: string, startMs: number, endMs: number): MeterRun[] {
    const rows = this.db
      .prepare(
        `SELECT machine, launched_at, stopped_at, price_per_hour FROM cloud_runs
         WHERE project = ? AND launched_at < ? AND (stopped_at IS NULL OR stopped_at > ?)
         UNION ALL
         SELECT machine, from_ms AS launched_at, to_ms AS stopped_at, price_per_hour FROM cloud_gaps
         WHERE project = ? AND counted = 1 AND from_ms < ? AND to_ms > ?
         ORDER BY launched_at`,
      )
      .all(project, endMs, startMs, project, endMs, startMs) as RunRow[];
    return rows.map((r) => ({
      machine: r.machine,
      launchedAt: r.launched_at,
      stoppedAt: r.stopped_at,
      pricePerHour: r.price_per_hour,
    }));
  }

  /** The blind gaps of a project that overlap [startMs, endMs): only a cost reading covers them */
  blindWindows(project: string, startMs: number, endMs: number): BlindWindow[] {
    const rows = this.db
      .prepare(
        `SELECT machine, instance_id, from_ms, to_ms FROM cloud_gaps
         WHERE project = ? AND counted = 0 AND from_ms < ? AND to_ms > ?
         ORDER BY to_ms`,
      )
      .all(project, endMs, startMs) as { machine: string; instance_id: string; from_ms: number; to_ms: number }[];
    return rows.map((r) => ({ machine: r.machine, instanceId: r.instance_id, from: r.from_ms, to: r.to_ms }));
  }

  /** Drop runs and gaps that ended long ago */
  pruneRuns(now: number): void {
    this.db.prepare(`DELETE FROM cloud_runs WHERE stopped_at IS NOT NULL AND stopped_at < ?`).run(now - RUN_RETENTION_MS);
    this.db.prepare(`DELETE FROM cloud_gaps WHERE to_ms < ?`).run(now - RUN_RETENTION_MS);
  }

  // ============ COST READINGS ============

  /** The last reading for this profile and period, or null */
  spend(project: string, profile: string, budget: CloudBudgetSettings): StoredSpend | null {
    const row = this.db
      .prepare(`SELECT * FROM cloud_spend WHERE project = ? AND profile = ?`)
      .get(project, profile) as SpendRow | undefined;
    if (!row || row.period_start !== budget.periodStart || row.period_end !== budget.periodEnd) return null;
    return toSpend(row);
  }

  /**
   * Keep a new reading, and answer it as stored: with the account's first
   * reading ever and its last amount, which outlive readings and periods.
   */
  saveSpend(project: string, budget: CloudBudgetSettings, reading: SpendReadingRecord): StoredSpend {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cloud_spend
             (project, profile, period_start, period_end, state, amount, detail, empty, read_at, first_read_at, amount_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, profile) DO UPDATE SET
             period_start = excluded.period_start, period_end = excluded.period_end, state = excluded.state,
             amount = excluded.amount, detail = excluded.detail, empty = excluded.empty, read_at = excluded.read_at,
             first_read_at = MIN(cloud_spend.first_read_at, excluded.first_read_at),
             amount_at = COALESCE(excluded.amount_at, cloud_spend.amount_at)`,
        )
        .run(
          project,
          reading.profile,
          budget.periodStart,
          budget.periodEnd,
          reading.state,
          reading.amount,
          reading.detail,
          reading.empty ? 1 : 0,
          reading.readAtMs,
          reading.readAtMs,
          reading.state === "amount" ? reading.readAtMs : null,
        );
      const row = this.db
        .prepare(`SELECT * FROM cloud_spend WHERE project = ? AND profile = ?`)
        .get(project, reading.profile) as SpendRow;
      return toSpend(row);
    })();
  }

  // ============ TRIPS ============

  /**
   * The trip that stands for the project: recorded and not cleared by the
   * owner. A new limit or period does not end it.
   */
  trip(project: string): StoredTrip | null {
    const row = this.db
      .prepare(
        `SELECT limit_amount, period_start, period_end, spend, reason, tripped_at FROM cloud_trips
         WHERE project = ? AND cleared_at IS NULL`,
      )
      .get(project) as TripRow | undefined;
    return row ? toTrip(row) : null;
  }

  /** Record a trip; while one stands it stays the only one. True when this one was new. */
  addTrip(project: string, budget: CloudBudgetSettings, spend: number, reason: string, now: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cloud_trips (project, limit_amount, period_start, period_end, spend, reason, tripped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, budget.limit, budget.periodStart, budget.periodEnd, spend, reason, now);
    return result.changes > 0;
  }

  /**
   * The owner clears the standing trip, named by when it tripped (so a
   * newer trip is never cleared by mistake). Kept with who cleared it,
   * when, and why. The trip, or null when no standing trip has that time.
   */
  clearTrip(project: string, trippedAt: number, by: string, note: string | null, now: number): StoredTrip | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, limit_amount, period_start, period_end, spend, reason, tripped_at FROM cloud_trips
           WHERE project = ? AND cleared_at IS NULL`,
        )
        .get(project) as (TripRow & { id: number }) | undefined;
      if (!row || row.tripped_at !== trippedAt) return null;
      this.db
        .prepare(`UPDATE cloud_trips SET cleared_at = ?, cleared_by = ?, clear_note = ? WHERE id = ?`)
        .run(now, by, note, row.id);
      return toTrip(row);
    })();
  }
}

interface TripRow {
  limit_amount: number;
  period_start: string;
  period_end: string;
  spend: number;
  reason: string;
  tripped_at: number;
}

function toTrip(row: TripRow): StoredTrip {
  return {
    limit: row.limit_amount,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    spend: row.spend,
    reason: row.reason,
    at: row.tripped_at,
  };
}
