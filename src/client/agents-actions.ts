/**
 * Agents view actions that stop work (release a claim, start a fresh
 * session). Each asks for confirmation first, and only a confirmed action is
 * sent, with `confirm: true` (the server refuses it without) and this
 * browser's owner session (only the owner may take them).
 */
import { ownerHeaders } from "./owner-session";

export interface ConfirmableAction {
  /** The question the confirmation dialog asks */
  question: string;
  url: string;
  body: Record<string, unknown>;
}

export interface ActionResult {
  sent: boolean;
  ok: boolean;
  error?: string;
}

type Post = (url: string, body: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;

const withProject = (path: string, project: string) => `${path}?project=${encodeURIComponent(project)}`;

export function releaseClaimAction(project: string, task: string, agent: string): ConfirmableAction {
  return {
    question: `Release the claim on ${task}? The run of ${agent} that holds it stops, and the task is free for another run.`,
    url: withProject("/api/agents/claims/release", project),
    body: { task, confirm: true },
  };
}

export function freshSessionAction(project: string, runId: string, agent: string, task: string): ConfirmableAction {
  return {
    question: `Start ${task} again in a fresh session? A running ${agent} is stopped first, and its session is moved aside (not deleted).`,
    url: withProject(`/api/agents/runs/${encodeURIComponent(runId)}/fresh-session`, project),
    body: { confirm: true },
  };
}

/** Ask, then send. Nothing is sent when the question is declined. */
export async function runConfirmed(
  action: ConfirmableAction,
  confirm: (question: string) => boolean,
  post: Post,
): Promise<ActionResult> {
  if (!confirm(action.question)) return { sent: false, ok: false };
  try {
    const response = await post(action.url, action.body);
    return response.success ? { sent: true, ok: true } : { sent: true, ok: false, error: response.error ?? "failed" };
  } catch (e) {
    return { sent: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ActionRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * The request for an owner-only agents route: JSON, with this browser's owner
 * session (`ownerHeaders()`, src/client/owner-session.ts). Without one the
 * server answers 403: sign in from the Decisions view first.
 */
export function ownerRequest(body: Record<string, unknown>, headers: Record<string, string> = ownerHeaders()): ActionRequest {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** POST an owner-only request with fetch, returning the API envelope. */
export async function postJson(url: string, body: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(url, ownerRequest(body));
  return (await res.json()) as { success: boolean; error?: string };
}
