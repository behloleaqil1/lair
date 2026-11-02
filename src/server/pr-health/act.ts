/**
 * PR health's act path (docs/design/pr-health.md section 4.5): notes to the
 * owning agent through notify_cmd and their withdrawals through
 * withdraw_cmd, act-once through the delivery ledger
 * (data/pr-health-deliveries.json, core/act-ledger.ts).
 *
 * - A note names the kinds the last read found at a (repo, PR, head) that no
 *   record of that head names yet, whatever its status: a kind that clears
 *   and comes back at the same head is not noted again. It is written
 *   `running` before its command runs; `sent` is final; a failure is retried
 *   with the same {id} after a backoff while its kinds are still found, at
 *   most max_attempts times, then it gave up.
 * - A sent note is withdrawn once its problem cleared, judged from this
 *   process's reads (so also after a restart, when findings start empty):
 *   its PR is gone from a whole list (or now skipped), its head moved, or
 *   reads at its head found none of its kinds for clear_minutes. Without
 *   withdraw_cmd the withdrawal is `skipped`. A note never sent gets none.
 * - Commands are argv arrays run without a shell through a CommandRunner in
 *   the project's repository (a timeout kills the process group and is a
 *   failure; output is bounded), at most MAX_COMMANDS_PER_TICK per tick.
 */
import { z } from "zod";
import { ActLedger } from "../core/act-ledger.js";
import type { EventBus } from "../core/event-bus.js";
import { oneLine } from "../infra-monitor/detectors.js";
import type { CommandRunner } from "../infra-monitor/probes.js";
import { KINDS, type Kind, type PrHealthSettings } from "./config.js";
import { noteArgv, withdrawArgv, type PlanGroup } from "./plan.js";
import type { ClearedWhy, NoteRecord } from "./types.js";

/** Notes and withdrawals together */
export const MAX_COMMANDS_PER_TICK = 4;
const MAX_BACKOFF_MS = 6 * 3_600_000;
const INTERRUPTED = "interrupted by a restart";

/** What this tick read successfully */
export interface TickReads {
  /** Each repository whose list succeeded: its open PRs' heads, the PRs it skips, and whether the list was a full page */
  listed: Map<string, { heads: Map<number, string>; skipped: Set<number>; truncated: boolean }>;
  /** Each PR read, by <repo>#<n>: its head and the kinds found there or not known (mergeable null) */
  read: Map<string, { head: string; found: Set<Kind>; unknown: Set<Kind> }>;
}

const Attempts = { attempts: z.number().int().min(0), lastAttemptAt: z.number(), nextAttemptAt: z.number().nullable(), lastError: z.string().nullable() };
const NoteRecordSchema = z.object({
  ...Attempts,
  project: z.string(),
  id: z.string(),
  repo: z.string(),
  pr: z.number().int(),
  head: z.string(),
  kinds: z.array(z.enum(KINDS)),
  agent: z.string(),
  status: z.enum(["running", "sent", "failed", "gave_up"]),
  argv: z.array(z.string()),
  sentAt: z.number().nullable(),
  withdraw: z.object({ ...Attempts, status: z.enum(["running", "done", "skipped", "failed", "gave_up"]), why: z.enum(["fixed", "head_moved", "closed", "ignored"]) }).nullable(),
});
const isNoteRecord = (v: unknown): v is NoteRecord => NoteRecordSchema.safeParse(v).success;

/** The delivery ledger; `keep` is PR health's rule for records it still needs (never pruned). */
export class DeliveryLedger extends ActLedger<NoteRecord> {
  constructor(path: string | null, keep: (record: NoteRecord) => boolean) {
    super({
      path,
      name: "PR health delivery ledger",
      stops: "notes and withdrawals stop",
      isRecord: isNoteRecord,
      interrupted: (r) => {
        // Started and never finished: the server stopped during the command
        for (const step of [r, r.withdraw]) {
          if (step?.status === "running") Object.assign(step, { status: "failed", lastError: INTERRUPTED });
        }
      },
      keep: (r) => r.status === "running" || r.withdraw?.status === "running" || keep(r),
    });
  }
}

/** The tick's act stops: a stop() during a command, or a ledger that can't be written before one */
class Halt extends Error {}

