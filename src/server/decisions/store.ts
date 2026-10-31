/**
 * Decision store: decisions, the work they block, and their audit trail, in
 * SQLite (data/decisions.db), so all of it survives a restart.
 *
 * One open decision per (project, module, key) is enforced by a unique
 * index. Times come from the inbox's clock, never SQLite's datetime().
 * A secret value never reaches this file: credentials answers store only
 * that the secret was supplied.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  Decision,
  DecisionAnswer,
  DecisionAttention,
  DecisionAuditAction,
  DecisionAuditEntry,
  DecisionCounts,
  DecisionEvidence,
  DecisionKind,
  DecisionLink,
  DecisionOption,
  DecisionOutcome,
  DecisionStatus,
} from "../../shared/decision-types.js";
import { isKnownDecisionClass } from "./structure.js";
import type { ValidRaise } from "./validate.js";

// 2: decisions.raised_via (server | http), for the per-project cap on HTTP callers
// 3: decisions.attention (action | notice): what needs the owner's answer, and what is for their information
// 4: decisions.class and decisions.evidence (JSON), nullable: the policy class and its machine-readable evidence
// 5: decisions.outcome, outcome_at, outcome_evidence: the outcome tracker's verdict on an answered decision
// 6: policy_trace: one row per decision, proposer and version (docs/design/decision-policies.md §5); shadow proposals only
export const SCHEMA_VERSION = 6;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT NOT NULL,
    options TEXT NOT NULL,
    recommended_option TEXT NOT NULL,
    recommended_reasoning TEXT NOT NULL,
    source_module TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    links TEXT NOT NULL,
    secret_name TEXT,
    default_option TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    overdue_at TEXT,
    status TEXT NOT NULL,
    answer_option TEXT,
    answer_note TEXT,
    answer_secret_supplied INTEGER NOT NULL DEFAULT 0,
    answered_by TEXT,
    answered_at TEXT,
    withdrawn_reason TEXT,
    closed_at TEXT,
    delivered_at TEXT,
    delivery_error TEXT,
    raised_via TEXT NOT NULL DEFAULT 'server',
    attention TEXT NOT NULL DEFAULT 'action',
    class TEXT,
    evidence TEXT,
    outcome TEXT,
    outcome_at TEXT,
    outcome_evidence TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_open_key_via
    ON decisions(project, source_module, dedupe_key, raised_via) WHERE status = 'open';
  CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status, project);
  CREATE INDEX IF NOT EXISTS idx_decisions_await_outcome ON decisions(answered_at) WHERE status = 'answered' AND outcome IS NULL;

  CREATE TABLE IF NOT EXISTS decision_blocks (
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    ref TEXT NOT NULL,
    PRIMARY KEY (decision_id, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_decision_blocks_ref ON decision_blocks(ref);

  CREATE TABLE IF NOT EXISTS decision_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decision_audit ON decision_audit(decision_id, id);

  CREATE TABLE IF NOT EXISTS policy_trace (
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    proposer TEXT NOT NULL,
    version TEXT NOT NULL,
    class TEXT NOT NULL,
    policy TEXT NOT NULL,
    option TEXT,
    reason_code TEXT NOT NULL,
    confidence REAL NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (decision_id, proposer, version)
  );
`;

interface DecisionRow {
  id: string;
  project: string;
  kind: string;
  title: string;
  context: string;
  options: string;
  recommended_option: string;
  recommended_reasoning: string;
  source_module: string;
  source_ref: string;
  dedupe_key: string;
  links: string;
  secret_name: string | null;
  default_option: string | null;
  created_at: string;
  expires_at: string | null;
  overdue_at: string | null;
  status: string;
  answer_option: string | null;
  answer_note: string | null;
  answer_secret_supplied: number;
  answered_by: string | null;
  answered_at: string | null;
  withdrawn_reason: string | null;
  closed_at: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  raised_via: string;
  attention: string;
  outcome: string | null;
  outcome_at: string | null;
  outcome_evidence: string | null;
  class: string | null;
  evidence: string | null;
}

/** Open first, by urgency (soonest expiry, then oldest); then the rest, newest first. */
const URGENCY_ORDER = `
  ORDER BY (d.status <> 'open'),
    CASE WHEN d.status = 'open' THEN d.expires_at IS NULL END,
    CASE WHEN d.status = 'open' THEN d.expires_at END,
    CASE WHEN d.status = 'open' THEN d.created_at END,
    d.closed_at DESC,
    d.rowid DESC`;

