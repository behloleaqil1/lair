/**
 * Bus mirror: write bus events to the project's text files in their current
 * line formats, so scripts and agents that don't use the bus keep working.
 *
 * Every field is cleaned and bounded: newlines and control characters become
 * spaces, lengths are capped, so no value can start a second line.
 */
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ReportKind } from "../../bus/types.js";

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

/** Ensure a file's parent directory exists */
function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============ Mirror ============

export class BusMirror {
  private config: BusMirrorConfig;

  constructor(config: BusMirrorConfig) {
    this.config = config;
  }

  /**
   * Mirror a report to the queue file.
   * Format: `- {KIND} {task} by {agent} {time}: {summary} [{gate_id}] [PR #{pr}] [{sha}]`
   */
  mirrorReport(
    agent: string,
    kind: ReportKind,
    task: string,
    summary: string,
    time: string,
    gateId?: string,
    pr?: number,
    sha?: string,
  ): string[] {
    const mirrored: string[] = [];

    if (!this.config.queueFile) return mirrored;

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

    const line = parts.join(" ") + "\n";

    try {
      ensureDir(this.config.queueFile);
      appendFileSync(this.config.queueFile, line);
      mirrored.push(this.config.queueFile);
    } catch {
      // Ignore mirror failures - the bus write succeeded
    }

    return mirrored;
  }

  /**
   * Mirror a message to the recipient's mailbox file.
   * Format: `- MSG {time} from {from}: {text}`
   */
  mirrorMessage(
    messageId: string,
    from: string,
    to: string,
    text: string,
    time: string,
  ): string[] {
    const mirrored: string[] = [];

    // Write to the inbox file if to=orchestrator and inbox_file is set
    if (to === "orchestrator" && this.config.inboxFile) {
      const line = `- MSG ${time.slice(11, 16)}Z [${messageId}] from ${sanitize(from, MAX_AGENT)}: ${sanitize(text, MAX_TEXT)}\n`;
      try {
        ensureDir(this.config.inboxFile);
        appendFileSync(this.config.inboxFile, line);
        mirrored.push(this.config.inboxFile);
      } catch {
        // Ignore
      }
    }

    // Write to the agent's mailbox if mail_dir is set
    if (this.config.mailDir && to !== "orchestrator" && to !== "owner") {
      const mailFile = join(this.config.mailDir, `${sanitize(to, MAX_AGENT)}.md`);
      const line = `- MSG ${time.slice(11, 16)}Z [${messageId}] from ${sanitize(from, MAX_AGENT)}: ${sanitize(text, MAX_TEXT)}\n`;
      try {
        ensureDir(mailFile);
        appendFileSync(mailFile, line);
        mirrored.push(mailFile);
      } catch {
        // Ignore
      }
    }

    return mirrored;
  }

  /** Touch the wake file to signal the orchestrator */
  touchWake(wakeFile: string): void {
    try {
      const now = new Date();
      if (existsSync(wakeFile)) {
        utimesSync(wakeFile, now, now);
      } else {
        ensureDir(wakeFile);
        writeFileSync(wakeFile, "");
      }
    } catch {
      // Ignore
    }
  }
}
