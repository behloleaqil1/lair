/**
 * The re-queue ledger (data/infra-monitor-requeues.json): every re-queue
 * act mode started, so a job is re-queued at most once and a failed
 * re-queue is retried a bounded number of times with backoff, across
 * restarts. Only act mode writes it; observe mode never creates it.
 *
 * A JSON file of its own (format version 1), written atomically (a new file
 * in the same directory, then a rename) with async fs; writes are queued one
 * after the other. An attempt is written BEFORE its command runs, so a
 * restart in the middle counts it: the record then reads as a failed attempt.
 * A file that can't be read or parsed is not overwritten: re-queues stop
 * (the status says why) until it is fixed or removed.
 */
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RequeueRecord } from "./types.js";

const FORMAT = 1;
/** Records kept: 14 days, at most this many (the newest) */
const RETENTION_MS = 14 * 86_400_000;
const MAX_RECORDS = 2000;

const keyOf = (project: string, id: string) => `${project}\u0000${id}`;

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

export class RequeueLedger {
  private records = new Map<string, RequeueRecord>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Why the ledger can't be used, or null */
  error: string | null = null;

  /** `path` null: kept in memory only (nothing survives a restart) */
  constructor(private readonly path: string | null) {}

  /** Read the file once. A missing file is an empty ledger. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    if (!this.path) return;
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.error = `the re-queue ledger can't be read: ${(e as Error).message}`;
      return;
    }
    try {
      const data = JSON.parse(text) as { format?: unknown; records?: unknown };
      if (data.format !== FORMAT || !Array.isArray(data.records)) throw new Error(`not format ${FORMAT}`);
      for (const r of data.records) {
        if (!isRecord(r)) throw new Error("a record has the wrong shape");
        // Started and never finished: the server stopped during the command
        if (r.status === "running") {
          r.status = "failed";
          r.lastError = "interrupted by a restart";
        }
        this.records.set(keyOf(r.project, r.id), r);
      }
    } catch (e) {
      this.records.clear();
      this.error = `the re-queue ledger ${this.path} is not valid (${(e as Error).message}); re-queues stop until it is fixed or removed`;
    }
  }

  get(project: string, id: string): RequeueRecord | null {
    const r = this.records.get(keyOf(project, id));
    return r ? { ...r, argv: [...r.argv] } : null;
  }

  list(project: string): RequeueRecord[] {
    return [...this.records.values()].filter((r) => r.project === project).map((r) => ({ ...r, argv: [...r.argv] }));
  }

  /** Keep a record and write the file; rejects when the write fails (the caller then runs nothing). */
  put(record: RequeueRecord, now: number): Promise<void> {
    if (this.error) return Promise.reject(new Error(this.error));
    this.records.set(keyOf(record.project, record.id), { ...record, argv: [...record.argv] });
    const write = this.writes.then(() => this.write(now));
    // The queue goes on after a failed write; this caller sees the failure
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async write(now: number): Promise<void> {
    const kept = [...this.records.values()]
      .filter((r) => r.status === "running" || now - r.lastAttemptAt < RETENTION_MS)
      .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
      .slice(0, MAX_RECORDS);
    this.records = new Map(kept.map((r) => [keyOf(r.project, r.id), r]));
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ format: FORMAT, records: kept }, null, 1)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