/** Where the previous page of answers waiting for an outcome ended */
export interface OutcomeCursor {
  answeredAt: string;
  id: string;
}

export interface ListOptions {
  project?: string;
  status?: DecisionStatus | "closed" | "all";
  /** Only action decisions, or only notices */
  attention?: DecisionAttention;
  limit?: number;
}

export type RaiseOutcome =
  | { kind: "created" | "existing"; decision: Decision; addedBlocks: string[] }
  /**
   * module: the module already has the maximum open in the project; http:
   * HTTP callers together already have the maximum open in the project
   */
  | { kind: "capped"; by: "module" | "http"; open: number; limit: number };

/** Where a decision was raised: by a module inside the server, or over HTTP (any caller). */
export type RaisedVia = "server" | "http";

export interface RaiseLimits {
  via: RaisedVia;
  /** Open decisions per project and module */
  maxOpenPerSource?: number;
  /** Open decisions raised over HTTP per project, whatever module they name */
  maxOpenHttpPerProject?: number;
}

export interface Closing {
  status: Exclude<DecisionStatus, "open">;
  at: string;
  answer?: DecisionAnswer;
  answeredBy?: string;
  withdrawnReason?: string;
  /** Withdrawn decisions need no delivery: the producer took them back itself */
  delivered?: boolean;
}

/** A proposal as written to the policy trace. `option` is null when the proposer abstained. */
export interface PolicyTraceRow {
  decisionId: string;
  proposer: string;
  version: string;
  class: string;
  policy: string;
  option: string | null;
  reasonCode: string;
  confidence: number;
  at: string;
}

export interface PolicyTraceJoined extends PolicyTraceRow {
  status: DecisionStatus;
  /** The option a person answered; null while open, withdrawn or expired */
  answer: string | null;
  options: DecisionOption[];
}

function parseEvidence(text: string | null): Decision["outcomeEvidence"] {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Decision["outcomeEvidence"]) : {};
  } catch {
    return {};
  }
}

