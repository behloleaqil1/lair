/**
 * The re-queue ledger (data/infra-monitor-requeues.json): every re-queue
 * act mode started, so a job is re-queued at most once and a failed
 * re-queue is retried a bounded number of times with backoff, across
 * restarts. Only act mode writes it; observe mode never creates it.
 *
 * The generic act-once ledger (core/act-ledger.ts): format version 1, async
 * fs, an attempt written BEFORE its command runs, a `running` record read
 * back as a failed attempt after a restart, and a file that can't be read
 * or parsed never overwritten (re-queues stop until it is fixed or removed).
 */
import { ActLedger } from "../core/act-ledger.js";
import type { RequeueRecord } from "./types.js";

function isRecord(v: unknown): v is RequeueRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.project === "string" &&
    typeof r.id === "string" &&
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    typeof r.attempts === "number" &&
    ["running", "moved", "failed", "gave_up"].includes(r.status as string) &&
    typeof r.lastAttemptAt === "number" &&
    (r.nextAttemptAt === null || typeof r.nextAttemptAt === "number") &&
    (r.lastError === null || typeof r.lastError === "string") &&
    Array.isArray(r.argv)
  );
}

export class RequeueLedger extends ActLedger<RequeueRecord> {
  /** `path` null: kept in memory only (nothing survives a restart) */
  constructor(path: string | null) {
    super({
      path,
      name: "re-queue ledger",
      stops: "re-queues stop",
      isRecord,
      interrupted: (r) => {
        // Started and never finished: the server stopped during the command
        if (r.status === "running") {
          r.status = "failed";
          r.lastError = "interrupted by a restart";
        }
      },
      keep: (r) => r.status === "running",
    });
  }
}
