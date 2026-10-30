/**
 * Live update types for real-time dashboard updates.
 *
 * The server pushes change events through the WebSocket: each module emits
 * typed messages `{topic, id, change}` so the client updates only the rows
 * that changed.
 */

/**
 * Topics the server can push updates for.
 * Each module that produces state the dashboard shows has a topic.
 */
export type LiveTopic =
  | "dragons"     // Agent status changes
  | "gates"       // Gate queue and result changes
  | "machines"    // Machine health changes
  | "decisions"   // Decision raised, answered, withdrawn
  | "prs"         // PR state changes (reviews, merges)
  | "agents"      // Agents module run changes (fill, holds)
  | "bus"         // Bus reports and messages
  | "planner"     // Planner proposals and tasks file
  | "delivery"    // Environment status changes
  | "triage"      // Triage classification and re-check results
  | "placement"   // Placement moves
  | "watchdog";   // SLO breaches, playbook runs

/**
 * The kind of change to a row.
 */
export type ChangeKind = "insert" | "update" | "delete";

/**
 * A live update message from the server.
 * The client looks up the row by `id` and applies the change.
 */
export interface LiveUpdate<T = unknown> {
  topic: LiveTopic;
  /** The row's id (gate id, agent id, decision id, ...) */
  id: string;
  change: ChangeKind;
  /**
   * The new state of the row (omitted on delete).
   * Typed per topic by the receiving hook.
   */
  data?: T;
  /** ISO timestamp when the change happened */
  timestamp: string;
}

/**
 * A batch of updates (when multiple rows change at once, e.g. gate steps).
 */
export interface LiveBatch {
  topic: LiveTopic;
  updates: Array<{ id: string; change: ChangeKind; data?: unknown }>;
  timestamp: string;
}

/**
 * Message types the server sends to clients.
 */
export interface LiveServerMessage {
  type: "connected" | "subscribed" | "unsubscribed" | "update" | "batch" | "error" | "pong";
  sessionId?: string;
  channel?: string;
  channels?: string[];
  data?: LiveUpdate | LiveBatch;
  error?: string;
  timestamp: string;
}

/**
 * Message types the client sends to the server.
 */
export interface LiveClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channels?: string[];
}

/**
 * Dragon update data shape.
 */
export interface DragonLiveData {
  id: string;
  running?: boolean;
  task?: string;
  lastLogLine?: string;
  lastLogTime?: string;
}

/**
 * Gate update data shape.
 */
export interface GateLiveData {
  id: string;
  lane?: string;
  status?: "queued" | "running" | "completed";
  rc?: number;
  currentStep?: string;
  startTime?: string;
  finishedAt?: string;
}

/**
 * Decision update data shape.
 */
export interface DecisionLiveData {
  id: string;
  status?: "open" | "answered" | "expired" | "withdrawn";
  answeredBy?: string;
  answeredAt?: string;
}

/**
 * Machine update data shape.
 */
export interface MachineLiveData {
  name: string;
  up?: boolean;
  lastCheck?: string;
  runners?: Array<{ lane: string; running: boolean }>;
}

/**
 * PR update data shape.
 */
export interface PrLiveData {
  number: number;
  state?: "open" | "merged" | "closed";
  reviewVerdict?: "approved" | "changes_requested" | "pending";
  gateStatus?: "passed" | "failed" | "pending";
}

/**
 * Bus report data shape (for Activity feed).
 */
export interface BusReportLiveData {
  id: number;
  agent: string;
  kind: "WAITING" | "DONE" | "BLOCKED" | "PROGRESS" | "TICK";
  task?: string;
  summary: string;
  gateId?: string;
  prNumber?: number;
  sha?: string;
}

/**
 * Bus message data shape (for Activity feed).
 */
export interface BusMessageLiveData {
  id: number;
  from: string;
  to: string;
  text: string;
  priority?: number;
  state: "sent" | "read" | "ack";
  ackNote?: string;
}
