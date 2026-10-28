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

/** An owner request, answered as a SettingsReply (also used for the AI tools API: ai-api.ts). */
export async function ownerCall<T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown): Promise<SettingsReply<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...ownerHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, success: false, error: e instanceof Error ? e.message : "Network error" };
  }
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
  return ownerCall("GET", "/api/settings/modules");
}

export function listSettingsProjects(): Promise<SettingsReply<{ projects: ProjectFileInfo[] }>> {
  return ownerCall("GET", "/api/settings/projects");
}

export function loadProjectSettings(id: string): Promise<SettingsReply<ProjectSettingsView>> {
  return ownerCall("GET", project(id));
}

export function saveProjectSettings(id: string, request: SaveRequest): Promise<SettingsReply<SaveResult>> {
  return ownerCall("PUT", project(id), request);
}

/** A save's dry run: the diff, the errors and the command changes, nothing written. */
export function checkProjectSettings(id: string, request: SaveRequest): Promise<SettingsReply<SettingsCheck>> {
  return ownerCall("POST", "/api/settings/validate", { project: id, ...request });
}

export function checkNewProject(request: CreateProjectRequest): Promise<SettingsReply<SettingsCheck>> {
  return ownerCall("POST", "/api/settings/validate", { create: request });
}

export function createProject(request: CreateProjectRequest): Promise<SettingsReply<SaveResult & { id: string; file: string }>> {
  return ownerCall("POST", "/api/settings/projects", request);
}

export function checkRepository(path: string): Promise<SettingsReply<RepoCheck>> {
  return ownerCall("POST", "/api/settings/repo", { path });
}

export function loadHistory(id: string): Promise<SettingsReply<{ versions: HistoryVersion[] }>> {
  return ownerCall("GET", `${project(id)}/history`);
}

export function loadVersion(id: string, version: string): Promise<SettingsReply<HistoryDetail>> {
  return ownerCall("GET", `${project(id)}/history/${encodeURIComponent(version)}`);
}

export function checkRestore(id: string, version: string, baseHash: string): Promise<SettingsReply<SettingsCheck>> {
  return ownerCall("POST", "/api/settings/validate", { project: id, restore: version, baseHash });
}

export function restoreVersion(
  id: string,
  version: string,
  request: { baseHash: string; confirmCommands?: string },
): Promise<SettingsReply<SaveResult>> {
  return ownerCall("POST", `${project(id)}/history/${encodeURIComponent(version)}/restore`, request);
}
