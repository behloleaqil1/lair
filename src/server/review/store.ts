/**
 * Review store: reviews and their findings (bound to the head sha they were
 * given at), PR authors, the last head seen per PR, holds, merges, reviewer
 * requests and signed gate results. SQLite (`data/review.db`), so all of it
 * survives a restart. Times come from the caller's clock.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  FindingSeverity,
  FindingStatus,
  MergeHold,
  MergeMethod,
  MergeStrategy,
  ReviewerKind,
  ReviewerRef,
  ReviewMergeRecord,
  Tier,
  Verdict,
} from "../../shared/review-types.js";
import type { SignedGateResult } from "../../shared/policy-types.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS review_reviews (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    reviewer_kind TEXT NOT NULL,
    reviewer_model TEXT,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    context TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_reviews_pr ON review_reviews(project, pr);

  CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES review_reviews(id),
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    severity TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    text TEXT NOT NULL,
    blocking INTEGER NOT NULL,
    rule TEXT,
    status TEXT NOT NULL,
    resolved_by TEXT,
    resolved_at TEXT,
    resolution TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_findings_review ON review_findings(review_id);

  CREATE TABLE IF NOT EXISTS review_prs (
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT,
    head_seen_at TEXT,
    author_id TEXT,
    author_kind TEXT,
    author_model TEXT,
    summary TEXT,
    PRIMARY KEY (project, pr)
  );

  CREATE TABLE IF NOT EXISTS review_holds (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    pr INTEGER,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    released_at TEXT,
    released_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_holds_project ON review_holds(project, released_at);

  CREATE TABLE IF NOT EXISTS review_merges (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    method TEXT NOT NULL,
    strategy TEXT NOT NULL,
    result_sha TEXT,
    initiated_by TEXT NOT NULL,
    merged_at TEXT NOT NULL,
    commits_checked INTEGER NOT NULL,
    conditions TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_merges_project ON review_merges(project, merged_at);

  CREATE TABLE IF NOT EXISTS review_requests (
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    slot INTEGER NOT NULL,
    channel TEXT NOT NULL,
    detail TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    PRIMARY KEY (project, pr, head_sha, slot)
  );

  CREATE TABLE IF NOT EXISTS review_gate_results (
    project TEXT NOT NULL,
    id TEXT NOT NULL,
    sha TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (project, id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_gate_results_sha ON review_gate_results(project, sha);
`;

export interface NewFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  text: string;
  blocking: boolean;
  rule: string | null;
}

export interface NewReview {
  project: string;
  pr: number;
  headSha: string;
  reviewer: ReviewerRef;
  verdict: Verdict;
  summary: string;
  /** Extra facts, e.g. the tier a check ran for */
  context: Record<string, unknown>;
  findings: NewFinding[];
  at: string;
}

