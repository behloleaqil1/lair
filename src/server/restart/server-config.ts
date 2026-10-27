/**
 * The server's own config, data/server.yaml (optional; it is read again at
 * every use, so a change needs no restart):
 *
 *   server:
 *     # Run by "Update and restart", before the restart: one argv, or a list
 *     # of argvs run in order (never through a shell). The first that fails
 *     # stops the update, and nothing restarts.
 *     update_cmd:
 *       - ["git", "pull", "--ff-only"]
 *       - ["npm", "ci"]
 *       - ["npm", "run", "build"]
 *     update_timeout_seconds: 900   # per step
 *     # What starts Lair again after Restart: launchd | systemd | none
 *     # (default: detected from the environment, when Lair can tell)
 *     service_manager: launchd
 *
 * It lives in data/, beside the owner token, and not in any project's
 * repository: the update command runs with the server's rights, so nothing
 * an agent can write may change it.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ServiceManagerView } from "../../shared/lifecycle-types.js";

const MAX_BYTES = 64 * 1024;

export type ServiceManagerName = "launchd" | "systemd" | "none";

export interface ServerSettings {
  /** server.update_cmd: each step's argv, in order ([] when unset) */
  updateSteps: string[][];
  updateTimeoutSeconds: number;
  /** server.service_manager, or null to detect it */
  serviceManager: ServiceManagerName | null;
}

export type ServerConfigResult =
  | { ok: true; settings: ServerSettings }
  | { ok: false; errors: string[]; settings: ServerSettings };

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  updateSteps: [],
  updateTimeoutSeconds: 900,
  serviceManager: null,
};

const Argv = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(64)
  .refine((argv) => !(argv[0] ?? "").startsWith("-"), "the command (its first word) can't start with '-'");

const ServerSchema = z
  .object({
    server: z
      .object({
        // One argv is one step
        update_cmd: z
          .preprocess((v) => (Array.isArray(v) && typeof v[0] === "string" ? [v] : v), z.array(Argv).min(1).max(20))
          .optional(),
        update_timeout_seconds: z.number().int().min(10).max(7200).default(900),
        service_manager: z.enum(["launchd", "systemd", "none"]).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export function parseServerConfig(raw: unknown): ServerConfigResult {
  const parsed = ServerSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      settings: DEFAULT_SERVER_SETTINGS,
    };
  }
  const server = parsed.data.server;
  return {
    ok: true,
    settings: {
      updateSteps: server.update_cmd ?? [],
      updateTimeoutSeconds: server.update_timeout_seconds,
      serviceManager: server.service_manager ?? null,
    },
  };
}

/** Read the server config; a missing file is the defaults. */
export function loadServerConfig(path: string): ServerConfigResult {
  if (!existsSync(path)) return { ok: true, settings: DEFAULT_SERVER_SETTINGS };
  try {
    if (statSync(path).size > MAX_BYTES) {
      return { ok: false, errors: [`larger than ${MAX_BYTES / 1024} KiB`], settings: DEFAULT_SERVER_SETTINGS };
    }
    return parseServerConfig(parseYaml(readFileSync(path, "utf-8")));
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], settings: DEFAULT_SERVER_SETTINGS };
  }
}

const NO_MANAGER =
  "nothing starts Lair again after it exits: run it under launchd (KeepAlive) or systemd (Restart=always) first";

/**
 * Who starts Lair again after Restart exits: server.service_manager when
 * set, else what the environment shows (systemd sets INVOCATION_ID for its
 * units; launchd sets XPC_SERVICE_NAME to the job's label), else unknown.
 */
export function serviceManagerOf(
  configured: ServiceManagerName | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ServiceManagerView {
  if (configured === "none") {
    return { name: null, source: "configured", note: `server.service_manager is none: Restart stops Lair, and ${NO_MANAGER}` };
  }
  if (configured) {
    return {
      name: configured,
      source: "configured",
      note:
        configured === "launchd"
          ? "launchd starts Lair again (server.service_manager), if its job has KeepAlive set"
          : "systemd starts Lair again (server.service_manager), if its unit has Restart=always",
    };
  }
  if (env.INVOCATION_ID) {
    return { name: "systemd", source: "detected", note: "Started by systemd: it starts Lair again if the unit has Restart=always" };
  }
  const label = env.XPC_SERVICE_NAME;
  if (platform === "darwin" && label && label !== "0" && !label.startsWith("application.")) {
    return { name: "launchd", source: "detected", note: "Started by launchd: it starts Lair again if the job has KeepAlive set" };
  }
  return {
    name: null,
    source: "unknown",
    note: `Lair can't tell whether a service manager runs it. Without one, Restart only stops it: ${NO_MANAGER}`,
  };
}
