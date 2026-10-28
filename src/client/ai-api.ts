/**
 * The AI tools API's requests (src/server/ai/routes.ts), with this browser's
 * owner session: every route is the owner's, reads included, since they run
 * the tools' own checks and show who is signed in where.
 */
import type { AiModelsView, AiToolsView } from "../shared/ai-types";
import { ownerCall, type SettingsReply } from "./settings-api";

/** Every tool the project can use, per machine: installed, version, sign-in (cached a minute by the server). */
export function loadAiTools(project: string): Promise<SettingsReply<AiToolsView>> {
  return ownerCall("GET", `/api/ai/tools?project=${encodeURIComponent(project)}`);
}

/** The same, every tool checked again now (Settings → AI's Refresh). */
export function refreshAiTools(project: string): Promise<SettingsReply<AiToolsView>> {
  return ownerCall("POST", "/api/ai/tools/refresh", { project });
}

/** The models a tool offers on this machine: its own list command's, else its known list (cached an hour). */
export function loadAiModels(project: string, tool: string): Promise<SettingsReply<AiModelsView>> {
  return ownerCall("GET", `/api/ai/models?tool=${encodeURIComponent(tool)}&project=${encodeURIComponent(project)}`);
}

/** The same, the list read again now. */
export function refreshAiModels(project: string, tool: string): Promise<SettingsReply<AiModelsView>> {
  return ownerCall("POST", "/api/ai/models/refresh", { tool, project });
}
