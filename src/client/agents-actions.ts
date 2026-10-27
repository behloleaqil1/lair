/**
 * Agents view actions: starting a run, the two that stop work (release a
 * claim, start a fresh session), and releasing a task fill holds for the
 * owner. Each asks for confirmation first, and only a
 * confirmed action is sent, with this browser's owner session (only the owner
 * may take them); the stopping ones also send `confirm: true` (the server
 * refuses them without). The start-run form's "Load a prompt" select reads
 * the project's prompts_dir through two owner-only GETs.
 */
import { fetchApi, ownerHeaders } from "./owner-session";
import type { AgentView, PromptFileText, PromptFileView } from "../shared/agents-types";

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
  /** The HTTP status of a refusal, when known */
  status?: number;
}

/** The API envelope of a POST, with the HTTP status when the request got an answer. */
export interface PostResult {
  success: boolean;
  error?: string;
  status?: number;
}

type Post = (url: string, body: Record<string, unknown>) => Promise<PostResult>;

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

/** Release a task fill holds for the owner (POST /api/agents/fill/release): fill starts it again. */
export function releaseFillHoldAction(project: string, task: string, agent: string): ConfirmableAction {
  return {
    question: `Let fill start ${task} again? Fill starts ${agent} on it on its next check, and counts its runs without a done line from zero.`,
    url: withProject("/api/agents/fill/release", project),
    body: { task, confirm: true },
  };
}

/** What the start-run form sends: POST /api/agents/runs {agent, task, prompt, model?} */
export interface StartRunInput {
  agent: string;
  task: string;
  prompt: string;
  /** One of the agent's models (modelsOf); empty or absent: the agent's default */
  model?: string;
}

export function startRunAction(project: string, input: StartRunInput): ConfirmableAction {
  const task = input.task.trim();
  const model = input.model ? input.model : undefined;
  return {
    question: `Start ${input.agent} on ${task} with ${model ? `model ${model}` : "its default model"}? The task is claimed now, and the run starts on the next check.`,
    url: withProject("/api/agents/runs", project),
    body: { agent: input.agent, task, prompt: input.prompt, ...(model ? { model } : {}) },
  };
}

/** The models a run of `agent` may ask for: its profiles' (its own, then its fallbacks'), each once. */
export function modelsOf(agent: AgentView): string[] {
  return [...new Set(agent.profiles.map((p) => p.model).filter((m): m is string => typeof m === "string" && m.length > 0))];
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
    if (response.success) return { sent: true, ok: true };
    return {
      sent: true,
      ok: false,
      error: response.error ?? "failed",
      ...(response.status !== undefined ? { status: response.status } : {}),
    };
  } catch (e) {
    return { sent: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What to tell the owner when a sent action failed, by the server's status. */
export function failureMessage(result: ActionResult): string {
  const error = result.error ?? "failed";
  switch (result.status) {
    case 400:
      return `Invalid request (400): ${error}`;
    case 403:
      return /only the owner/i.test(error)
        ? `Refused (403): ${error}. Sign this browser in as the owner from the Decisions view.`
        : `Refused (403): ${error}`;
    case 404:
      return `Not found (404): ${error}`;
    case 409:
      return `Conflict (409): ${error}`;
    case undefined:
      return `Failed: ${error}`;
    default:
      return `Failed (${result.status}): ${error}`;
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

/** POST an owner-only request with fetch, returning the API envelope and the HTTP status. */
export async function postJson(url: string, body: Record<string, unknown>): Promise<PostResult> {
  const res = await fetch(url, ownerRequest(body));
  let envelope: { success?: unknown; error?: unknown };
  try {
    envelope = (await res.json()) as { success?: unknown; error?: unknown };
  } catch {
    envelope = { success: false, error: `HTTP ${res.status}` };
  }
  return {
    success: envelope.success === true,
    ...(typeof envelope.error === "string" ? { error: envelope.error } : {}),
    status: res.status,
  };
}

// ============ PROMPT FILES (owner only) ============

/** GET: the files in the project's prompts_dir, newest first (basenames only). */
export function promptsUrl(project: string): string {
  return withProject("/api/agents/prompts", project);
}

/** GET: one prompt file's text, by its basename. */
export function promptFileUrl(project: string, name: string): string {
  return `${withProject("/api/agents/prompts/file", project)}&name=${encodeURIComponent(name)}`;
}

/** The prompt files the form offers; 403 unless this browser is signed in as the owner. */
export function listPrompts(project: string): Promise<PromptFileView[]> {
  return fetchApi<PromptFileView[]>(promptsUrl(project), { headers: ownerHeaders() });
}

/** One prompt file's text, to load into the form's prompt. */
export function loadPrompt(project: string, name: string): Promise<PromptFileText> {
  return fetchApi<PromptFileText>(promptFileUrl(project, name), { headers: ownerHeaders() });
}
