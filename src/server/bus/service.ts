/**
 * Bus service: the server-side implementation of the fleet bus.
 *
 * Claims have ONE source of truth: the agents module's claims. The bus does
 * not keep its own claim table. whoami shows the run's claimed task from the
 * agents module. A report for a task the run doesn't hold is refused.
 *
 * Routing rules:
 * - Agents may send only to "orchestrator" and "owner"
 * - The owner can send to any agent
 * - An agent can read and ack only its own messages
 */
import type { EventBus } from "../core/event-bus.js";
import type { BusStore, BusReport, BusMessage } from "./store.js";
import type { BusTokenBinding } from "./tokens.js";
import type { ReportKind } from "../../bus/types.js";
import { BusMirror, type BusMirrorConfig } from "./mirror.js";

// ============ Special IDs ============

export const ORCHESTRATOR_ID = "orchestrator";
export const OWNER_ID = "owner";

// ============ Types ============

export interface WhoamiResult {
  agent: string;
  runId: string;
  project: string;
  task: string | null;
}

export interface ReportResult {
  id: number;
  mirrored: string[];
}

export interface SendResult {
  messageId: string;
  to: string;
}

export interface InboxMessage {
  id: string;
  from: string;
  text: string;
  priority: number;
  sentAt: string;
}

export interface BoardTask {
  task: string;
  owner: string | null;
  lastReport: {
    kind: ReportKind;
    summary: string;
    time: string;
    gateId?: string;
    pr?: number;
    sha?: string;
  } | null;
}

export interface BoardAgent {
  id: string;
  claims: string[];
}

export interface BoardResult {
  tasks: BoardTask[];
  agents: BoardAgent[];
}

export type BusError =
  | { code: "unauthorized"; message: string }
  | { code: "forbidden"; message: string }
  | { code: "not_found"; message: string }
  | { code: "bad_request"; message: string };

export type BusResult<T> = { ok: true; data: T } | { ok: false; error: BusError };

// ============ Helpers ============

const MAX_SUMMARY_CHARS = 10_000;
const MAX_MESSAGE_CHARS = 10_000;

/** Sanitize text for storage and mirroring: no control chars, bounded length */
function sanitizeText(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, maxChars);
}

/** ISO timestamp from epoch ms */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ============ Service ============

export interface BusServiceOptions {
  store: BusStore;
  /** Get the claimed task for a run (from the agents module) */
  getClaimedTask: (runId: string) => string | null;
  /** Get all claims (for the board) */
  getAllClaims: () => Array<{ task: string; agent: string }>;
  /** Get all known agents */
  getKnownAgents: () => string[];
  /** Mirror config (text files) */
  mirrorConfig?: BusMirrorConfig;
  /** Event bus for bus events */
  events?: EventBus;
  /** Wake file to touch on DONE/BLOCKED/owner message */
  wakeFile?: string;
}

export class BusService {
  private store: BusStore;
  private getClaimedTask: (runId: string) => string | null;
  private getAllClaims: () => Array<{ task: string; agent: string }>;
  private getKnownAgents: () => string[];
  private mirror: BusMirror | null;
  private events?: EventBus;
  private wakeFile?: string;

  constructor(options: BusServiceOptions) {
    this.store = options.store;
    this.getClaimedTask = options.getClaimedTask;
    this.getAllClaims = options.getAllClaims;
    this.getKnownAgents = options.getKnownAgents;
    this.mirror = options.mirrorConfig ? new BusMirror(options.mirrorConfig) : null;
    this.events = options.events;
    this.wakeFile = options.wakeFile;
  }

  // ============ whoami ============

  whoami(binding: BusTokenBinding): BusResult<WhoamiResult> {
    const task = this.getClaimedTask(binding.runId);
    return {
      ok: true,
      data: {
        agent: binding.agent,
        runId: binding.runId,
        project: binding.project,
        task,
      },
    };
  }

  // ============ report ============

