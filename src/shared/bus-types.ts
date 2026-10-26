/**
 * Bus types - Shared types for the fleet bus
 *
 * These types define the structure of bus events that flow between
 * the MCP server (src/bus), the Lair server, and the browser.
 */

// Report kinds from the bus
export type ReportKind = "WAITING" | "DONE" | "BLOCKED" | "PROGRESS" | "TICK";

// Base bus event type
export interface BusEvent {
  id: number;
  event_type: "report" | "message" | "claim" | "ack";
  timestamp: string;
  agent_id?: string;
  project: string;
}

// Report event (agent status updates)
export interface BusReportEvent extends BusEvent {
  event_type: "report";
  kind: ReportKind;
  task?: string;
  summary: string;
  gate_id?: string;
  pr_number?: number;
  sha?: string;
}

// Message event (instructions between agents/owner/orchestrator)
export interface BusMessageEvent extends BusEvent {
  event_type: "message";
  from_agent: string;
  to_agent: string;
  text: string;
  priority?: number;
  read_at?: string;
  ack_at?: string;
  ack_note?: string;
}

// Claim event (task ownership)
export interface BusClaimEvent extends BusEvent {
  event_type: "claim";
  task: string;
  action: "claim" | "release";
  success: boolean;
  owner?: string;
}

// Ack event (message acknowledgment)
export interface BusAckEvent extends BusEvent {
  event_type: "ack";
  message_id: number;
  note: string;
}

// Union type for all bus events
export type AnyBusEvent =
  | BusReportEvent
  | BusMessageEvent
  | BusClaimEvent
  | BusAckEvent;

// Message delivery state for the UI
export type MessageDeliveryState = "sent" | "read" | "ack";

// Structured message for UI display
export interface BusMessage {
  id: number;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  priority?: number;
  state: MessageDeliveryState;
  ackNote?: string;
}

// Structured report for UI display
export interface BusReport {
  id: number;
  agent: string;
  kind: ReportKind;
  task?: string;
  summary: string;
  timestamp: string;
  gateId?: string;
  prNumber?: number;
  sha?: string;
}

// Task claim for UI display
export interface BusClaim {
  task: string;
  owner?: string;
  claimedAt?: string;
}

// SSE event wrapper sent to browser
export interface SSEEvent {
  type: "report" | "message" | "claim" | "ack" | "init" | "heartbeat";
  data: AnyBusEvent | BusReport[] | BusMessage[] | BusClaim[] | null;
  timestamp: string;
}
