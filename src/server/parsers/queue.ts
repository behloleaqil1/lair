/**
 * Queue file parser - pure functions for parsing the project's queue file (queue_file)
 */
import type { QueueLine, QueueLineType } from "../../shared/types.js";

/**
 * Parse a single queue line into structured data
 */
export function parseQueueLine(line: string): QueueLine | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("-")) {
    return null;
  }

  // Remove leading "- "
  const content = trimmed.slice(2).trim();

  // Detect type and parse accordingly
  const type = detectLineType(content);

  // Extract timestamp - formats: "HH:MMZ", "YYYY-MM-DDTHH:MM:SSZ", or embedded in parens
  const timestampMatch = content.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|\d{2}:\d{2}Z)/,
  );
  const timestamp = timestampMatch?.[1];

  const agent = extractAgent(content);

  // Extract gate ID - pattern like "20260101T000000Z-example-track-abcdef12-12345"
  const gateIdMatch = content.match(
    /(\d{8}T\d{6}Z-[a-zA-Z0-9-]+-[a-f0-9]+-\d+)/,
  );
  const gateId = gateIdMatch?.[1];

  // Extract task name from various patterns
  const task = extractTask(content, type);

  return {
    raw: line,
    type,
    timestamp,
    agent,
    task,
    gateId,
    message: content,
  };
}

/** An agent ID: letter first, then letters, digits, "_" or "-" (see isValidDragonId). */
const AGENT_ID = "[A-Za-z](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?";

/**
 * "by <agent>" where the agent is followed by "(Name)", "HH:MMZ", ":" or
 * the end of the line, as in "DONE fix-login by aider-1 (Saphira) 14:35Z: ...".
 * The lookahead keeps prose such as "blocked by missing config" from matching.
 */
const BY_AGENT = new RegExp(
  `\\bby\\s+(${AGENT_ID})(?=\\s*(?:\\(|\\d{1,2}:\\d{2}Z|:|$))`,
);

/** "(<agent>, ...)" prefix of an orchestrator-style line; the agent ID contains a "-". */
const PAREN_AGENT = /^\(([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]+),/;

/**
 * Orchestrator-style line: a "(<agent-id>, HH:MMZ ...)" prefix, as in
 * "(orchestrator, 18:15Z) assigning kiro-F", or an "ORCHESTRATOR:" marker.
 */
const ORCHESTRATOR_PREFIX = new RegExp(`^\\(${AGENT_ID},\\s*\\d{1,2}:\\d{2}Z`);
const ORCHESTRATOR_MARKER = /\bORCHESTRATOR:/;

/**
 * Extract the agent ID from a queue line: "by <agent>", else a
 * "(<agent>, ...)" prefix, else a kiro-style ID ("kiro-X") anywhere.
 */
function extractAgent(content: string): string | undefined {
  return (
    content.match(BY_AGENT)?.[1] ??
    content.match(PAREN_AGENT)?.[1] ??
    content.match(/(kiro-[A-Z])/i)?.[1]
  );
}

/**
 * Detect the type of queue line
 */
export function detectLineType(content: string): QueueLineType {
  const upper = content.toUpperCase();

  if (upper.startsWith("WAITING")) return "WAITING";
  if (upper.startsWith("DONE")) return "DONE";
  if (upper.startsWith("BLOCKED")) return "BLOCKED";
  if (upper.startsWith("PROGRESS")) return "PROGRESS";
  if (upper.startsWith("TICK")) return "TICK";
  if (ORCHESTRATOR_PREFIX.test(content) || ORCHESTRATOR_MARKER.test(content)) {
    return "ORCHESTRATOR";
  }

  return "OTHER";
}

/**
 * Extract task name from queue line content
 */
function extractTask(content: string, type: QueueLineType): string | undefined {
  // Common patterns:
  // "DONE example-track-r2 task by kiro-X"
  // "WAITING #42 example-track-r3 CRITICAL"
  // "BLOCKED example-runners by kiro-Y"

  if (
    type === "DONE" ||
    type === "WAITING" ||
    type === "BLOCKED" ||
    type === "PROGRESS"
  ) {
    // Remove the type prefix and extract first word(s) as task
    const afterType = content.replace(
      /^(DONE|WAITING|BLOCKED|PROGRESS)\s+/i,
      "",
    );
    const taskMatch = afterType.match(/^([#\w-]+(?:\s+[#\w-]+)?)/);
    return taskMatch?.[1];
  }

  return undefined;
}

/**
 * Parse multiple queue lines from file content
 */
export function parseQueueFile(content: string): QueueLine[] {
  const lines = content.split("\n");
  const parsed: QueueLine[] = [];

  for (const line of lines) {
    const result = parseQueueLine(line);
    if (result) {
      parsed.push(result);
    }
  }

  return parsed;
}

/**
 * Filter queue lines by type
 */
export function filterByType(
  lines: QueueLine[],
  types: QueueLineType[],
): QueueLine[] {
  return lines.filter((line) => types.includes(line.type));
}

/**
 * Filter queue lines by agent
 */
export function filterByAgent(
  lines: QueueLine[],
  agentId: string,
): QueueLine[] {
  return lines.filter(
    (line) => line.agent?.toLowerCase() === agentId.toLowerCase(),
  );
}

/**
 * Get lines from the last N days
 */
export function filterByDays(lines: QueueLine[], days: number): QueueLine[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return lines.filter((line) => {
    if (!line.timestamp) return false;
    // Handle both full ISO and short HH:MMZ formats
    const ts = line.timestamp.includes("T")
      ? new Date(line.timestamp)
      : new Date(); // For short format, assume today
    return ts >= cutoff;
  });
}

/**
 * Get TICK lines (orchestrator heartbeats)
 */
export function getTickLines(
  lines: QueueLine[],
  limit: number = 30,
): QueueLine[] {
  return filterByType(lines, ["TICK"]).slice(-limit);
}

/**
 * Calculate agent stats from queue lines
 */
export function calculateAgentStats(
  lines: QueueLine[],
  agentId: string,
): {
  doneCount: number;
  waitingCount: number;
  blockedCount: number;
  gateIds: string[];
} {
  const agentLines = filterByAgent(lines, agentId);

  const doneCount = agentLines.filter((l) => l.type === "DONE").length;
  const waitingCount = agentLines.filter((l) => l.type === "WAITING").length;
  const blockedCount = agentLines.filter((l) => l.type === "BLOCKED").length;

  const gateIds = agentLines
    .filter((l) => l.gateId)
    .map((l) => l.gateId!)
    .filter((id, i, arr) => arr.indexOf(id) === i); // unique

  return { doneCount, waitingCount, blockedCount, gateIds };
}