export interface StoredFinding extends NewFinding {
  id: string;
  reviewId: string;
  project: string;
  pr: number;
  headSha: string;
  reviewer: ReviewerRef;
  status: FindingStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface StoredReview {
  id: string;
  project: string;
  pr: number;
  headSha: string;
  reviewer: ReviewerRef;
  verdict: Verdict;
  summary: string;
  context: Record<string, unknown>;
  createdAt: string;
  /** Insertion order */
  seq: number;
  findings: StoredFinding[];
}

export interface PrSummaryRecord {
  headSha: string;
  tier: Tier;
  canMerge: boolean;
  reasons: string[];
  evaluatedAt: string;
}

interface ReviewRow {
  seq: number;
  id: string;
  project: string;
  pr: number;
  head_sha: string;
  reviewer_id: string;
  reviewer_kind: string;
  reviewer_model: string | null;
  verdict: string;
  summary: string;
  context: string;
  created_at: string;
}

interface FindingRow {
  id: string;
  review_id: string;
  project: string;
  pr: number;
  severity: string;
  file: string | null;
  line: number | null;
  text: string;
  blocking: number;
  rule: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

interface HoldRow {
  id: string;
  project: string;
  pr: number | null;
  reason: string;
  created_by: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

interface MergeRow {
  id: string;
  project: string;
  pr: number;
  head_sha: string;
  method: string;
  strategy: string;
  result_sha: string | null;
  initiated_by: string;
  merged_at: string;
  commits_checked: number;
}

function reviewerOf(row: { reviewer_id: string; reviewer_kind: string; reviewer_model: string | null }): ReviewerRef {
  const ref: ReviewerRef = { id: row.reviewer_id, kind: row.reviewer_kind as ReviewerKind };
  if (row.reviewer_model) ref.model = row.reviewer_model;
  return ref;
}

function holdOf(row: HoldRow): MergeHold {
  return {
    id: row.id,
    project: row.project,
    pr: row.pr,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
  };
}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class ReviewStore {
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

  // ============ REVIEWS ============

  addReview(input: NewReview): StoredReview {
    const id = shortId("rv");
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_reviews
             (id, project, pr, head_sha, reviewer_id, reviewer_kind, reviewer_model, verdict, summary, context, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.project,
          input.pr,
          input.headSha,
          input.reviewer.id,
          input.reviewer.kind,
          input.reviewer.model ?? null,
          input.verdict,
          input.summary,
          JSON.stringify(input.context),
          input.at,
        );
      const findingStmt = this.db.prepare(
        `INSERT INTO review_findings
           (id, review_id, project, pr, severity, file, line, text, blocking, rule, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      );
      for (const f of input.findings) {
        findingStmt.run(
          shortId("fd"),
          id,
          input.project,
          input.pr,
          f.severity,
          f.file,
          f.line,
          f.text,
          f.blocking ? 1 : 0,
          f.rule,
        );
      }
    });
    insert();
    return this.listReviews(input.project, input.pr).find((r) => r.id === id)!;
  }

  /** Every review of a PR, oldest first, with its findings. */
  listReviews(project: string, pr: number): StoredReview[] {
    const rows = this.db
      .prepare(`SELECT rowid AS seq, * FROM review_reviews WHERE project = ? AND pr = ? ORDER BY rowid`)
      .all(project, pr) as ReviewRow[];
    const findings = this.db
      .prepare(`SELECT * FROM review_findings WHERE project = ? AND pr = ? ORDER BY rowid`)
      .all(project, pr) as FindingRow[];
    return rows.map((row) => {
      const reviewer = reviewerOf(row);
      return {
        id: row.id,
        project: row.project,
        pr: row.pr,
        headSha: row.head_sha,
        reviewer,
        verdict: row.verdict as Verdict,
        summary: row.summary,
        context: JSON.parse(row.context) as Record<string, unknown>,
        createdAt: row.created_at,
        seq: row.seq,
        findings: findings
          .filter((f) => f.review_id === row.id)
          .map((f) => ({
            id: f.id,
            reviewId: f.review_id,
            project: f.project,
            pr: f.pr,
            headSha: row.head_sha,
            reviewer,
            severity: f.severity as FindingSeverity,
            file: f.file,
            line: f.line,
            text: f.text,
            blocking: f.blocking === 1,
            rule: f.rule,
            status: f.status as FindingStatus,
            resolvedBy: f.resolved_by,
            resolvedAt: f.resolved_at,
            resolution: f.resolution,
          })),
      };
    });
  }

  /** The PR a finding belongs to, or null if the project has no such finding. */
  findingPr(project: string, id: string): number | null {
    const row = this.db.prepare(`SELECT pr FROM review_findings WHERE project = ? AND id = ?`).get(project, id) as
      | { pr: number }
      | undefined;
    return row ? row.pr : null;
  }

  resolveFinding(
    project: string,
    id: string,
    resolution: { status: "resolved" | "dismissed"; by: string; note: string; at: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_findings SET status = ?, resolved_by = ?, resolution = ?, resolved_at = ?
         WHERE project = ? AND id = ? AND status = 'open'`,
      )
      .run(resolution.status, resolution.by, resolution.note, resolution.at, project, id);
    return result.changes > 0;
  }

  // ============ PRS ============

  private ensurePr(project: string, pr: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO review_prs (project, pr) VALUES (?, ?)`).run(project, pr);
  }

  /** Record the head seen now; returns the previous head when it changed. */
  observeHead(project: string, pr: number, headSha: string, at: string): string | null {
    this.ensurePr(project, pr);
    const row = this.db.prepare(`SELECT head_sha FROM review_prs WHERE project = ? AND pr = ?`).get(project, pr) as
      | { head_sha: string | null }
      | undefined;
    const previous = row?.head_sha ?? null;
    if (previous === headSha) return null;
    this.db
      .prepare(`UPDATE review_prs SET head_sha = ?, head_seen_at = ? WHERE project = ? AND pr = ?`)
      .run(headSha, at, project, pr);
    return previous;
  }

  setAuthor(project: string, pr: number, author: ReviewerRef): void {
    this.ensurePr(project, pr);
    this.db
      .prepare(`UPDATE review_prs SET author_id = ?, author_kind = ?, author_model = ? WHERE project = ? AND pr = ?`)
      .run(author.id, author.kind, author.model ?? null, project, pr);
  }

  getAuthor(project: string, pr: number): ReviewerRef | null {
    const row = this.db
      .prepare(`SELECT author_id, author_kind, author_model FROM review_prs WHERE project = ? AND pr = ?`)
      .get(project, pr) as { author_id: string | null; author_kind: string | null; author_model: string | null } | undefined;
    if (!row?.author_id) return null;
    return reviewerOf({
      reviewer_id: row.author_id,
      reviewer_kind: row.author_kind ?? "agent",
      reviewer_model: row.author_model,
    });
  }

  saveSummary(project: string, pr: number, summary: PrSummaryRecord): void {
    this.ensurePr(project, pr);
    this.db
      .prepare(`UPDATE review_prs SET summary = ? WHERE project = ? AND pr = ?`)
      .run(JSON.stringify(summary), project, pr);
  }

  summaries(project: string): Map<number, PrSummaryRecord> {
    const rows = this.db
      .prepare(`SELECT pr, summary FROM review_prs WHERE project = ? AND summary IS NOT NULL`)
      .all(project) as { pr: number; summary: string }[];
    return new Map(rows.map((r) => [r.pr, JSON.parse(r.summary) as PrSummaryRecord]));
  }

  // ============ HOLDS ============

  addHold(project: string, pr: number | null, reason: string, by: string, at: string): MergeHold {
    const id = shortId("hold");
    this.db
      .prepare(`INSERT INTO review_holds (id, project, pr, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, project, pr, reason, by, at);
    return this.getHold(project, id)!;
  }

  getHold(project: string, id: string): MergeHold | null {
    const row = this.db.prepare(`SELECT * FROM review_holds WHERE project = ? AND id = ?`).get(project, id) as
      | HoldRow
      | undefined;
    return row ? holdOf(row) : null;
  }

  releaseHold(project: string, id: string, by: string, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_holds SET released_at = ?, released_by = ? WHERE project = ? AND id = ? AND released_at IS NULL`,
      )
      .run(at, by, project, id);
    return result.changes > 0;
  }

  /** Unreleased holds for the whole project, plus those for `pr` when given. */
  activeHolds(project: string, pr?: number): MergeHold[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM review_holds WHERE project = ? AND released_at IS NULL AND (pr IS NULL OR pr = ?) ORDER BY rowid`,
      )
      .all(project, pr ?? -1) as HoldRow[];
    return rows.map(holdOf);
  }