  report(
    binding: BusTokenBinding,
    kind: ReportKind,
    task: string,
    summary: string,
    gateId?: string,
    pr?: number,
    sha?: string,
  ): BusResult<ReportResult> {
    // Validate: the run must hold this task
    const claimedTask = this.getClaimedTask(binding.runId);
    if (claimedTask !== task) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: claimedTask
            ? `Your run holds task "${claimedTask}", not "${task}"`
            : `Your run does not hold any task`,
        },
      };
    }

    const now = Date.now();
    const sanitizedSummary = sanitizeText(summary, MAX_SUMMARY_CHARS);

    const id = this.store.createReport(
      binding.agent,
      binding.runId,
      kind,
      task,
      sanitizedSummary,
      now,
      gateId,
      pr,
      sha,
    );

    // Mirror to text files
    const mirrored: string[] = [];
    if (this.mirror) {
      const files = this.mirror.mirrorReport(binding.agent, kind, task, sanitizedSummary, iso(now), gateId, pr, sha);
      mirrored.push(...files);
    }

    // Emit event
    if (this.events) {
      this.events.emit("bus.report", { project: binding.project, id, agent: binding.agent, kind, task, gateId, pr, sha });
    }

    // Wake on DONE or BLOCKED
    if (this.wakeFile && (kind === "DONE" || kind === "BLOCKED")) {
      this.mirror?.touchWake(this.wakeFile);
    }

    return { ok: true, data: { id, mirrored } };
  }

  // ============ inbox ============

  inbox(binding: BusTokenBinding): BusResult<InboxMessage[]> {
    const now = Date.now();
    const messages = this.store.getUnreadMessages(binding.agent, now);

    return {
      ok: true,
      data: messages.map((m) => ({
        id: m.id,
        from: m.fromId,
        text: m.text,
        priority: m.priority,
        sentAt: iso(m.createdAt),
      })),
    };
  }

  // ============ ack ============

  ack(binding: BusTokenBinding, messageId: string, note?: string): BusResult<{ messageId: string }> {
    const now = Date.now();
    const sanitizedNote = note ? sanitizeText(note, 1000) : undefined;
    const acked = this.store.ackMessage(messageId, binding.agent, sanitizedNote, now);

    if (!acked) {
      // Check if the message exists
      const msg = this.store.getMessage(messageId);
      if (!msg) {
        return { ok: false, error: { code: "not_found", message: "Message not found" } };
      }
      if (msg.toId !== binding.agent) {
        return { ok: false, error: { code: "forbidden", message: "This message is not for you" } };
      }
      // Already acked
      return { ok: true, data: { messageId } };
    }

    return { ok: true, data: { messageId } };
  }

  // ============ send (from agent) ============

  send(binding: BusTokenBinding, to: string, text: string, priority?: number): BusResult<SendResult> {
    // Agents can only send to orchestrator or owner
    if (to !== ORCHESTRATOR_ID && to !== OWNER_ID) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Agents can only send to orchestrator or owner" },
      };
    }

    const now = Date.now();
    const sanitizedText = sanitizeText(text, MAX_MESSAGE_CHARS);
    const messageId = this.store.sendMessage(binding.agent, to, sanitizedText, priority ?? 5, now);

    // Mirror to text files
    if (this.mirror) {
      this.mirror.mirrorMessage(messageId, binding.agent, to, sanitizedText, iso(now));
    }

    // Emit event
    if (this.events) {
      this.events.emit("bus.message", { project: binding.project, id: messageId, from: binding.agent, to, priority: priority ?? 5 });
    }

    return { ok: true, data: { messageId, to } };
  }

  // ============ send (from owner) ============

  sendFromOwner(to: string, text: string, priority?: number): BusResult<SendResult> {
    const now = Date.now();
    const sanitizedText = sanitizeText(text, MAX_MESSAGE_CHARS);
    const messageId = this.store.sendMessage(OWNER_ID, to, sanitizedText, priority ?? 5, now);

    // Mirror to text files
    if (this.mirror) {
      this.mirror.mirrorMessage(messageId, OWNER_ID, to, sanitizedText, iso(now));
    }

    // Emit event
    if (this.events) {
      this.events.emit("bus.message", { project: this.store.project, id: messageId, from: OWNER_ID, to, priority: priority ?? 5 });
    }

    // Wake on owner message
    if (this.wakeFile) {
      this.mirror?.touchWake(this.wakeFile);
    }

    return { ok: true, data: { messageId, to } };
  }

  // ============ board ============

  board(): BusResult<BoardResult> {
    const claims = this.getAllClaims();
    const reports = this.store.getLatestReportsByTask();
    const agents = this.getKnownAgents();

    // Build task list
    const taskSet = new Set<string>();
    claims.forEach((c) => taskSet.add(c.task));
    reports.forEach((_, task) => taskSet.add(task));

    const tasks: BoardTask[] = Array.from(taskSet).map((task) => {
      const claim = claims.find((c) => c.task === task);
      const report = reports.get(task);

      return {
        task,
        owner: claim?.agent ?? null,
        lastReport: report
          ? {
              kind: report.kind,
              summary: report.summary,
              time: iso(report.createdAt),
              gateId: report.gateId ?? undefined,
              pr: report.pr ?? undefined,
              sha: report.sha ?? undefined,
            }
          : null,
      };
    });

    const agentList: BoardAgent[] = agents.map((id) => ({
      id,
      claims: claims.filter((c) => c.agent === id).map((c) => c.task),
    }));

    return { ok: true, data: { tasks, agents: agentList } };
  }

  // ============ Message queries (for UI) ============

  getMessage(id: string): BusMessage | null {
    return this.store.getMessage(id);
  }

  listMessages(agentId: string, options?: { direction?: "sent" | "received"; limit?: number }): BusMessage[] {
    return this.store.listMessages(agentId, options);
  }

  countUnread(agentId: string): number {
    return this.store.countUnread(agentId);
  }

  // ============ Report queries (for UI) ============

  getReport(id: number): BusReport | null {
    return this.store.getReport(id);
  }

  listReports(options?: { task?: string; agent?: string; limit?: number }): BusReport[] {
    return this.store.listReports(options);
  }
}
