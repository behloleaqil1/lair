/**
 * Requests that change something go out as the owner's: they carry this
 * browser's owner session (owner-session.ts), and without one the server
 * answers 403 (src/server/human-auth/). One helper per action a view takes,
 * kept apart from the components so tests send the same requests to the
 * real routes.
 *
 * Each helper resolves with the server's `{success, data, error}` envelope,
 * as the views read it; it does not throw on a refusal.
 */
import { ownerHeaders } from "./owner-session";
import type { CommandResult, DragonStartRequest, DragonStopRequest } from "../shared/types";

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** `?project=` (none for an empty name: the server's default project) */
function query(project: string): string {
  return project ? `?project=${encodeURIComponent(project)}` : "";
}

/** POST as the owner: JSON when there is a body, and this browser's owner session. */
export async function ownerPost<T = unknown>(url: string, body?: unknown): Promise<ApiEnvelope<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...ownerHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as ApiEnvelope<T>;
}

// ============ CONTROLS ============

export function startDragon(project: string, request: DragonStartRequest): Promise<ApiEnvelope<CommandResult>> {
  return ownerPost<CommandResult>(`/api/controls/dragon/start${query(project)}`, request);
}

export function stopDragon(project: string, request: DragonStopRequest): Promise<ApiEnvelope<CommandResult>> {
  return ownerPost<CommandResult>(`/api/controls/dragon/stop${query(project)}`, request);
}

/** The command bar's ask (a question to the orchestrator) and task (agent run) modes. */
export function runCommand(
  project: string,
  command: "ask" | "agent/run",
  body: { text: string } | { task: string },
): Promise<ApiEnvelope<CommandResult>> {
  return ownerPost<CommandResult>(`/api/controls/${command}${query(project)}`, body);
}

// ============ BUS ============

/** A message from the owner, on the fleet bus. */
export function sendBusMessage(
  project: string,
  to: string,
  text: string,
): Promise<ApiEnvelope<{ success: boolean; message_id: string; to: string }>> {
  return ownerPost(`/api/bus/send${query(project)}`, { to, text });
}

// ============ PROCESSES ============

export function processAction(
  project: string,
  processId: string,
  action: "start" | "stop" | "restart",
): Promise<ApiEnvelope> {
  return ownerPost(`/api/processes/${encodeURIComponent(processId)}/${action}${query(project)}`);
}

// ============ SETTINGS ============

export function saveSettings(project: string, updates: Record<string, unknown>): Promise<ApiEnvelope> {
  return ownerPost(`/api/settings${query(project)}`, updates);
}

// ============ PIPELINES ============

export function startPipelineRun<T>(project: string, body: { pipeline: string; sha?: string; branch?: string }): Promise<ApiEnvelope<T>> {
  return ownerPost<T>(`/api/pipelines/runs${query(project)}`, body);
}

export function cancelPipelineRun<T>(project: string, id: string): Promise<ApiEnvelope<T>> {
  return ownerPost<T>(`/api/pipelines/runs/${encodeURIComponent(id)}/cancel${query(project)}`);
}
