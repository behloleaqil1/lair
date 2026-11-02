/**
 * An act-once ledger: every command a module's act mode started, so each
 * runs at most once per record and a failed one is retried a bounded number
 * of times with backoff, across restarts. Only act mode writes it; observe
 * mode never reads or creates it. Used by the infrastructure monitor
 * (re-queues) and PR health (notes and withdrawals).
 *
 * A JSON file of its own (format version 1), written atomically (a new file
 * in the same directory, then a rename) with async fs; writes are queued one
 * after the other. An attempt is written BEFORE its command runs, so a
 * restart in the middle counts it: on load the module's `interrupted` hook
 * turns such a record into a failed attempt. A file that can't be read or
 * parsed is not overwritten: the module stops acting (`error` says why)
 * until it is fixed or removed.
 *
 * Each write prunes records older than 14 days, then the oldest over 2000,
 * but never one the module's `keep` hook keeps. When kept records alone pass
 * 2000 the cap gives way and `warning` says so.
 */
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

const FORMAT = 1;
export const RETENTION_MS = 14 * 86_400_000;
export const MAX_RECORDS = 2000;

export interface ActRecord {
  project: string;
  id: string;
  lastAttemptAt: number;
}

export interface ActLedgerOptions<R extends ActRecord> {
  /** null: kept in memory only (nothing survives a restart) */
  path: string | null;
  /** In error texts: "the <name> can't be read", "...; <stops> until it is fixed or removed" */
  name: string;
  stops: string;
  isRecord(value: unknown): value is R;
  /** On load, for each record: one whose attempt started and never finished becomes a failed attempt. */
  interrupted(record: R): void;
  /** A record the module still needs: never pruned. */
  keep(record: R): boolean;
}

const keyOf = (project: string, id: string) => `${project}\u0000${id}`;

export class ActLedger<R extends ActRecord> {
  private records = new Map<string, R>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Why the ledger can't be used, or null */
  error: string | null = null;
  /** The cap gave way to kept records, or null */
  warning: string | null = null;

  constructor(private readonly options: ActLedgerOptions<R>) {}

  /** Read the file once. A missing file is an empty ledger. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    const { path, name, stops } = this.options;
    if (!path) return;
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.error = `the ${name} can't be read: ${(e as Error).message}`;
      return;
    }
    try {
      const data = JSON.parse(text) as { format?: unknown; records?: unknown };
      if (data.format !== FORMAT || !Array.isArray(data.records)) throw new Error(`not format ${FORMAT}`);
      for (const r of data.records) {
        if (!this.options.isRecord(r)) throw new Error("a record has the wrong shape");
        this.options.interrupted(r);
        this.records.set(keyOf(r.project, r.id), r);
      }
    } catch (e) {
      this.records.clear();
      this.error = `the ${name} ${path} is not valid (${(e as Error).message}); ${stops} until it is fixed or removed`;
    }
  }

  get(project: string, id: string): R | null {
    const r = this.records.get(keyOf(project, id));
    return r ? structuredClone(r) : null;
  }

  list(project: string): R[] {
    return [...this.records.values()].filter((r) => r.project === project).map((r) => structuredClone(r));
  }

  /** Keep a record and write the file; rejects when the write fails (the caller then runs nothing). */
  put(record: R, now: number): Promise<void> {
    if (this.error) return Promise.reject(new Error(this.error));
    this.records.set(keyOf(record.project, record.id), structuredClone(record));
    const write = this.writes.then(() => this.write(now));
    // The queue goes on after a failed write; this caller sees the failure
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async write(now: number): Promise<void> {
    const all = [...this.records.values()];
    const kept = all.filter((r) => this.options.keep(r));
    const rest = all
      .filter((r) => !this.options.keep(r) && now - r.lastAttemptAt < RETENTION_MS)
      .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
      .slice(0, Math.max(0, MAX_RECORDS - kept.length));
    this.warning = kept.length > MAX_RECORDS ? `the ${this.options.name} keeps ${kept.length} records it still needs, over its cap of ${MAX_RECORDS}` : null;
    const records = [...kept, ...rest].sort((a, b) => b.lastAttemptAt - a.lastAttemptAt);
    this.records = new Map(records.map((r) => [keyOf(r.project, r.id), r]));
    if (!this.options.path) return;
    await mkdir(dirname(this.options.path), { recursive: true });
    const tmp = `${this.options.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ format: FORMAT, records }, null, 1)}\n`, { mode: 0o600 });
    await rename(tmp, this.options.path);
  }
}