export class DecisionStore {
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
      this.db.transaction(() => {
        // Version 1 files lack raised_via; their decisions were raised in the server or over HTTP alike
        if (version === 1) this.db.exec(`ALTER TABLE decisions ADD COLUMN raised_via TEXT NOT NULL DEFAULT 'server'`);
        // Versions 1 and 2 lack attention: every decision then asked for an answer
        if (version >= 1 && version <= 2) {
          this.db.exec(`ALTER TABLE decisions ADD COLUMN attention TEXT NOT NULL DEFAULT 'action'`);
        }
        // Versions 1 to 3 lack class and evidence: those decisions were raised without them
        if (version >= 1 && version <= 3) {
          this.db.exec(`ALTER TABLE decisions ADD COLUMN class TEXT`);
          this.db.exec(`ALTER TABLE decisions ADD COLUMN evidence TEXT`);
        }
        // Versions 1 to 4 lack the outcome columns
        if (version >= 1 && version <= 4) {
          for (const column of ["outcome", "outcome_at", "outcome_evidence"]) {
            this.db.exec(`ALTER TABLE decisions ADD COLUMN ${column} TEXT`);
          }
        }
        // One open decision per key and per way in: an HTTP caller's key never stands for a module's own
        this.db.exec(`DROP INDEX IF EXISTS idx_decisions_open_key`);
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert a decision, or return the open one with the same project, module
   * and key (merging in any new blocked refs). A new one is refused
   * ("capped") while the module already has maxOpenPerSource open in the
   * project, or, raised over HTTP, while HTTP callers already have
   * maxOpenHttpPerProject open there (the module name is the caller's word,
   * so it can't be what bounds them). Atomic.
   */
  raise(input: ValidRaise, at: string, limits: RaiseLimits = { via: "server" }): RaiseOutcome {
    const maxOpen = limits.maxOpenPerSource ?? Number.POSITIVE_INFINITY;
    return this.db.transaction((): RaiseOutcome => {
      // Only a decision raised the same way: one raised over HTTP never answers for a module's own (and back)
      const existing = this.db
        .prepare(
          `SELECT id FROM decisions WHERE project = ? AND source_module = ? AND dedupe_key = ? AND status = 'open'
             AND raised_via = ?`,
        )
        .get(input.project, input.source.module, input.key, limits.via) as { id: string } | undefined;
      if (existing) {
        const known = new Set(this.blocksOf(existing.id));
        const added = input.blocks.filter((ref) => !known.has(ref));
        this.addBlocks(existing.id, added);
        return { kind: "existing", decision: this.get(existing.id)!, addedBlocks: added };
      }
      const { open } = this.db
        .prepare(`SELECT COUNT(*) AS open FROM decisions WHERE project = ? AND source_module = ? AND status = 'open'`)
        .get(input.project, input.source.module) as { open: number };
      if (open >= maxOpen) return { kind: "capped", by: "module", open, limit: maxOpen };
      if (limits.via === "http" && limits.maxOpenHttpPerProject !== undefined) {
        const { open: viaHttp } = this.db
          .prepare(`SELECT COUNT(*) AS open FROM decisions WHERE project = ? AND raised_via = 'http' AND status = 'open'`)
          .get(input.project) as { open: number };
        if (viaHttp >= limits.maxOpenHttpPerProject) {
          return { kind: "capped", by: "http", open: viaHttp, limit: limits.maxOpenHttpPerProject };
        }
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO decisions
             (id, project, kind, title, context, options, recommended_option, recommended_reasoning,
              source_module, source_ref, dedupe_key, links, secret_name, default_option,
              created_at, expires_at, status, raised_via, attention, class, evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.project,
          input.kind,
          input.title,
          input.context,
          JSON.stringify(input.options),
          input.recommended.optionId,
          input.recommended.reasoning,
          input.source.module,
          input.source.ref,
          input.key,
          JSON.stringify(input.links),
          input.secretName ?? null,
          input.defaultOptionId ?? null,
          at,
          input.expiresAt ?? null,
          limits.via,
          input.attention,
          input.class ?? null,
          input.evidence ? JSON.stringify(input.evidence) : null,
        );
      this.addBlocks(id, input.blocks);
      return { kind: "created", decision: this.get(id)!, addedBlocks: input.blocks };
    })();
  }

  private addBlocks(id: string, refs: string[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO decision_blocks (decision_id, ref) VALUES (?, ?)`);
    for (const ref of refs) insert.run(id, ref);
  }

  private blocksOf(id: string): string[] {
    const rows = this.db
      .prepare(`SELECT ref FROM decision_blocks WHERE decision_id = ? ORDER BY rowid`)
      .all(id) as { ref: string }[];
    return rows.map((r) => r.ref);
  }

  get(id: string, now?: string): Decision | null {
    const row = this.db.prepare(`SELECT * FROM decisions d WHERE d.id = ?`).get(id) as DecisionRow | undefined;
    return row ? this.toDecision(row, now) : null;
  }

  list(options: ListOptions = {}, now?: string): Decision[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.project) {
      where.push("d.project = ?");
      params.push(options.project);
    }
    const status = options.status ?? "all";
    if (status === "closed") {
      where.push("d.status <> 'open'");
    } else if (status !== "all") {
      where.push("d.status = ?");
      params.push(status);
    }
    if (options.attention) {
      where.push("d.attention = ?");
      params.push(options.attention);
    }
    params.push(options.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${URGENCY_ORDER} LIMIT ?`,
      )
      .all(...params) as DecisionRow[];
    return rows.map((row) => this.toDecision(row, now));
  }

  counts(now: string, project?: string): DecisionCounts {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS open,
                COALESCE(SUM(CASE WHEN attention = 'action' AND expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END), 0)
                  AS overdue,
                COALESCE(SUM(CASE WHEN attention = 'action' THEN 1 ELSE 0 END), 0) AS action
         FROM decisions WHERE status = 'open' ${project ? "AND project = ?" : ""}`,
      )
      .get(...(project ? [now, project] : [now])) as { open: number; overdue: number; action: number };
    return { open: row.open, overdue: row.overdue, action: row.action, notices: row.open - row.action };
  }

  /**
   * The latest decision this module raised in the server with this key in the
   * project (an open one first), or null. Decisions raised over HTTP never
   * count: their module name is only what the caller said.
   */
  find(project: string, module: string, key: string, now?: string): Decision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM decisions d WHERE d.project = ? AND d.source_module = ? AND d.dedupe_key = ?
           AND d.raised_via = 'server'
         ORDER BY (d.status = 'open') DESC, d.rowid DESC LIMIT 1`,
      )
      .get(project, module, key) as DecisionRow | undefined;
    return row ? this.toDecision(row, now) : null;
  }

  /** The module's open decisions in the project that it raised in the server, oldest first. */
  openOf(project: string, module: string, now?: string): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions d WHERE d.project = ? AND d.source_module = ? AND d.status = 'open'
           AND d.raised_via = 'server' ORDER BY d.rowid`,
      )
      .all(project, module) as DecisionRow[];
    return rows.map((row) => this.toDecision(row, now));
  }

  /** Open decisions that block this ref, most urgent first. */
  blocking(ref: string, now?: string): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM decisions d JOIN decision_blocks b ON b.decision_id = d.id
         WHERE b.ref = ? AND d.status = 'open' ${URGENCY_ORDER}`,
      )
      .all(ref) as DecisionRow[];
    return rows.map((row) => this.toDecision(row, now));
  }

  /** Open decisions whose expiry is at or before `now`. */
  due(now: string): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions d WHERE d.status = 'open' AND d.expires_at IS NOT NULL AND d.expires_at <= ?
         ${URGENCY_ORDER}`,
      )
      .all(now) as DecisionRow[];
    return rows.map((row) => this.toDecision(row, now));
  }

  /** Mark an open decision overdue (once). True when this call marked it. */
  markOverdue(id: string, at: string): boolean {
    return (
      this.db
        .prepare(`UPDATE decisions SET overdue_at = ? WHERE id = ? AND status = 'open' AND overdue_at IS NULL`)
        .run(at, id).changes > 0
    );
  }

  /** Close an open decision. False when it was no longer open (another answer won). */
  closeDecision(id: string, closing: Closing): boolean {
    const result = this.db
      .prepare(
        `UPDATE decisions SET status = ?, closed_at = ?, answer_option = ?, answer_note = ?,
           answer_secret_supplied = ?, answered_by = ?, answered_at = ?, withdrawn_reason = ?, delivered_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(
        closing.status,
        closing.at,
        closing.answer?.optionId ?? null,
        closing.answer?.note ?? null,
        closing.answer?.secretSupplied ? 1 : 0,
        closing.answeredBy ?? null,
        closing.answer ? closing.at : null,
        closing.withdrawnReason ?? null,
        closing.delivered ? closing.at : null,
        id,
      );
    return result.changes > 0;
  }

