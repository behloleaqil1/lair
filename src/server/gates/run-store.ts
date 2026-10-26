/**
 * Pipeline run store: runs, jobs (one per lane) with every attempt, executors
 * marked unavailable, and the decisions this module raised. SQLite
 * (data/pipelines.db), so in-flight jobs survive a restart and resume.
 *
 * Times come from the caller's Clock, never SQLite's datetime().
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { GateResult } from "../../shared/policy-types.js";
import type {
  ExecutorId,
  PipelineArtifact,
  PipelineAttempt,
  PipelineJob,
  PipelineJobStatus,
  PipelineRun,
  PipelineRunStatus,
  PipelineRunStep,
  RaisedDecision,
} from "../../shared/pipeline-types.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    branch TEXT,
    status TEXT NOT NULL,
    step_order TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pl_runs_project ON pipeline_runs(project, created_at);

  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
    project TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    lane TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    executor TEXT,
    where_ran TEXT,
    wait_reason TEXT,
    attempts TEXT NOT NULL,
    result TEXT,
    log TEXT,
    artifacts TEXT NOT NULL,
    minutes REAL NOT NULL DEFAULT 0,
    billed_minutes REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pl_jobs_run ON pipeline_jobs(run_id, position);
  CREATE INDEX IF NOT EXISTS idx_pl_jobs_status ON pipeline_jobs(status);

  CREATE TABLE IF NOT EXISTS pipeline_executor_status (
    project TEXT NOT NULL,
    executor TEXT NOT NULL,
    unavailable_until TEXT NOT NULL,
    reason TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    PRIMARY KEY (project, executor)
  );

  CREATE TABLE IF NOT EXISTS pipeline_decisions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

interface RunRow {
  id: string;
  project: string;
  pipeline: string;
  commit_sha: string;
  branch: string | null;
  status: string;
  step_order: string;
  cancel_requested: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface JobRow {
  id: string;
  run_id: string;
  project: string;
  pipeline: string;
  lane: string;
  position: number;
  status: string;
  executor: string | null;
  where_ran: string | null;
  wait_reason: string | null;
  attempts: string;
  result: string | null;
  log: string | null;
  artifacts: string;
  minutes: number;
  billed_minutes: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** A run row without its jobs */
export interface RunRecord {
  id: string;
  project: string;
  pipeline: string;
  commitSha: string;
  branch?: string;
  status: PipelineRunStatus;
  stepOrder: { name: string; lane: string }[];
  cancelRequested: boolean;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobPatch {
  status?: PipelineJobStatus;
  executor?: ExecutorId | null;
  where?: string | null;
  waitReason?: string | null;
  attempts?: PipelineAttempt[];
  result?: GateResult | null;
  log?: string | null;
  artifacts?: PipelineArtifact[];
  minutes?: number;
  billedMinutes?: number;
  error?: string | null;
  startedAt?: string;
  completedAt?: string;
}

export interface UnavailableExecutor {
  executor: ExecutorId;
  until: string;
  reason: string;
  markedAt: string;
}

const TERMINAL_JOB = new Set<PipelineJobStatus>(["passed", "failed", "error", "cancelled"]);

export function isTerminalJob(status: PipelineJobStatus): boolean {
  return TERMINAL_JOB.has(status);
}

function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    project: row.project,
    pipeline: row.pipeline,
    commitSha: row.commit_sha,
    branch: opt(row.branch),
    status: row.status as PipelineRunStatus,
    stepOrder: JSON.parse(row.step_order) as { name: string; lane: string }[],
    cancelRequested: row.cancel_requested === 1,
    error: opt(row.error),
    createdAt: row.created_at,
    startedAt: opt(row.started_at),
    completedAt: opt(row.completed_at),
  };
}

