/**
 * The Settings view's requests (src/server/settings/routes.ts). Every one
 * carries this browser's owner session: the server answers 403 without it,
 * reads included. Each resolves with the HTTP status and the server's
 * envelope; refusals (409, 422, 428) carry the check in `check`.
 */
import { ownerHeaders } from "./owner-session";
import type {
  CreateProjectRequest,
  HistoryDetail,
  HistoryVersion,
  ProjectFileInfo,
  ProjectSettingsView,
  RepoCheck,
  SaveRequest,
  SaveResult,
  SettingsCheck,
  SettingsSection,
} from "../shared/settings-types";

export interface SettingsReply<T> {
  status: number;
  success: boolean;
  data?: T;
  error?: string;
  /** conflict, invalid, confirm_commands, too_large, unsafe_file... */
  code?: string;
  /** What a refused save would have written, its errors and command changes */
  check?: SettingsCheck;
}

function isCheck(value: unknown): value is SettingsCheck {
  return typeof value === "object" && value !== null && "errors" in value && "diff" in value;
}

async function call<T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown): Promise<SettingsReply<T>> {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...ownerHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: { success?: boolean; data?: unknown; error?: string; message?: string; code?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // Not JSON (a proxy error page): the status says enough
  }
  const success = payload.success === true && res.status < 400;
  return {
    status: res.status,
    success,
    data: success ? (payload.data as T) : undefined,
    error: success ? undefined : (payload.error ?? payload.message ?? `HTTP ${res.status}`),
    code: payload.code,
    check: !success && isCheck(payload.data) ? payload.data : undefined,
  };
}

const project = (id: string) => `/api/settings/projects/${encodeURIComponent(id)}`;

export function loadSections(): Promise<SettingsReply<{ sections: SettingsSection[] }>> {
  return call("GET", "/api/settings/modules");
}

export function listSettingsProjects(): Promise<SettingsReply<{ projects: ProjectFileInfo[] }>> {
  return call("GET", "/api/settings/projects");
}

export function loadProjectSettings(id: string): Promise<SettingsReply<ProjectSettingsView>> {
  return call("GET", project(id));
}

export function saveProjectSettings(id: string, request: SaveRequest): Promise<SettingsReply<SaveResult>> {
  return call("PUT", project(id), request);
}

/** A save's dry run: the diff, the errors and the command changes, nothing written. */
export function checkProjectSettings(id: string, request: SaveRequest): Promise<SettingsReply<SettingsCheck>> {
  return call("POST", "/api/settings/validate", { project: id, ...request });
}

export function checkNewProject(request: CreateProjectRequest): Promise<SettingsReply<SettingsCheck>> {
  return call("POST", "/api/settings/validate", { create: request });
}

export function createProject(request: CreateProjectRequest): Promise<SettingsReply<SaveResult & { id: string; file: string }>> {
  return call("POST", "/api/settings/projects", request);
}

export function checkRepository(path: string): Promise<SettingsReply<RepoCheck>> {
  return call("POST", "/api/settings/repo", { path });
}

export function loadHistory(id: string): Promise<SettingsReply<{ versions: HistoryVersion[] }>> {
  return call("GET", `${project(id)}/history`);
}

export function loadVersion(id: string, version: string): Promise<SettingsReply<HistoryDetail>> {
  return call("GET", `${project(id)}/history/${encodeURIComponent(version)}`);
}

export function checkRestore(id: string, version: string, baseHash: string): Promise<SettingsReply<SettingsCheck>> {
  return call("POST", "/api/settings/validate", { project: id, restore: version, baseHash });
}

export function restoreVersion(
  id: string,
  version: string,
  request: { baseHash: string; confirmCommands?: string },
): Promise<SettingsReply<SaveResult>> {
  return call("POST", `${project(id)}/history/${encodeURIComponent(version)}/restore`, request);
}