  listHolds(project: string, limit = 100): MergeHold[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_holds WHERE project = ? ORDER BY rowid DESC LIMIT ?`)
      .all(project, limit) as HoldRow[];
    return rows.map(holdOf);
  }

  // ============ MERGES ============

  recordMerge(input: {
    project: string;
    pr: number;
    headSha: string;
    method: MergeMethod;
    strategy: MergeStrategy;
    resultSha: string | null;
    initiatedBy: string;
    at: string;
    commitsChecked: number;
    conditions: unknown;
  }): ReviewMergeRecord {
    const id = shortId("merge");
    this.db
      .prepare(
        `INSERT INTO review_merges
           (id, project, pr, head_sha, method, strategy, result_sha, initiated_by, merged_at, commits_checked, conditions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.pr,
        input.headSha,
        input.method,
        input.strategy,
        input.resultSha,
        input.initiatedBy,
        input.at,
        input.commitsChecked,
        JSON.stringify(input.conditions),
      );
    return this.listMerges(input.project).find((m) => m.id === id)!;
  }

  listMerges(project: string, limit = 100): ReviewMergeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_merges WHERE project = ? ORDER BY rowid DESC LIMIT ?`)
      .all(project, limit) as MergeRow[];
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      pr: r.pr,
      headSha: r.head_sha,
      method: r.method as MergeMethod,
      strategy: r.strategy as MergeStrategy,
      resultSha: r.result_sha,
      initiatedBy: r.initiated_by,
      mergedAt: r.merged_at,
      commitsChecked: r.commits_checked,
    }));
  }

  // ============ REVIEWER REQUESTS ============

  wasRequested(project: string, pr: number, headSha: string, slot: number): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM review_requests WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ?`)
        .get(project, pr, headSha, slot) !== undefined
    );
  }

  recordRequest(project: string, pr: number, headSha: string, slot: number, channel: string, detail: string, at: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO review_requests (project, pr, head_sha, slot, channel, detail, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, pr, headSha, slot, channel, detail, at);
  }

  // ============ SIGNED GATE RESULTS ============

  addGateResult(project: string, signed: SignedGateResult, at: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO review_gate_results (project, id, sha, pipeline_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(project, signed.result.id, signed.result.commitSha, signed.result.pipelineId, JSON.stringify(signed), at);
  }

  gateResults(project: string, sha: string): SignedGateResult[] {
    const rows = this.db
      .prepare(`SELECT payload FROM review_gate_results WHERE project = ? AND sha = ? ORDER BY rowid`)
      .all(project, sha) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as SignedGateResult);
  }
}