function toJob(row: JobRow): PipelineJob {
  return {
    id: row.id,
    runId: row.run_id,
    lane: row.lane,
    status: row.status as PipelineJobStatus,
    executor: opt(row.executor) as ExecutorId | undefined,
    where: opt(row.where_ran),
    waitReason: opt(row.wait_reason),
    attempts: JSON.parse(row.attempts) as PipelineAttempt[],
    result: row.result ? (JSON.parse(row.result) as GateResult) : undefined,
    log: opt(row.log),
    artifacts: JSON.parse(row.artifacts) as PipelineArtifact[],
    minutes: row.minutes,
    billedMinutes: row.billed_minutes,
    error: opt(row.error),
    createdAt: row.created_at,
    startedAt: opt(row.started_at),
    completedAt: opt(row.completed_at),
  };
}

export class PipelineStore {
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
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ RUNS ============

  createRun(
    run: Omit<RunRecord, "status" | "cancelRequested" | "error" | "startedAt" | "completedAt">,
    jobs: { id: string; lane: string }[],
  ): void {
    const insertRun = this.db.prepare(
      `INSERT INTO pipeline_runs (id, project, pipeline, commit_sha, branch, status, step_order, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    const insertJob = this.db.prepare(
      `INSERT INTO pipeline_jobs (id, run_id, project, pipeline, lane, position, status, attempts, artifacts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', '[]', '[]', ?)`,
    );
    this.db.transaction(() => {
      insertRun.run(
        run.id,
        run.project,
        run.pipeline,
        run.commitSha,
        run.branch ?? null,
        JSON.stringify(run.stepOrder),
        run.createdAt,
      );
      jobs.forEach((job, position) =>
        insertJob.run(job.id, run.id, run.project, run.pipeline, job.lane, position, run.createdAt),
      );
    })();
  }

  getRunRecord(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  updateRun(
    id: string,
    patch: { status?: PipelineRunStatus; error?: string | null; startedAt?: string; completedAt?: string },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = COALESCE(started_at, ?)");
      values.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  requestCancel(id: string): void {
    this.db.prepare("UPDATE pipeline_runs SET cancel_requested = 1 WHERE id = ?").run(id);
  }

  /** A run with its jobs and its steps (in pipeline order, with where each ran) */
  getRun(project: string, id: string): PipelineRun | null {
    const record = this.getRunRecord(id);
    if (!record || record.project !== project) return null;
    return this.assemble(record);
  }

  listRuns(project: string, limit = 50): PipelineRun[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_runs WHERE project = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(project, limit) as RunRow[];
    return rows.map((row) => this.assemble(toRun(row)));
  }

  private assemble(record: RunRecord): PipelineRun {
    const jobs = this.jobsOf(record.id);
    const steps: PipelineRunStep[] = record.stepOrder.map(({ name, lane }) => {
      const job = jobs.find((j) => j.lane === lane);
      const result = job?.result?.steps.find((s) => s.name === name);
      return {
        name,
        lane,
        status: result?.status ?? "pending",
        exitCode: result?.exitCode,
        durationMs: result?.durationMs,
        error: result?.error,
        executor: result ? job?.executor : undefined,
        where: result ? job?.where : undefined,
      };
    });
    return {
      id: record.id,
      project: record.project,
      pipeline: record.pipeline,
      commitSha: record.commitSha,
      branch: record.branch,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      error: record.error,
      minutes: jobs.reduce((sum, j) => sum + j.minutes, 0),
      billedMinutes: jobs.reduce((sum, j) => sum + j.billedMinutes, 0),
      steps,
      jobs,
    };
  }

  // ============ JOBS ============

  jobsOf(runId: string): PipelineJob[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_jobs WHERE run_id = ? ORDER BY position")
      .all(runId) as JobRow[];
    return rows.map(toJob);
  }

  getJob(id: string): (PipelineJob & { project: string; pipeline: string }) | null {
    const row = this.db.prepare("SELECT * FROM pipeline_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? { ...toJob(row), project: row.project, pipeline: row.pipeline } : null;
  }

  /** Jobs not finished yet, oldest first (resumed at startup) */
  activeJobs(): { id: string; project: string; runId: string }[] {
    return (
      this.db
        .prepare(
          `SELECT id, project, run_id FROM pipeline_jobs
           WHERE status NOT IN ('passed', 'failed', 'error', 'cancelled')
           ORDER BY created_at, position`,
        )
        .all() as { id: string; project: string; run_id: string }[]
    ).map((r) => ({ id: r.id, project: r.project, runId: r.run_id }));
  }

  updateJob(id: string, patch: JobPatch): void {
    const columns: [keyof JobPatch, string, (v: unknown) => unknown][] = [
      ["status", "status", (v) => v],
      ["executor", "executor", (v) => v],
      ["where", "where_ran", (v) => v],
      ["waitReason", "wait_reason", (v) => v],
      ["attempts", "attempts", (v) => JSON.stringify(v)],
      ["result", "result", (v) => (v === null ? null : JSON.stringify(v))],
      ["log", "log", (v) => v],
      ["artifacts", "artifacts", (v) => JSON.stringify(v)],
      ["minutes", "minutes", (v) => v],
      ["billedMinutes", "billed_minutes", (v) => v],
      ["error", "error", (v) => v],
      ["completedAt", "completed_at", (v) => v],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column, encode] of columns) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(encode(patch[key]));
      }
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = COALESCE(started_at, ?)");
      values.push(patch.startedAt);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE pipeline_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Billed CI minutes of a project's jobs finished since `since` (ISO) */
  billedMinutesSince(project: string, since: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(billed_minutes), 0) AS total FROM pipeline_jobs WHERE project = ? AND completed_at >= ?",
      )
      .get(project, since) as { total: number };
    return row.total;
  }

  /** The largest billed minutes of the last five hosted runs of a lane, or null */
  estimateHostedMinutes(project: string, pipeline: string, lane: string): number | null {
    const rows = this.db
      .prepare(
        `SELECT billed_minutes FROM pipeline_jobs
         WHERE project = ? AND pipeline = ? AND lane = ? AND executor = 'github-hosted' AND billed_minutes > 0
         ORDER BY completed_at DESC LIMIT 5`,
      )
      .all(project, pipeline, lane) as { billed_minutes: number }[];
    return rows.length > 0 ? Math.max(...rows.map((r) => r.billed_minutes)) : null;
  }

  // ============ EXECUTOR STATUS ============

  markUnavailable(project: string, executor: ExecutorId, until: string, reason: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_executor_status (project, executor, unavailable_until, reason, marked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project, executor) DO UPDATE SET
           unavailable_until = excluded.unavailable_until, reason = excluded.reason, marked_at = excluded.marked_at`,
      )
      .run(project, executor, until, reason, at);
  }

  /** Executors marked unavailable until after `now` (ISO) */
  unavailable(project: string, now: string): Map<ExecutorId, UnavailableExecutor> {
    const rows = this.db
      .prepare(
        "SELECT executor, unavailable_until, reason, marked_at FROM pipeline_executor_status WHERE project = ? AND unavailable_until > ?",
      )
      .all(project, now) as { executor: string; unavailable_until: string; reason: string; marked_at: string }[];
    return new Map(
      rows.map((r) => [
        r.executor as ExecutorId,
        { executor: r.executor as ExecutorId, until: r.unavailable_until, reason: r.reason, markedAt: r.marked_at },
      ]),
    );
  }

  // ============ DECISIONS ============

  /** Record a decision once per key. Returns false when the key was already raised. */
  recordDecision(decision: RaisedDecision & { project: string; payload: unknown }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO pipeline_decisions (id, project, key, kind, question, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.project,
        decision.key,
        decision.kind,
        decision.question,
        JSON.stringify(decision.payload),
        decision.createdAt,
      );
    return info.changes > 0;
  }

  listDecisions(project: string, limit = 20): RaisedDecision[] {
    return this.db
      .prepare(
        "SELECT id, key, kind, question, created_at AS createdAt FROM pipeline_decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(project, limit) as RaisedDecision[];
  }
}