export interface DeliveriesOptions {
  project: string;
  settings: PrHealthSettings;
  ledger: DeliveryLedger;
  runner: CommandRunner;
  /** The project's repository: the commands' working directory */
  cwd: string;
  events?: EventBus;
  log: Pick<Console, "warn">;
  now: () => number;
}

export class Deliveries {
  /** A sent note's id -> since when reads at its head have found none of its kinds */
  private readonly clearing = new Map<string, number>();
  private commands = 0;

  constructor(private readonly o: DeliveriesOptions) {}

  private backoffMs(attempts: number): number {
    return Math.min(this.o.settings.backoffSeconds * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  }

  /** One tick of notes, then withdrawals; returns the problems met (the first is the status's lastError). */
  async run(groups: PlanGroup[], reads: TickReads, now: number, signal: AbortSignal): Promise<string[]> {
    this.commands = 0;
    const errors: string[] = [];
    try {
      await this.notes(groups, now, signal, errors);
      await this.withdrawals(reads, now, signal, errors);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
      if (e.message) errors.push(e.message);
    }
    return errors;
  }

  /** Keep the record after its command ran (or with nothing to run). */
  private async write(record: NoteRecord, now: number, errors: string[]): Promise<void> {
    try {
      await this.o.ledger.put(record, now);
    } catch (e) {
      errors.push(`${record.id}: the ledger can't be written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Keep the attempt before its command runs; a failed write stops the tick's act and the command does not run. */
  private async writeAttempt(record: NoteRecord, step: { status: string; lastError: string | null }, now: number, what: string): Promise<void> {
    try {
      await this.o.ledger.put(record, now);
    } catch (e) {
      const why = `the ledger can't be written: ${e instanceof Error ? e.message : String(e)}`;
      // Not run: a failed attempt (in memory), retried after its backoff once the ledger can be written
      Object.assign(step, { status: "failed", lastError: why });
      await this.o.ledger.put(record, now).catch(() => undefined);
      throw new Halt(`${what}: ${why}`);
    }
  }

  /** Run one command; its failure, or null when it exited 0 within the timeout. */
  private async command(argv: string[], signal: AbortSignal): Promise<string | null> {
    this.commands++;
    const seconds = this.o.settings.commandTimeoutSeconds;
    const out = await this.o.runner.run(argv, { timeoutMs: seconds * 1000, signal, cwd: this.o.cwd });
    // Stopped mid-command: the record stays "running", read as a failed attempt after the restart
    if (signal.aborted) throw new Halt("");
    if (out.timedOut) return `timed out after ${seconds} s`;
    return out.code === 0 ? null : `exited ${out.code}: ${oneLine(out.stderr || out.stdout, 300) || "no output"}`;
  }

  private async notes(groups: PlanGroup[], now: number, signal: AbortSignal, errors: string[]): Promise<void> {
    const { project, settings, ledger } = this.o;
    if (!settings.notifyCmd) return;
    const records = ledger.list(project);
    for (const g of groups) {
      if ("unknown" in g.owner || g.owner.owner.agent === null) continue;
      const agent = g.owner.owner.agent;
      const at = records.filter((r) => r.repo === g.repo && r.pr === g.pr && r.head === g.head);
      const fresh = KINDS.filter((k) => g.seen.includes(k) && !at.some((r) => r.kinds.includes(k)));
      let record: NoteRecord | undefined;
      if (fresh.length > 0) {
        const built = noteArgv(settings.notifyCmd, agent, g, fresh);
        if ("error" in built) {
          errors.push(`note ${built.id} not sent: ${built.error}`);
          continue;
        }
        const { id, argv } = built;
        record = { project, id, repo: g.repo, pr: g.pr, head: g.head, kinds: fresh, agent, status: "failed", attempts: 0, lastAttemptAt: now, nextAttemptAt: null, lastError: null, argv, sentAt: null, withdraw: null };
      } else {
        record = at.find((r) => r.status === "failed" && r.attempts < settings.maxAttempts && (r.nextAttemptAt ?? 0) <= now && r.kinds.some((k) => g.seen.includes(k)));
      }
      if (!record || this.commands >= MAX_COMMANDS_PER_TICK) continue;
      record.attempts++;
      // If this attempt never finishes (a restart), the next waits as after a failure
      Object.assign(record, { status: "running", lastAttemptAt: now, nextAttemptAt: now + this.backoffMs(record.attempts), lastError: null });
      await this.writeAttempt(record, record, now, `note ${record.id} not sent`);
      const failure = await this.command(record.argv, signal);
      const done = this.o.now();
      record.status = failure === null ? "sent" : record.attempts >= settings.maxAttempts ? "gave_up" : "failed";
      record.sentAt = failure === null ? done : null;
      record.nextAttemptAt = record.status === "failed" ? done + this.backoffMs(record.attempts) : null;
      record.lastError = failure;
      await this.write(record, done, errors);
      this.o.log.warn(`[pr-health] ${project}: note ${record.id} to ${agent}: ${record.status}${failure ? ` (${failure})` : ""}`);
      const { id, repo, pr, head, kinds, attempts } = record;
      void this.o.events?.emit("pr_health.noted", { project, id, repo, pr, head, kinds, agent, result: record.status, attempts, error: failure });
    }
  }

  /** Why a sent note's problem cleared, from this tick's reads, or null. */
  private clearedWhy(r: NoteRecord, reads: TickReads, now: number): ClearedWhy | null {
    const list = reads.listed.get(r.repo);
    const listedHead = list?.heads.get(r.pr);
    if (list && listedHead === undefined && !list.truncated) return "closed";
    if (list?.skipped.has(r.pr)) return "ignored";
    const read = reads.read.get(`${r.repo}#${r.pr}`);
    if ((listedHead !== undefined && listedHead !== r.head) || (read && read.head !== r.head)) return "head_moved";
    if (!read) return null;
    if (r.kinds.some((k) => read.found.has(k))) {
      this.clearing.delete(r.id);
      return null;
    }
    // Mergeability not known yet: neither found nor gone
    if (r.kinds.some((k) => read.unknown.has(k))) return null;
    const since = this.clearing.get(r.id) ?? now;
    this.clearing.set(r.id, since);
    return now - since >= this.o.settings.clearMinutes * 60_000 ? "fixed" : null;
  }

  private async withdrawals(reads: TickReads, now: number, signal: AbortSignal, errors: string[]): Promise<void> {
    const { project, settings, ledger } = this.o;
    for (const r of ledger.list(project)) {
      if (r.status !== "sent") continue;
      if (r.withdraw === null) {
        const why = this.clearedWhy(r, reads, now);
        if (!why) continue;
        r.withdraw = { status: "failed", why, attempts: 0, lastAttemptAt: now, nextAttemptAt: null, lastError: null };
      }
      const w = r.withdraw;
      if (w.status !== "failed" || w.attempts >= settings.maxAttempts || (w.nextAttemptAt ?? 0) > now) continue;
      if (settings.withdrawCmd && this.commands >= MAX_COMMANDS_PER_TICK) continue;
      this.clearing.delete(r.id);
      let failure: string | null = null;
      if (!settings.withdrawCmd) {
        w.status = "skipped";
        await this.write(r, now, errors);
      } else {
        const built = withdrawArgv(settings.withdrawCmd, r, w.why);
        if ("error" in built) {
          errors.push(`withdrawal of ${r.id} not run: ${built.error}`);
          continue;
        }
        w.attempts++;
        Object.assign(w, { status: "running", lastAttemptAt: now, nextAttemptAt: now + this.backoffMs(w.attempts), lastError: null });
        await this.writeAttempt(r, w, now, `withdrawal of ${r.id} not run`);
        failure = await this.command(built.argv, signal);
        const done = this.o.now();
        w.status = failure === null ? "done" : w.attempts >= settings.maxAttempts ? "gave_up" : "failed";
        w.nextAttemptAt = w.status === "failed" ? done + this.backoffMs(w.attempts) : null;
        w.lastError = failure;
        await this.write(r, done, errors);
      }
      this.o.log.warn(`[pr-health] ${project}: withdrawal of ${r.id} (${w.why}): ${w.status}${failure ? ` (${failure})` : ""}`);
      void this.o.events?.emit("pr_health.withdrawn", { project, id: r.id, agent: r.agent, result: w.status, attempts: w.attempts, error: failure });
    }
  }
}
