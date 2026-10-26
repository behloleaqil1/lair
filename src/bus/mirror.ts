/**
 * Text file mirroring for lair-bus
 *
 * Every report and message is also appended to the project's existing text files
 * so scripts and agents that don't use the bus keep working.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { BusProjectConfig, ReportKind } from "./types.js";

/**
 * Format a UTC timestamp as HH:MMZ
 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}Z`;
}

/**
 * Format a full UTC timestamp as ISO date-time
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * Ensure a file exists (create with empty content if it doesn't)
 */
function ensureFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
}

/**
 * Append a line to a file, ensuring it ends with a newline
 */
function appendLine(path: string, line: string): void {
  ensureFile(path);
  appendFileSync(path, line + "\n");
}

/**
 * Mirror class for one project
 */
export class Mirror {
  constructor(private config: BusProjectConfig) {}

  /**
   * Mirror a report to the queue file
   *
   * Format examples:
   * - DONE fix-login task by kiro-A 14:35Z: head abc1234d, gate 20261024T143500Z-... rc=0
   * - WAITING search-panel 20261024T152000Z-... by kiro-B 15:20Z: submitted to heavy lane
   * - BLOCKED build-config by kiro-C 16:05Z: missing config file
   * - PROGRESS refactoring by kiro-D 17:00Z: 3 of 8 files complete
   * - TICK 18:00Z: all runners healthy, 2 gates queued
   */
  mirrorReport(
    agentId: string,
    kind: ReportKind,
    task: string,
    summary: string,
    timestamp: string,
    gateId?: string,
    pr?: number,
    sha?: string,
  ): string[] {
    const mirrored: string[] = [];
    const time = formatTime(timestamp);

    let line: string;

    if (kind === "TICK") {
      // TICK format: - TICK <time>: <summary>
      line = `- TICK ${time}: ${summary}`;
    } else if (kind === "DONE") {
      // DONE format: - DONE <task> task by <agent> <time>: head <sha>, gate <gate_id> rc=0
      const parts = [`- DONE ${task} task by ${agentId} ${time}:`];
      if (sha) parts.push(`head ${sha.slice(0, 8)}`);
      if (gateId) parts.push(`gate ${gateId} rc=0`);
      if (!sha && !gateId) parts.push(summary);
      line = parts.join(" ");
    } else if (kind === "WAITING") {
      // WAITING format: - WAITING <task> <gate_id> by <agent> <time>: <summary>
      const parts = [`- WAITING ${task}`];
      if (gateId) parts.push(gateId);
      parts.push(`by ${agentId} ${time}: ${summary}`);
      line = parts.join(" ");
    } else if (kind === "BLOCKED") {
      // BLOCKED format: - BLOCKED <task> by <agent> <time>: <summary>
      line = `- BLOCKED ${task} by ${agentId} ${time}: ${summary}`;
    } else {
      // PROGRESS format: - PROGRESS <task> by <agent> <time>: <summary>
      line = `- PROGRESS ${task} by ${agentId} ${time}: ${summary}`;
    }

    if (this.config.queue_file) {
      appendLine(this.config.queue_file, line);
      mirrored.push(this.config.queue_file);
    }

    return mirrored;
  }

  /**
   * Mirror a message to the inbox file and/or agent mailbox
   *
   * Format for inbox (to orchestrator/owner):
   * - OWNER <UTC time> [<id>]: <text>
   *
   * Format for agent mailbox:
   * - FROM <sender> <UTC time> [<id>]: <text>
   */
  mirrorMessage(
    id: string,
    fromId: string,
    toId: string,
    text: string,
    timestamp: string,
  ): string[] {
    const mirrored: string[] = [];
    const time = formatTimestamp(timestamp);

    if (toId === "orchestrator" || toId === "owner") {
      // Message to orchestrator/owner goes to inbox_file
      if (this.config.inbox_file) {
        const line = `- OWNER ${time} [${id}]: ${text}`;
        appendLine(this.config.inbox_file, line);
        mirrored.push(this.config.inbox_file);
      }
    } else if (this.config.mail_dir) {
      // Message to an agent goes to their mailbox
      const mailbox = join(this.config.mail_dir, `${toId}.md`);
      const line = `- FROM ${fromId} ${time} [${id}]: ${text}`;
      appendLine(mailbox, line);
      mirrored.push(mailbox);
    }

    return mirrored;
  }

  /**
   * Touch the wake file to signal the orchestrator
   * Called after: message to orchestrator, DONE or BLOCKED report, owner message
   */
  touchWake(): void {
    if (this.config.wake_file) {
      const now = new Date().toISOString();
      ensureFile(this.config.wake_file);
      writeFileSync(this.config.wake_file, `woken at ${now}\n`);
    }
  }

  /**
   * Determine if a wake-up is needed based on the event
   */
  shouldWake(
    kind?: ReportKind,
    toId?: string,
    fromId?: string,
  ): boolean {
    // Wake on: DONE, BLOCKED, message to orchestrator, message from owner
    if (kind === "DONE" || kind === "BLOCKED") return true;
    if (toId === "orchestrator") return true;
    if (fromId === "owner") return true;
    return false;
  }
}
