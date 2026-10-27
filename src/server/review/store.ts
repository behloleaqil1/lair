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
  ClientInfo,
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

/**
 * 1: reviews, findings, PRs, holds, merges, requests, gate results.
 * 2: review_requests gets `round` (a slot asked for again at the same head is
 *    a new round, and the earlier rounds' records stay) and `model` (the
 *    model the assigned agent runs on); review_agent_assignments (reviews by
 *    agents: each round's run, attempts and state).
 */
export const SCHEMA_VERSION = 2;

const SCHEMA_2 = `
  CREATE TABLE review_requests_2 (
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    slot INTEGER NOT NULL,
    round INTEGER NOT NULL,
    channel TEXT NOT NULL,
    detail TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    reviewer TEXT,
    exclude TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT,
    used_by TEXT,
    model TEXT,
    PRIMARY KEY (project, pr, head_sha, slot, round)
  );
  INSERT INTO review_requests_2
    (project, pr, head_sha, slot, round, channel, detail, requested_at, reviewer, exclude, token_hash, used_by)
    SELECT project, pr, head_sha, slot, 1, channel, detail, requested_at, reviewer, exclude, token_hash, used_by
    FROM review_requests;
  DROP TABLE review_requests;
  ALTER TABLE review_requests_2 RENAME TO review_requests;
  CREATE INDEX IF NOT EXISTS idx_review_requests_token ON review_requests(project, pr, token_hash);

  CREATE TABLE IF NOT EXISTS review_agent_assignments (
    project TEXT NOT NULL,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    slot INTEGER NOT NULL,
    round INTEGER NOT NULL,
    state TEXT NOT NULL,
    agent TEXT,
    run_id TEXT,
    chain_id TEXT,
    attempts INTEGER NOT NULL,
    not_before INTEGER NOT NULL,
    detail TEXT NOT NULL,
    spec TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, pr, head_sha, slot, round)
  );
  CREATE INDEX IF NOT EXISTS idx_review_agent_assignments_state ON review_agent_assignments(state);
`;

