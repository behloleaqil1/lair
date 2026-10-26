/**
 * Inbox/Outbox parser - parse owner instructions and orchestrator replies
 *
 * Inbox format: - OWNER <UTC time> [<id>]: <text>
 * Outbox format: - REPLY <id> <UTC time> by <agent>: <text>
 */
import type { InboxItem, OutboxReply } from "../../shared/types.js";
import { randomUUID } from "crypto";

/**
 * Parse an inbox line
 * Format: - OWNER <UTC time> [<id>]: <text>
 */
export function parseInboxLine(line: string): InboxItem | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- OWNER ")) {
    return null;
  }

  // Match: - OWNER 2026-10-24T12:34:56Z [abc123]: Some instruction text
  // Or: - OWNER 12:34Z [abc123]: Some instruction text
  const match = trimmed.match(/^- OWNER\s+(\S+)\s+\[([^\]]+)\]:\s*(.+)$/);

  if (!match) {
    return null;
  }

  const [, timestamp, id, text] = match;

  return {
    id,
    timestamp,
    text,
    status: "pending",
  };
}

/**
 * Parse an outbox line (reply)
 * Format: - REPLY <id> <UTC time> by <agent>: <text>
 */
export function parseOutboxLine(line: string): OutboxReply | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- REPLY ")) {
    return null;
  }

  // Match: - REPLY abc123 2026-10-24T12:35:00Z by kiro-A: Did the thing
  const match = trimmed.match(/^- REPLY\s+(\S+)\s+(\S+)\s+by\s+(\S+):\s*(.+)$/);

  if (!match) {
    return null;
  }

  const [, id, timestamp, agent, text] = match;

  return {
    id,
    timestamp,
    agent,
    text,
  };
}

/**
 * Parse an inbox file and match with outbox replies
 */
export function parseInboxFile(
  inboxContent: string,
  outboxContent: string,
): InboxItem[] {
  const inboxLines = inboxContent.split("\n");
  const outboxLines = outboxContent.split("\n");

  // Parse all replies first
  const replies = new Map<string, OutboxReply>();
  for (const line of outboxLines) {
    const reply = parseOutboxLine(line);
    if (reply) {
      replies.set(reply.id, reply);
    }
  }

  // Parse inbox items and match replies
  const items: InboxItem[] = [];
  for (const line of inboxLines) {
    const item = parseInboxLine(line);
    if (item) {
      const reply = replies.get(item.id);
      if (reply) {
        item.status = "answered";
        item.reply = reply;
      }
      items.push(item);
    }
  }

  return items;
}

/**
 * Format an instruction for the inbox file
 */
export function formatInboxEntry(text: string): { line: string; id: string } {
  const id = randomUUID().slice(0, 8);
  const timestamp = new Date().toISOString();
  const line = `- OWNER ${timestamp} [${id}]: ${text}`;
  return { line, id };
}

/**
 * Parse owner decision requests from queue lines
 * Format: - OWNER? <question>
 */
export function parseOwnerDecision(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- OWNER?")) {
    return null;
  }
  return trimmed.slice(8).trim();
}

/**
 * Get pending owner decisions from queue content
 */
export function getOwnerDecisions(queueContent: string): string[] {
  const decisions: string[] = [];
  for (const line of queueContent.split("\n")) {
    const decision = parseOwnerDecision(line);
    if (decision) {
      decisions.push(decision);
    }
  }
  return decisions;
}
