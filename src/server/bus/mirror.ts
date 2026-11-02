/**
 * Bus mirror: write bus events to the project's text files in their current
 * line formats, so scripts and agents that don't use the bus keep working.
 *
 * Every field is cleaned and bounded: newlines and control characters become
 * spaces, lengths are capped, so no value can start a second line.
 *
 * Mirrored lines carry a marker (`[bus:<id>]`) at the end, so consumers that
 * already processed the event can skip them. This prevents double counting
 * when both the event and the mirrored line would trigger the same transition.
 *
 * The writes are asynchronous (they run inside POST /api/bus/call and
 * /api/bus/send, never blocking the event loop) and serialised per file: a
 * file's lines are appended one at a time, in the order they were asked for,
 * so two lines never interleave and the queue file keeps the bus store's
 * order. Each method resolves once its own lines are written (or failed), so
 * the bus emits its event only after the mirrored line is in the file.
 */
import { appendFile, mkdir, utimes, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import type { ReportKind } from "../../bus/types.js";
import { isPlainName } from "../agents/config.js";

// ============ Config ============

export interface BusMirrorConfig {
  /** Path to the queue file (for reports) */
  queueFile?: string;
  /** Path to per-agent mailbox directory */
  mailDir?: string;
  /** Path to a shared inbox file (for orchestrator messages) */
  inboxFile?: string;
}

// ============ Limits ============

const MAX_TASK = 200;
const MAX_SUMMARY = 2000;
const MAX_TEXT = 2000;
const MAX_AGENT = 100;
const MAX_GATE_ID = 200;
const MAX_SHA = 64;

// ============ Sanitization ============

/** Remove newlines, control chars, ANSI escapes; cap length */
function sanitize(value: string, max: number): string {
  /* eslint-disable no-control-regex */
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI escapes (must be first)
    .replace(/[\x00-\x1f\x7f]/g, " ") // control chars -> space
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .slice(0, max);
  /* eslint-enable no-control-regex */
}

// ============ Serialised appends ============

/** Per file (resolved path), the end of its chain of appends: the next append starts once this one has settled */
const tails = new Map<string, Promise<void>>();

/**
 * Append one line to a file after every append already asked for on it (by any mirror: a project's bus service is
 * rebuilt when its config changes), creating its directory when missing. Queued synchronously, so lines land in the
 * order of the calls. True once written, false when the write failed (the bus write already succeeded).
 */
function appendLine(path: string, line: string): Promise<boolean> {
  const key = resolve(path);
  const previous = tails.get(key) ?? Promise.resolve();
  const written = previous.then(async () => {
    await mkdir(dirname(key), { recursive: true });
    await appendFile(key, line);
  });
  const settled = written.then(
    () => true,
    () => false,
  );
  const tail = settled.then(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return settled;
}

// ============ Mirror ============

export class BusMirror {
  private config: BusMirrorConfig;

  constructor(config: BusMirrorConfig) {
    this.config = config;
  }

  /**
   * Mirror a report to the queue file.
   * Format: `- {KIND} {task} by {agent} {time}: {summary} [{gate_id}] [PR #{pr}] [{sha}] [bus:{id}]`
   * The `[bus:{id}]` marker lets consumers skip lines they already processed via the event.
   * Resolves with the files written once the line is in the file.
   */
  async mirrorReport(
    agent: string,
    kind: ReportKind,
    task: string,
    summary: string,
    time: string,
    gateId?: string,
    pr?: number,
    sha?: string,
    busId?: number,
  ): Promise<string[]> {
    const queueFile = this.config.queueFile;
    if (!queueFile) return [];

    const parts = [
      `-`,
      kind,
      sanitize(task, MAX_TASK),
      `by`,
      sanitize(agent, MAX_AGENT),
      time.slice(11, 16) + "Z:", // HH:MMZ
      sanitize(summary, MAX_SUMMARY),
    ];

    if (gateId) parts.push(`[${sanitize(gateId, MAX_GATE_ID)}]`);
    if (pr !== undefined && pr !== null) parts.push(`PR #${pr}`);
    if (sha) parts.push(`[${sanitize(sha, MAX_SHA).slice(0, 7)}]`);
    if (busId !== undefined) parts.push(`[bus:${busId}]`);

    return (await appendLine(queueFile, parts.join(" ") + "\n")) ? [queueFile] : [];
  }

  /**
   * Mirror a message to the recipient's mailbox file.
   * Format: `- MSG {time} from {from}: {text}`
   * An agent's mailbox is `<mail_dir>/<to>.md` only when `to` is a plain name (no '/', no '..'): any other
   * recipient has no mailbox file. Resolves with the files written once the lines are in them.
   */
  async mirrorMessage(messageId: string, from: string, to: string, text: string, time: string): Promise<string[]> {
    const line = `- MSG ${time.slice(11, 16)}Z [${messageId}] from ${sanitize(from, MAX_AGENT)}: ${sanitize(text, MAX_TEXT)}\n`;
    const writes: Array<Promise<string | null>> = [];

    // Write to the inbox file if to=orchestrator and inbox_file is set
    const inboxFile = this.config.inboxFile;
    if (to === "orchestrator" && inboxFile) {
      writes.push(appendLine(inboxFile, line).then((ok) => (ok ? inboxFile : null)));
    }

    // Write to the agent's mailbox if mail_dir is set
    if (this.config.mailDir && to !== "orchestrator" && to !== "owner" && isPlainName(to)) {
      const mailFile = join(this.config.mailDir, `${to}.md`);
      writes.push(appendLine(mailFile, line).then((ok) => (ok ? mailFile : null)));
    }

    return (await Promise.all(writes)).filter((file): file is string => file !== null);
  }

  /** Touch the wake file to signal the orchestrator (created when missing); failures are ignored */
  async touchWake(wakeFile: string): Promise<void> {
    const now = new Date();
    try {
      await utimes(wakeFile, now, now);
      return;
    } catch {
      // Missing (or unreadable): create it below
    }
    try {
      await mkdir(dirname(wakeFile), { recursive: true });
      // "a": never truncates a file created in the meantime
      await writeFile(wakeFile, "", { flag: "a" });
    } catch {
      // Ignore
    }
  }
}