/** Schema version 1, as it shipped (the migration test builds a v1 file with it). */
export const SCHEMA_1 = `
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
    client TEXT,
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
    resolution TEXT,
    resolved_client TEXT
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
    conditions TEXT NOT NULL,
    client TEXT
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
    reviewer TEXT,
    exclude TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT,
    used_by TEXT,
    PRIMARY KEY (project, pr, head_sha, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_review_requests_token ON review_requests(project, pr, token_hash);

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
  /** Where the request came from (null for Lair's own checks) */
  client: ClientInfo | null;
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
  resolvedClient: ClientInfo | null;
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
  client: ClientInfo | null;
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
  client: string | null;
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
  resolved_client: string | null;
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
  client: string | null;
}

/** One reviewer request, with its assignment token's hash (agents only). */
export interface AssignmentRecord {
  pr: number;
  headSha: string;
  slot: number;
  /** 1, then one more each time the slot is asked for again at this head */
  round: number;
  /** The assigned agent, or null until the first review with the token binds it */
  reviewer: string | null;
  exclude: string[];
  usedBy: string | null;
  /** The model the assigned agent runs on, when Lair started its run (recorded with its review) */
  model: string | null;
  channel: string;
  detail: string;
  requestedAt: string;
}

interface RequestRow {
  pr: number;
  head_sha: string;
  slot: number;
  round: number;
  channel: string;
  detail: string;
  requested_at: string;
  reviewer: string | null;
  exclude: string;
  token_hash: string | null;
  used_by: string | null;
  model: string | null;
}

export type AgentAssignmentState = "requested" | "assigned" | "reviewed" | "failed" | "stale";

/** What an agent assignment was asked for (never the token). */
export interface AgentAssignmentSpec {
  tier: Tier;
  /** A named reviewer agent, or null for a peer */
  reviewer: string | null;
  exclude: string[];
  author: string | null;
  pool: string[] | null;
  differentModel: boolean;
  /** The author's model as the review module knows it (dragons:, authors.models); its profiles come from the agents module */
  authorModel: string | null;
  repo: string;
  base: string;
  url: string | null;
  label: string;
  /** Agents whose runs ended without a review, in order */
  tried: string[];
}

/** One round of a slot's reviews by agents at one head: the current run, attempts and state. */
export interface AgentAssignmentRecord {
  project: string;
  pr: number;
  headSha: string;
  slot: number;
  /** The review request's round this is for */
  round: number;
  state: AgentAssignmentState;
  agent: string | null;
  runId: string | null;
  chainId: string | null;
  attempts: number;
  /** ms: a requested slot starts no run before this */
  notBefore: number;
  detail: string;
  spec: AgentAssignmentSpec;
  updatedAt: string;
}

interface AgentAssignmentRow {
  project: string;
  pr: number;
  head_sha: string;
  slot: number;
  round: number;
  state: string;
  agent: string | null;
  run_id: string | null;
  chain_id: string | null;
  attempts: number;
  not_before: number;
  detail: string;
  spec: string;
  updated_at: string;
}

function agentAssignmentOf(row: AgentAssignmentRow): AgentAssignmentRecord {
  return {
    project: row.project,
    pr: row.pr,
    headSha: row.head_sha,
    slot: row.slot,
    round: row.round,
    state: row.state as AgentAssignmentState,
    agent: row.agent,
    runId: row.run_id,
    chainId: row.chain_id,
    attempts: row.attempts,
    notBefore: row.not_before,
    detail: row.detail,
    spec: JSON.parse(row.spec) as AgentAssignmentSpec,
    updatedAt: row.updated_at,
  };
}

export const OPEN_AGENT_STATES: readonly AgentAssignmentState[] = ["requested", "assigned"];

function clientOf(json: string | null): ClientInfo | null {
  return json ? (JSON.parse(json) as ClientInfo) : null;
}

function assignmentOf(row: RequestRow): AssignmentRecord {
  return {
    pr: row.pr,
    headSha: row.head_sha,
    slot: row.slot,
    round: row.round,
    reviewer: row.reviewer,
    exclude: JSON.parse(row.exclude) as string[],
    usedBy: row.used_by,
    model: row.model ?? null,
    channel: row.channel,
    detail: row.detail,
    requestedAt: row.requested_at,
  };
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
      this.db.transaction(() => {
        this.db.exec(SCHEMA_1);
        // 1 -> 2: review_requests is rebuilt with `round` in its key (its rows become round 1)
        if (version < 2) this.db.exec(SCHEMA_2);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
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
             (id, project, pr, head_sha, reviewer_id, reviewer_kind, reviewer_model, verdict, summary, context, client, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.client ? JSON.stringify(input.client) : null,
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
        client: clientOf(row.client),
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
            resolvedClient: clientOf(f.resolved_client),
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
    resolution: { status: "resolved" | "dismissed"; by: string; note: string; at: string; client: ClientInfo | null },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_findings SET status = ?, resolved_by = ?, resolution = ?, resolved_at = ?, resolved_client = ?
         WHERE project = ? AND id = ? AND status = 'open'`,
      )
      .run(
        resolution.status,
        resolution.by,
        resolution.note,
        resolution.at,
        resolution.client ? JSON.stringify(resolution.client) : null,
        project,
        id,
      );
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
    client: ClientInfo | null;
  }): ReviewMergeRecord {
    const id = shortId("merge");
    this.db
      .prepare(
        `INSERT INTO review_merges
           (id, project, pr, head_sha, method, strategy, result_sha, initiated_by, merged_at, commits_checked, conditions, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.client ? JSON.stringify(input.client) : null,
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
      client: clientOf(r.client),
    }));
  }

  // ============ REVIEWER REQUESTS ============

  /** The latest round of the request for one slot at one head, or null if none was made. */
  getRequest(project: string, pr: number, headSha: string, slot: number): AssignmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_requests WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ?
         ORDER BY round DESC LIMIT 1`,
      )
      .get(project, pr, headSha, slot) as RequestRow | undefined;
    return row ? assignmentOf(row) : null;
  }

  /**
   * A human review round whose inbox item was withdrawn (the PR left the
   * head): channel `withdrawn`, so it no longer counts as asked for.
   */
  markRequestWithdrawn(project: string, pr: number, headSha: string, slot: number, detail: string): void {
    this.db
      .prepare(
        `UPDATE review_requests SET channel = 'withdrawn', detail = ?
         WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND channel = 'decision' AND used_by IS NULL`,
      )
      .run(detail.slice(0, 500), project, pr, headSha, slot);
  }

  /** The slots whose human review was asked for at one head (through the Decision Inbox). */
  decisionSlots(project: string, pr: number, headSha: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT slot FROM review_requests WHERE project = ? AND pr = ? AND head_sha = ? AND channel = 'decision'
         ORDER BY slot`,
      )
      .all(project, pr, headSha) as { slot: number }[];
    return rows.map((r) => r.slot);
  }

  /** Every round of a slot's request at one head, first first. */
  requestRounds(project: string, pr: number, headSha: string, slot: number): AssignmentRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_requests WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? ORDER BY round`)
      .all(project, pr, headSha, slot) as RequestRow[];
    return rows.map(assignmentOf);
  }

  /**
   * Record a request as the slot's next round at this head (earlier rounds
   * stay); an agent assignment also stores its token's hash, never the
   * token. Returns the round.
   */
  recordRequest(
    project: string,
    pr: number,
    headSha: string,
    slot: number,
    channel: string,
    detail: string,
    at: string,
    assignment: { reviewer: string | null; exclude: string[]; tokenHash: string; model?: string | null } | null = null,
  ): number {
    return this.db.transaction(() => {
      const last = this.db
        .prepare(`SELECT MAX(round) AS round FROM review_requests WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ?`)
        .get(project, pr, headSha, slot) as { round: number | null };
      const round = (last.round ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO review_requests
             (project, pr, head_sha, slot, round, channel, detail, requested_at, reviewer, exclude, token_hash, used_by, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          project,
          pr,
          headSha,
          slot,
          round,
          channel,
          detail,
          at,
          assignment?.reviewer ?? null,
          JSON.stringify(assignment?.exclude ?? []),
          assignment?.tokenHash ?? null,
          assignment?.model ?? null,
        );
      return round;
    })();
  }

  /** The request's outcome once it was handed on: how, and to whom (a reviewer is bound only once). */
  completeRequest(
    project: string,
    pr: number,
    headSha: string,
    slot: number,
    round: number,
    outcome: { channel: string; detail: string; reviewer: string | null; model: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE review_requests SET channel = ?, detail = ?, reviewer = COALESCE(reviewer, ?), model = COALESCE(model, ?)
         WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND round = ?`,
      )
      .run(outcome.channel, outcome.detail, outcome.reviewer, outcome.model, project, pr, headSha, slot, round);
  }

  /**
   * A new token (by its hash) for an unused agent request, bound to the agent
   * now given the review: the previous token stops working. False when the
   * round was used or doesn't exist.
   */
  reissueRequest(
    project: string,
    pr: number,
    headSha: string,
    slot: number,
    round: number,
    issue: { reviewer: string; tokenHash: string; model: string | null; detail: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_requests SET reviewer = ?, token_hash = ?, model = ?, detail = ?
         WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND round = ? AND used_by IS NULL AND token_hash IS NOT NULL`,
      )
      .run(issue.reviewer, issue.tokenHash, issue.model, issue.detail, project, pr, headSha, slot, round);
    return result.changes > 0;
  }

  /** The head Lair last saw for a PR, or null. */
  currentHead(project: string, pr: number): string | null {
    const row = this.db.prepare(`SELECT head_sha FROM review_prs WHERE project = ? AND pr = ?`).get(project, pr) as
      | { head_sha: string | null }
      | undefined;
    return row?.head_sha ?? null;
  }

  // ============ REVIEWS BY AGENTS ============

  /**
   * Save one round's agent assignment. `bind`: in the same transaction, the
   * request of that round is bound to the agent whose run was started (and
   * the model it runs on), so the two never disagree.
   */
  saveAgentAssignment(record: AgentAssignmentRecord, bind?: { reviewer: string; model: string | null }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO review_agent_assignments
             (project, pr, head_sha, slot, round, state, agent, run_id, chain_id, attempts, not_before, detail, spec, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.project,
          record.pr,
          record.headSha,
          record.slot,
          record.round,
          record.state,
          record.agent,
          record.runId,
          record.chainId,
          record.attempts,
          record.notBefore,
          record.detail,
          JSON.stringify(record.spec),
          record.updatedAt,
        );
      if (bind) {
        this.db
          .prepare(
            `UPDATE review_requests SET reviewer = COALESCE(reviewer, ?), model = ?
             WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND round = ? AND used_by IS NULL`,
          )
          .run(bind.reviewer, bind.model, record.project, record.pr, record.headSha, record.slot, record.round);
      }
    })();
  }

  /** The latest round's agent assignment for one slot at one head. */
  getAgentAssignment(project: string, pr: number, headSha: string, slot: number): AgentAssignmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_agent_assignments WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ?
         ORDER BY round DESC LIMIT 1`,
      )
      .get(project, pr, headSha, slot) as AgentAssignmentRow | undefined;
    return row ? agentAssignmentOf(row) : null;
  }

  /** One round's agent assignment, or null. */
  agentAssignmentOfRound(project: string, pr: number, headSha: string, slot: number, round: number): AgentAssignmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_agent_assignments WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND round = ?`,
      )
      .get(project, pr, headSha, slot, round) as AgentAssignmentRow | undefined;
    return row ? agentAssignmentOf(row) : null;
  }

  /** A PR's agent assignments at one head: each slot's latest round, by slot. */
  agentAssignments(project: string, pr: number, headSha: string): AgentAssignmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM review_agent_assignments a WHERE project = ? AND pr = ? AND head_sha = ?
           AND round = (SELECT MAX(round) FROM review_agent_assignments b
                        WHERE b.project = a.project AND b.pr = a.pr AND b.head_sha = a.head_sha AND b.slot = a.slot)
         ORDER BY slot`,
      )
      .all(project, pr, headSha) as AgentAssignmentRow[];
    return rows.map(agentAssignmentOf);
  }

  /** Assignments still waiting for a run or a review (every project), oldest first; at most `limit`. */
  openAgentAssignments(limit = 500): AgentAssignmentRecord[] {
    const states = OPEN_AGENT_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM review_agent_assignments WHERE state IN (${states}) ORDER BY rowid LIMIT ?`)
      .all(...OPEN_AGENT_STATES, limit) as AgentAssignmentRow[];
    return rows.map(agentAssignmentOf);
  }

  /** The agents with an open assignment on a PR (at any head). */
  agentsReviewing(project: string, pr: number): string[] {
    const states = OPEN_AGENT_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT agent FROM review_agent_assignments
         WHERE project = ? AND pr = ? AND agent IS NOT NULL AND state IN (${states})`,
      )
      .all(project, pr, ...OPEN_AGENT_STATES) as { agent: string }[];
    return rows.map((r) => r.agent);
  }

  /** The assignment a token (by its hash) was issued for, or null. */
  findAssignment(project: string, pr: number, tokenHash: string): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM review_requests WHERE project = ? AND pr = ? AND token_hash = ?`)
      .get(project, pr, tokenHash) as RequestRow | undefined;
    return row ? assignmentOf(row) : null;
  }

  /**
   * Use an assignment, once: bind it to the reviewer (the first use binds an
   * unnamed one) and mark it used. False when it was used already, so a token
   * never counts twice, even for two requests at once.
   */
  markAssignmentUsed(project: string, pr: number, headSha: string, slot: number, round: number, reviewer: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_requests SET reviewer = COALESCE(reviewer, ?), used_by = ?
         WHERE project = ? AND pr = ? AND head_sha = ? AND slot = ? AND round = ? AND used_by IS NULL`,
      )
      .run(reviewer, reviewer, project, pr, headSha, slot, round);
    return result.changes > 0;
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