  /**
   * Undo an answer that could not be completed (its secret store failed):
   * open again, only if it is still that answer and not yet delivered.
   */
  reopenDecision(id: string, answeredAt: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE decisions SET status = 'open', closed_at = NULL, answer_option = NULL, answer_note = NULL,
             answer_secret_supplied = 0, answered_by = NULL, answered_at = NULL,
             outcome = NULL, outcome_at = NULL, outcome_evidence = NULL
           WHERE id = ? AND status = 'answered' AND answered_at = ? AND delivered_at IS NULL`,
        )
        .run(id, answeredAt).changes > 0
    );
  }

  /** Answered decisions (by a person) with no outcome yet, oldest answer first. */
  awaitingOutcome(limit: number, since?: string, after?: OutcomeCursor): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions d WHERE d.status = 'answered' AND d.outcome IS NULL AND d.answered_by <> 'lair'
         AND d.answer_option IS NOT NULL AND d.answered_at >= ? AND (d.answered_at > ? OR (d.answered_at = ? AND d.id > ?))
         ORDER BY d.answered_at, d.id LIMIT ?`,
      )
      .all(since ?? "", after?.answeredAt ?? "", after?.answeredAt ?? "", after?.id ?? "", limit) as DecisionRow[];
    return rows.map((row) => this.toDecision(row));
  }

  /**
   * Record the outcome of an answer, once: only while it has none, and only
   * for the answer made at `answeredAt` (an answer undone and given again is
   * judged on its own). False when it did not apply.
   */
  setOutcome(id: string, answeredAt: string, outcome: DecisionOutcome, at: string, evidence: Record<string, unknown>): boolean {
    return (
      this.db
        .prepare(
          `UPDATE decisions SET outcome = ?, outcome_at = ?, outcome_evidence = ?
           WHERE id = ? AND status = 'answered' AND answered_at = ? AND outcome IS NULL`,
        )
        .run(outcome, at, JSON.stringify(evidence), id, answeredAt).changes > 0
    );
  }

  /** Answered or expired decisions not yet delivered to their producer. */
  undelivered(module?: string): Decision[] {
    const rows = (
      module
        ? this.db
            .prepare(
              `SELECT * FROM decisions d WHERE d.status IN ('answered', 'expired') AND d.delivered_at IS NULL
               AND d.source_module = ? ORDER BY d.closed_at, d.rowid`,
            )
            .all(module)
        : this.db
            .prepare(
              `SELECT * FROM decisions d WHERE d.status IN ('answered', 'expired') AND d.delivered_at IS NULL
               ORDER BY d.closed_at, d.rowid`,
            )
            .all()
    ) as DecisionRow[];
    return rows.map((row) => this.toDecision(row));
  }

  markDelivered(id: string, at: string): boolean {
    return (
      this.db
        .prepare(`UPDATE decisions SET delivered_at = ?, delivery_error = NULL WHERE id = ? AND delivered_at IS NULL`)
        .run(at, id).changes > 0
    );
  }

  /** Record a failed delivery; returns the previous error (null on the first failure). */
  markDeliveryFailed(id: string, error: string): string | null {
    const row = this.db.prepare(`SELECT delivery_error FROM decisions WHERE id = ?`).get(id) as
      | { delivery_error: string | null }
      | undefined;
    this.db.prepare(`UPDATE decisions SET delivery_error = ? WHERE id = ?`).run(error, id);
    return row?.delivery_error ?? null;
  }

  /** Replace an open decision's evidence (the caller changed only cause_cleared / linked_issue). False: not open, or none. */
  updateEvidence(id: string, evidence: DecisionEvidence): boolean {
    const r = this.db
      .prepare(`UPDATE decisions SET evidence = ? WHERE id = ? AND status = 'open' AND evidence IS NOT NULL`)
      .run(JSON.stringify(evidence), id);
    return r.changes > 0;
  }

  /** Record a proposal: one row per decision, proposer and version, so a repeat (a restart) changes nothing. True: a new row. */
  addTrace(t: PolicyTraceRow): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO policy_trace (decision_id, proposer, version, class, policy, option, reason_code, confidence, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.decisionId, t.proposer, t.version, t.class, t.policy, t.option, t.reasonCode, t.confidence, t.at);
    return r.changes > 0;
  }

  /** Whether this proposer version already has a row for the decision. */
  hasTrace(decisionId: string, proposer: string, version: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM policy_trace WHERE decision_id = ? AND proposer = ? AND version = ?`)
        .get(decisionId, proposer, version) !== undefined
    );
  }

  /** Every trace row with its decision's status, the answer a person gave, and the options offered. */
  traces(): PolicyTraceJoined[] {
    const rows = this.db
      .prepare(
        `SELECT t.decision_id, t.proposer, t.version, t.class, t.policy, t.option, t.reason_code, t.confidence, t.at,
                d.status, d.answer_option, d.options
           FROM policy_trace t JOIN decisions d ON d.id = t.decision_id ORDER BY t.at, t.decision_id`,
      )
      .all() as {
      decision_id: string;
      proposer: string;
      version: string;
      class: string;
      policy: string;
      option: string | null;
      reason_code: string;
      confidence: number;
      at: string;
      status: string;
      answer_option: string | null;
      options: string;
    }[];
    return rows.map((r) => ({
      decisionId: r.decision_id,
      proposer: r.proposer,
      version: r.version,
      class: r.class,
      policy: r.policy,
      option: r.option,
      reasonCode: r.reason_code,
      confidence: r.confidence,
      at: r.at,
      status: r.status as DecisionStatus,
      answer: r.status === "answered" ? r.answer_option : null,
      options: JSON.parse(r.options) as DecisionOption[],
    }));
  }

  addAudit(id: string, entry: { at: string; action: DecisionAuditAction; actor: string; detail: string }): void {
    this.db
      .prepare(`INSERT INTO decision_audit (decision_id, at, action, actor, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(id, entry.at, entry.action, entry.actor, entry.detail);
  }

  audit(id: string): DecisionAuditEntry[] {
    const rows = this.db
      .prepare(`SELECT at, action, actor, detail FROM decision_audit WHERE decision_id = ? ORDER BY id`)
      .all(id) as { at: string; action: string; actor: string; detail: string }[];
    return rows.map((r) => ({ at: r.at, action: r.action as DecisionAuditAction, actor: r.actor, detail: r.detail }));
  }

  private toDecision(row: DecisionRow, now?: string): Decision {
    const status = row.status as DecisionStatus;
    const answer: DecisionAnswer | undefined = row.answer_option
      ? {
          optionId: row.answer_option,
          ...(row.answer_note ? { note: row.answer_note } : {}),
          ...(row.answer_secret_supplied === 1 ? { secretSupplied: true } : {}),
        }
      : undefined;
    const overdue =
      status === "open" &&
      row.expires_at !== null &&
      (row.overdue_at !== null || (now !== undefined && row.expires_at <= now));
    return {
      id: row.id,
      project: row.project,
      kind: row.kind as DecisionKind,
      attention: row.attention === "notice" ? "notice" : "action",
      title: row.title,
      context: row.context,
      options: JSON.parse(row.options) as DecisionOption[],
      recommended: { optionId: row.recommended_option, reasoning: row.recommended_reasoning },
      source: { module: row.source_module, ref: row.source_ref },
      key: row.dedupe_key,
      blocks: this.blocksOf(row.id),
      links: JSON.parse(row.links) as DecisionLink[],
      secretName: row.secret_name ?? undefined,
      defaultOptionId: row.default_option ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      overdue,
      status,
      answer,
      answeredBy: row.answered_by ?? undefined,
      answeredAt: row.answered_at ?? undefined,
      withdrawnReason: row.withdrawn_reason ?? undefined,
      closedAt: row.closed_at ?? undefined,
      deliveredAt: row.delivered_at ?? undefined,
      raisedVia: row.raised_via === "http" ? "http" : "server",
      ...(row.outcome === "good" || row.outcome === "bad" || row.outcome === "unknown"
        ? { outcome: row.outcome, outcomeAt: row.outcome_at ?? undefined, outcomeEvidence: parseEvidence(row.outcome_evidence) }
        : {}),
      ...(row.class ? { class: row.class, classKnown: isKnownDecisionClass(row.class) } : {}),
      ...(row.evidence ? { evidence: JSON.parse(row.evidence) as DecisionEvidence } : {}),
    };
  }
}
