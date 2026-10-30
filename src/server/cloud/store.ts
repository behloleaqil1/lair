/**
 * Cloud store (data/cloud.db): the runs the meter counts (each launch and
 * stop the provider described), the provider's last cost reading per
 * account, and the guard's trips. SQLite, so the meter, the reading's cache
 * (each read may cost money) and a trip survive a restart. Times are the
 * cloud Clock's milliseconds.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CloudProviderSpend } from "../../shared/cloud-types.js";
import type { CloudBudgetSettings, CloudMachineSettings } from "./config.js";
import type { StoredTrip } from "./guard.js";
import type { MeterRun } from "./meter.js";
import { STOPPED_STATES, type MachineDescription } from "./provider.js";

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

  CREATE TABLE IF NOT EXISTS cloud_spend (
    project TEXT NOT NULL,
    profile TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    state TEXT NOT NULL,
    amount REAL,
    detail TEXT,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (project, profile)
  );

  CREATE TABLE IF NOT EXISTS cloud_trips (
    project TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    spend REAL NOT NULL,
    reason TEXT NOT NULL,
    tripped_at INTEGER NOT NULL,
    PRIMARY KEY (project, limit_amount, period_start, period_end)
  );
`;

/** Runs that ended this long ago are dropped (a period is at most a few years) */
const RUN_RETENTION_MS = 3 * 366 * 86_400_000;

interface RunRow {
  machine: string;
  launched_at: number;
  stopped_at: number | null;
  stop_known: number;
  price_per_hour: number;
}

interface SpendRow {
  profile: string;
  period_start: string;
  period_end: string;
  state: string;
  amount: number | null;
  detail: string | null;
  read_at: number;
}

export type StoredSpend = CloudProviderSpend & { readAtMs: number | null };

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
   */
  recordDescription(project: string, machine: CloudMachineSettings, desc: MachineDescription, now: number): void {
    const launchedAt = desc.launchedAt;
    if (launchedAt === null) return;
    this.db.transaction(() => {
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

  /** The runs of a project that overlap [startMs, endMs) */
  runs(project: string, startMs: number, endMs: number): MeterRun[] {
    const rows = this.db
      .prepare(
        `SELECT machine, launched_at, stopped_at, stop_known, price_per_hour FROM cloud_runs
         WHERE project = ? AND launched_at < ? AND (stopped_at IS NULL OR stopped_at > ?)
         ORDER BY launched_at`,
      )
      .all(project, endMs, startMs) as RunRow[];
    return rows.map((r) => ({
      machine: r.machine,
      launchedAt: r.launched_at,
      stoppedAt: r.stopped_at,
      pricePerHour: r.price_per_hour,
    }));
  }

  /** Drop runs that ended long ago */
  pruneRuns(now: number): void {
    this.db.prepare(`DELETE FROM cloud_runs WHERE stopped_at IS NOT NULL AND stopped_at < ?`).run(now - RUN_RETENTION_MS);
  }

  // ============ COST READINGS ============

  /** The last reading for this profile and period, or null */
  spend(project: string, profile: string, budget: CloudBudgetSettings): StoredSpend | null {
    const row = this.db
      .prepare(`SELECT * FROM cloud_spend WHERE project = ? AND profile = ?`)
      .get(project, profile) as SpendRow | undefined;
    if (!row || row.period_start !== budget.periodStart || row.period_end !== budget.periodEnd) return null;
    const state = row.state === "amount" || row.state === "unknown" || row.state === "error" ? row.state : "error";
    return {
      profile: row.profile,
      state,
      amount: row.amount,
      detail: row.detail,
      readAt: new Date(row.read_at).toISOString(),
      readAtMs: row.read_at,
    };
  }

  saveSpend(project: string, budget: CloudBudgetSettings, reading: StoredSpend): void {
    this.db
      .prepare(
        `INSERT INTO cloud_spend (project, profile, period_start, period_end, state, amount, detail, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, profile) DO UPDATE SET
           period_start = excluded.period_start, period_end = excluded.period_end, state = excluded.state,
           amount = excluded.amount, detail = excluded.detail, read_at = excluded.read_at`,
      )
      .run(
        project,
        reading.profile,
        budget.periodStart,
        budget.periodEnd,
        reading.state,
        reading.amount,
        reading.detail,
        reading.readAtMs ?? 0,
      );
  }

  // ============ TRIPS ============

  /** The trip recorded for this limit and period */
  trip(project: string, budget: CloudBudgetSettings): StoredTrip | null {
    const row = this.db
      .prepare(
        `SELECT limit_amount, spend, reason, tripped_at FROM cloud_trips
         WHERE project = ? AND limit_amount = ? AND period_start = ? AND period_end = ?`,
      )
      .get(project, budget.limit, budget.periodStart, budget.periodEnd) as
      | { limit_amount: number; spend: number; reason: string; tripped_at: number }
      | undefined;
    return row ? { limit: row.limit_amount, spend: row.spend, reason: row.reason, at: row.tripped_at } : null;
  }

  /** Record a trip; the first one for a limit and period stands. True when this one was new. */
  addTrip(project: string, budget: CloudBudgetSettings, spend: number, reason: string, now: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cloud_trips (project, limit_amount, period_start, period_end, spend, reason, tripped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, budget.limit, budget.periodStart, budget.periodEnd, spend, reason, now);
    return result.changes > 0;
  }
}
