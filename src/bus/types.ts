/**
 * Types for the lair-bus MCP server
 */
import { z } from "zod";

// ============ Report types ============

export const ReportKind = z.enum([
  "WAITING",
  "DONE",
  "BLOCKED",
  "PROGRESS",
  "TICK",
]);
export type ReportKind = z.infer<typeof ReportKind>;

// ============ Tool input schemas ============

export const ClaimInput = z.object({
  task: z.string().min(1, "Task name required"),
});

export const ReleaseInput = z.object({
  task: z.string().min(1, "Task name required"),
});

export const ReportInput = z.object({
  kind: ReportKind,
  task: z.string().min(1, "Task name required"),
  summary: z.string().min(1, "Summary required"),
  gate_id: z.string().optional(),
  pr: z.number().int().positive().optional(),
  sha: z.string().optional(),
});

export const InboxInput = z.object({});

export const AckInput = z.object({
  message_id: z.string().min(1, "Message ID required"),
  note: z.string().optional(),
});

export const SendInput = z.object({
  to: z.string().min(1, "Recipient required"),
  text: z.string().min(1, "Message text required"),
  priority: z.number().int().min(1).max(10).optional(),
});

export const BoardInput = z.object({});

export const WhoamiInput = z.object({});

// ============ Database records ============

export interface AgentRecord {
  id: string;
  display_name: string | null;
  last_seen: string;
}

export interface ClaimRecord {
  id: number;
  task: string;
  owner_id: string;
  claimed_at: string;
  released_at: string | null;
}

export interface ReportRecord {
  id: number;
  agent_id: string;
  kind: ReportKind;
  task: string;
  summary: string;
  gate_id: string | null;
  pr: number | null;
  sha: string | null;
  created_at: string;
}

export interface MessageRecord {
  id: string;
  from_id: string;
  to_id: string;
  text: string;
  priority: number;
  created_at: string;
  read_at: string | null;
  ack_at: string | null;
  ack_note: string | null;
}

// ============ Tool outputs ============

export interface WhoamiOutput {
  agent_id: string;
  display_name: string | null;
  claims: string[];
}

export interface ClaimOutput {
  success: boolean;
  task: string;
  owner: string;
  message: string;
}

export interface ReleaseOutput {
  success: boolean;
  task: string;
  message: string;
}

export interface ReportOutput {
  success: boolean;
  id: number;
  mirrored_to: string[];
}

export interface InboxMessage {
  id: string;
  from: string;
  text: string;
  priority: number;
  sent_at: string;
}

export interface AckOutput {
  success: boolean;
  message_id: string;
}

export interface SendOutput {
  success: boolean;
  message_id: string;
  to: string;
}

export interface TaskStatus {
  task: string;
  owner: string | null;
  last_report: {
    kind: ReportKind;
    summary: string;
    time: string;
    gate_id?: string;
    pr?: number;
    sha?: string;
  } | null;
}

export interface BoardOutput {
  tasks: TaskStatus[];
  agents: {
    id: string;
    display_name: string | null;
    claims: string[];
    last_seen: string;
  }[];
}

// ============ Project config for bus ============

export interface BusProjectConfig {
  name: string;
  queue_file: string;
  inbox_file?: string;
  mail_dir?: string;
  wake_file?: string;
}
