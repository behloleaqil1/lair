/**
 * Live config reload (src/server/reload/) and the owner's Restart
 * (src/server/restart/), as the API returns them.
 */

/** A project file whose latest version is not what runs (GET /api/config/status). */
export interface ConfigProblem {
  project: string;
  /** The file, relative to Lair's directory (e.g. projects/local/shop.yaml) */
  file: string;
  error: string;
  /** True when the module(s) still run the previous config; false when one is off */
  previousRunning: boolean;
  at: string;
}

/** A module that took a project's new config. */
export interface ConfigReload {
  project: string;
  file: string;
  module: string;
  at: string;
}

export interface ConfigStatusView {
  /** False until the project files are watched (and after shutdown) */
  watching: boolean;
  problems: ConfigProblem[];
  /** The latest reloads, newest first */
  recent: ConfigReload[];
}

export type RestartState = "idle" | "updating" | "failed" | "restarting";

export interface ServiceManagerView {
  /** The manager that starts Lair again after it exits, or null when there is none or Lair can't tell */
  name: "launchd" | "systemd" | null;
  /** "configured": server.service_manager says so; "detected": from the environment; "unknown": can't tell */
  source: "configured" | "detected" | "unknown";
  note: string;
}

/** GET /api/owner/restart (owner only) */
export interface RestartStatusView {
  state: RestartState;
  /** When this server process started */
  startedAt: string;
  /** The server config file (data/server.yaml), relative to Lair's directory */
  configFile: string;
  /** Why the server config can't be read, or null */
  configError: string | null;
  update: {
    configured: boolean;
    /** server.update_cmd: the argv of each step, run in order */
    steps: string[][];
    timeoutSeconds: number;
  };
  serviceManager: ServiceManagerView;
  /** The update's output (the latest lines) */
  output: string[];
  /** Why the update failed, or null */
  error: string | null;
  /** When the current or last Restart was asked for */
  requestedAt: string | null;
}
