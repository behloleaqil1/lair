/**
 * The config-error banner (GET /api/config/status) and the owner's Restart
 * (GET/POST /api/owner/restart), kept apart from the components so tests
 * send the same requests to the real routes.
 */
import { fetchApi, ownerHeaders } from "./owner-session";
import { ownerPost, type ApiEnvelope } from "./owner-actions";
import type { ConfigProblem, ConfigStatusView, RestartStatusView } from "../shared/lifecycle-types";

export function configStatus(): Promise<ConfigStatusView> {
  return fetchApi<ConfigStatusView>("/api/config/status");
}

/** The banner's text for a project file whose latest version is not running. */
export function problemText(problem: ConfigProblem): string {
  return problem.previousRunning
    ? `${problem.file} has an error; the previous config is still running: ${problem.error}`
    : `${problem.file} has an error: ${problem.error}`;
}

/** The restart state (owner only). */
export function restartStatus(): Promise<RestartStatusView> {
  return fetchApi<RestartStatusView>("/api/owner/restart", { headers: ownerHeaders() });
}

/** Restart, or update and then restart (owner only): 202 with the state. */
export function requestRestart(update: boolean): Promise<ApiEnvelope<RestartStatusView>> {
  return ownerPost<RestartStatusView>("/api/owner/restart", update ? { update: true } : {});
}

/** What the confirmation asks. */
export function restartQuestion(update: boolean, status: RestartStatusView): string {
  const steps = status.update.steps.map((argv) => argv.join(" ")).join(", then ");
  const what = update
    ? `Update Lair (${steps}) and then restart it? If a step fails, Lair is not restarted.`
    : "Restart Lair?";
  const manager = status.serviceManager.name ? status.serviceManager.note : `Warning: ${status.serviceManager.note}`;
  return `${what}\n\nIt shuts down as on a stop (agents keep running) and exits; ${manager}`;
}

/** The note shown beside the buttons when nothing may start Lair again, else null. */
export function managerWarning(status: RestartStatusView): string | null {
  return status.serviceManager.name ? null : status.serviceManager.note;
}
