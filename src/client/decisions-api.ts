/**
 * Decision Inbox requests and the rules the view applies before sending an
 * answer (confirmation for spend and go/no-go, the secret only for an option
 * that supplies it). Kept apart from the components so they can be tested.
 */
import {
  CONFIRM_KINDS,
  type Decision,
  type DecisionCounts,
  type DecisionKind,
  type DecisionOption,
  type DecisionPoliciesStatus,
} from "../shared/decision-types";
import { fetchApi, ownerHeaders } from "./owner-session";

export const KIND_LABELS: Record<DecisionKind, string> = {
  pricing: "Pricing",
  legal: "Legal",
  spend: "Spend",
  account: "Account",
  credentials: "Credentials",
  go_no_go: "Go / no-go",
  security: "Security",
  escalation: "Escalation",
  other: "Other",
};

export interface DecisionSummary extends DecisionCounts {
  /** Where credentials go, e.g. "server memory only (...)" */
  secretStore: string;
}

/**
 * What the nav badge shows: the open action items (notices never count),
 * red while any of them is overdue. A server from before attention sends no
 * `action`: every open decision then needed an answer.
 */
export function badgeCount(counts: Pick<DecisionCounts, "open" | "overdue"> & Partial<DecisionCounts>): {
  count: number;
  overdue: boolean;
} {
  const count = counts.action ?? counts.open;
  return { count, overdue: count > 0 && counts.overdue > 0 };
}

/** A notice: for the owner's information, nothing to choose (an older server's decisions have no attention). */
export function isNoticeDecision(decision: Decision): boolean {
  return decision.attention === "notice";
}

/**
 * The Decisions view's order: open action items (by the server's urgency),
 * then open notices (FYI), then the closed ones.
 */
export function inboxOrder(decisions: readonly Decision[]): { action: Decision[]; notices: Decision[]; closed: Decision[] } {
  const open = decisions.filter((d) => d.status === "open");
  return {
    action: open.filter((d) => !isNoticeDecision(d)),
    notices: open.filter(isNoticeDecision),
    closed: decisions.filter((d) => d.status !== "open"),
  };
}

/** Answers to these kinds go through a confirmation step (and carry confirm: true). */
export function needsConfirmation(kind: DecisionKind): boolean {
  return CONFIRM_KINDS.includes(kind);
}

export interface AnswerDraft {
  optionId: string;
  note: string;
  /** Only read for an option that supplies the secret */
  secret?: string;
}

/** The POST /api/decisions/:id/answer body for a draft. */
export function answerBody(decision: Decision, draft: AnswerDraft): Record<string, unknown> {
  const option = decision.options.find((o) => o.id === draft.optionId);
  const body: Record<string, unknown> = { optionId: draft.optionId };
  const note = draft.note.trim();
  // Credentials decisions take no note: a secret could end up in it
  if (note && decision.kind !== "credentials") body.note = note;
  if (needsConfirmation(decision.kind)) body.confirm = true;
  if (option?.suppliesSecret && draft.secret) body.secret = draft.secret;
  return body;
}

/** What the confirmation step asks. */
export function confirmationText(decision: Decision, option: DecisionOption): string {
  return `${KIND_LABELS[decision.kind]} decision: "${option.label}". ${option.consequences}`;
}

/** How a closed decision ended, in one line. Never includes a secret: the API has none to give. */
export function outcomeText(decision: Decision): string {
  const option = decision.options.find((o) => o.id === decision.answer?.optionId);
  const label = option?.label ?? decision.answer?.optionId ?? "";
  switch (decision.status) {
    case "answered":
      return `${label} (by ${decision.answeredBy ?? "owner"})${decision.answer?.secretSupplied ? "; secret supplied" : ""}`;
    case "expired":
      return `Expired unanswered; its default "${label}" applied`;
    case "withdrawn":
      return `Withdrawn by ${decision.source.module}: ${decision.withdrawnReason ?? ""}`;
    default:
      return "Open";
  }
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

/** The expiry line of an open decision, or null when it has none. */
export function expiryText(decision: Decision, now: number): string | null {
  if (decision.status !== "open" || !decision.expiresAt) return null;
  const at = Date.parse(decision.expiresAt);
  const fallback = decision.options.find((o) => o.id === decision.defaultOptionId);
  if (decision.overdue || at <= now) {
    return fallback
      ? `Expired: "${fallback.label}" applies at the next check`
      : `Overdue by ${span(now - at)}: still waiting for your answer`;
  }
  return fallback
    ? `Expires in ${span(at - now)}; then "${fallback.label}" applies`
    : `Expires in ${span(at - now)}; it keeps waiting after that`;
}

/** Every project's decisions: open first by urgency, then the rest. */
export function listDecisions(): Promise<Decision[]> {
  return fetchApi<Decision[]>("/api/decisions?limit=200");
}

export function decisionSummary(): Promise<DecisionSummary> {
  return fetchApi<DecisionSummary>("/api/decisions/summary");
}

export function getDecision(id: string): Promise<Decision> {
  return fetchApi<Decision>(`/api/decisions/${encodeURIComponent(id)}`);
}

/** Send an answer, as the owner: this browser's owner session goes in its header (owner-session.ts). */
export function postAnswer(id: string, body: Record<string, unknown>): Promise<Decision> {
  return fetchApi<Decision>(`/api/decisions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: JSON.stringify(body),
  });
}

/** The policy table and its shadow agreement with the answers given (owner only). */
export function decisionPolicies(): Promise<DecisionPoliciesStatus> {
  return fetchApi<DecisionPoliciesStatus>("/api/owner/decision-policies", { headers: ownerHeaders() });
}

/** "93%" for a ratio, "-" while there is nothing to compare. */
export function percent(ratio: number | null): string {
  return ratio === null ? "-" : `${Math.round(ratio * 100)}%`;
}
