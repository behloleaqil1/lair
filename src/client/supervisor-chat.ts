/**
 * The supervisor's chat and digest in the dashboard (src/server/supervisor/chat.ts):
 * asking (POST /api/supervisor/ask), reading a conversation while its run
 * looks (polled every POLL_MS while a question is pending), and what each
 * question's state reads as. The owner's only, like the routes.
 */
import type { ChatStatusView, ConversationTurn, ConversationView } from "../shared/supervisor-types";
import { ownerPost, type ApiEnvelope } from "./owner-actions";
import { fetchApi, ownerHeaders } from "./owner-session";

/** How often an open conversation is read again while a question waits for its answer */
export const POLL_MS = 3000;

export const LOOKING = "Lair is looking…";

/** Ask the supervisor: a new conversation, or the next question of `conversationId`. */
export function askSupervisor(
  project: string,
  question: string,
  conversationId?: string | null,
): Promise<ApiEnvelope<{ conversation: ConversationView }>> {
  return ownerPost<{ conversation: ConversationView }>("/api/supervisor/ask", {
    ...(project ? { project } : {}),
    question,
    ...(conversationId ? { conversationId } : {}),
  });
}

export function fetchConversation(id: string): Promise<ConversationView> {
  return fetchApi<ConversationView>(`/api/supervisor/conversations/${encodeURIComponent(id)}`, { headers: ownerHeaders() });
}

/** A question still waits for its answer: keep reading the conversation. */
export function hasPending(conversation: ConversationView | null): boolean {
  return conversation?.turns.some((t) => t.state === "pending") ?? false;
}

/** What a question's state reads as. */
export function turnStatus(turn: ConversationTurn): { label: string; tone: "neutral" | "success" | "warning" } {
  if (turn.state === "pending") return { label: LOOKING, tone: "neutral" };
  if (turn.state === "answered") return { label: "Answered", tone: "success" };
  return { label: "No answer", tone: "warning" };
}

/**
 * The Ask tab starts a supervisor conversation (rather than the orchestrator's
 * ask command) once questions are on: when they can't be answered now (no
 * supervisor agent, the agents module off), the chat panel says why.
 */
export function askGoesToSupervisor(status: ChatStatusView | null | undefined): boolean {
  return status?.enabled === true;
}

/** Why the owner can't ask now, in a line; null when they can. */
export function chatHint(status: ChatStatusView | null | undefined): string | null {
  if (!status) return null;
  if (!status.enabled) {
    return "Questions to Lair's supervisor are off. Turn them on with supervisor.chat.enabled: true and a supervisor agent (Settings, or the project's YAML): each question is one run of that agent.";
  }
  if (status.problem) return status.problem;
  return null;
}

/** "3 of 20 runs today", and when the next may start. */
export function limitsLine(status: ChatStatusView): string {
  const parts = [`${status.runsToday} of ${status.limits.maxRunsPerDay} supervisor runs in the last 24 hours`];
  if (status.agent) parts.push(`answered by ${status.agent}`);
  return parts.join(", ");
}
