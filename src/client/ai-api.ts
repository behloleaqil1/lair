/**
 * The AI tools API's requests (src/server/ai/routes.ts), with this browser's
 * owner session: every route is the owner's, reads included, since they run
 * the tools' own checks and show who is signed in where.
 */
import type { AiToolsView } from "../shared/ai-types";
import { ownerCall, type SettingsReply } from "./settings-api";

/** Every tool the project can use, per machine: installed, version, sign-in (cached a minute by the server). */
export function loadAiTools(project: string): Promise<SettingsReply<AiToolsView>> {
  return ownerCall("GET", `/api/ai/tools?project=${encodeURIComponent(project)}`);
}
