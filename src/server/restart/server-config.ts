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
 *   # Desktop and phone notifications: src/server/notifications/config.ts
 *   notifications:
 *     desktop: true
 *
 * The update command runs with the server's rights, so whoever can write
 * this file can run code as Lair. It lives in data/, beside the owner
 * token, and in no project's repository; loadServerConfig() also refuses a
 * symbolic link, anything but a regular file, a file another user owns, and
 * a file its group or others may write. That protects it only as far as
 * Lair's directory is protected: the agents Lair supervises run as the same
 * OS user unless they are sandboxed, and such an agent can write any file
 * that user can.
 */
import { lstatSync, type Stats } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ServiceManagerView } from "../../shared/lifecycle-types.js";
import { readRegularFile } from "../read-file.js";

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
    // The notifications module's own section (src/server/notifications/config.ts): parsed there, so a
    // mistake in it never stops a restart
    notifications: z.unknown().optional(),
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

export interface ServerConfigFileOptions {
  /** The user who must own the file (default: this process's; tests pass another) */
  uid?: number;
  platform?: NodeJS.Platform;
}

export interface CheckedFileOptions extends ServerConfigFileOptions {
  /** A secret (a token file): its group and others may not read it either */
  secret?: boolean;
}

/**
 * Why a file of Lair's own (data/server.yaml, or a token file it names)
 * can't be trusted, or null: a symbolic link, not a regular file, writable
 * by its group or others (for a secret, readable by them too), or another
 * user's.
 */
export function serverFileProblem(stat: Stats, options: CheckedFileOptions = {}): string | null {
  if (stat.isSymbolicLink()) return "it is a symbolic link";
  if (!stat.isFile()) return "it is not a regular file";
  if ((options.platform ?? process.platform) === "win32") return null;
  if ((stat.mode & 0o022) !== 0) {
    return `its group or other users may write it (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`;
  }
  if (options.secret && (stat.mode & 0o044) !== 0) {
    return `its group or other users may read it (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`;
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return `it is owned by another user (uid ${stat.uid}, not ${uid})`;
  return null;
}

/** A checked file's text (null when it doesn't exist), or why it was refused ("refused: ..."). */
export type CheckedRead = { ok: true; text: string | null } | { ok: false; error: string };

/**
 * Read a file of Lair's own after serverFileProblem() passes, checked again
 * on the open descriptor, so the file checked is the file read. A missing
 * file is `text: null`.
 */
export function readCheckedFile(path: string, options: CheckedFileOptions = {}, maxBytes = MAX_BYTES): CheckedRead {
  const refuse = (why: string): CheckedRead => ({ ok: false, error: `refused: ${why}` });
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, text: null };
    return refuse(e instanceof Error ? e.message : String(e));
  }
  const problem = serverFileProblem(link, options);
  if (problem) return refuse(problem);
  try {
    const text = readRegularFile(path, {
      maxBytes,
      noFollow: true,
      check: (open) => {
        if (open.ino !== link.ino || open.dev !== link.dev) throw new Error("it was replaced while it was read");
        const again = serverFileProblem(open, options);
        if (again) throw new Error(again);
      },
    });
    return { ok: true, text };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Read the server config; a missing file is the defaults. The file must be
 * a regular file (not a symbolic link) of this user that its group and
 * others can't write; it is checked again on the open descriptor, so the
 * file checked is the file read.
 */
export function loadServerConfig(path: string, options: ServerConfigFileOptions = {}): ServerConfigResult {
  const read = readCheckedFile(path, options);
  if (!read.ok) return { ok: false, errors: [read.error], settings: DEFAULT_SERVER_SETTINGS };
  if (read.text === null) return { ok: true, settings: DEFAULT_SERVER_SETTINGS };
  try {
    return parseServerConfig(parseYaml(read.text));
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], settings: DEFAULT_SERVER_SETTINGS };
  }
}

const NO_MANAGER =
  "nothing starts Lair again after it exits: run it under launchd (KeepAlive) or systemd (Restart=always) first";

/**
 * Who starts Lair again after Restart exits: server.service_manager when
 * set, else what the environment suggests, else unknown. The environment is
 * only a hint: systemd sets INVOCATION_ID for its units, but a terminal of a
 * systemd user session inherits it too, so it counts only beside
 * JOURNAL_STREAM or a parent pid of 1; launchd sets XPC_SERVICE_NAME to the
 * job's label.
 */
export function serviceManagerOf(
  configured: ServiceManagerName | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  ppid: number = process.ppid,
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
  const sure = " (set server.service_manager to be sure)";
  if (env.INVOCATION_ID && (env.JOURNAL_STREAM || ppid === 1)) {
    return {
      name: "systemd",
      source: "detected",
      note: `Probably started by systemd: it starts Lair again if the unit has Restart=always${sure}`,
    };
  }
  const label = env.XPC_SERVICE_NAME;
  if (platform === "darwin" && label && label !== "0" && !label.startsWith("application.")) {
    return {
      name: "launchd",
      source: "detected",
      note: `Probably started by launchd: it starts Lair again if the job has KeepAlive set${sure}`,
    };
  }
  return {
    name: null,
    source: "unknown",
    note: `Lair can't tell whether a service manager runs it. Without one, Restart only stops it: ${NO_MANAGER}`,
  };
}
