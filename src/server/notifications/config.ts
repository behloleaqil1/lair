/**
 * The `notifications:` section of data/server.yaml, Lair's own config (never
 * a project's YAML). It is read again at every use, so a change needs no
 * restart, through the same file checks as the rest of server.yaml
 * (restart/server-config.ts): a regular file, not a symbolic link, this
 * user's, not writable by its group or others. Off when the section is
 * missing or refused.
 *
 *   notifications:
 *     desktop: true                     # macOS: osascript; Linux: notify-send when it is installed
 *     ntfy:                             # a phone push through ntfy (https://ntfy.sh or a self-hosted one)
 *       url: https://ntfy.sh/<topic>
 *       token_file: ntfy.token          # optional; relative to data/; mode 600, never shown or logged
 *     reminder_hours: 4                 # a daily reminder while action items stay open longer (0: off)
 */
import { dirname, isAbsolute, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readCheckedFile, type ServerConfigFileOptions } from "../restart/server-config.js";

export const DEFAULT_REMINDER_HOURS = 4;
export const MAX_REMINDER_HOURS = 168;
const MAX_TOKEN_BYTES = 4096;

export interface NtfySettings {
  url: string;
  /** Absolute path of the token file, or null */
  tokenFile: string | null;
}

export interface NotificationSettings {
  desktop: boolean;
  ntfy: NtfySettings | null;
  /** 0: no reminder */
  reminderHours: number;
}

export const NOTIFICATIONS_OFF: NotificationSettings = {
  desktop: false,
  ntfy: null,
  reminderHours: DEFAULT_REMINDER_HOURS,
};

export function notificationsOn(settings: NotificationSettings): boolean {
  return settings.desktop || settings.ntfy !== null;
}

export type NotificationConfigResult =
  | { ok: true; settings: NotificationSettings }
  | { ok: false; errors: string[]; settings: NotificationSettings };

/** An http(s) URL with a host, without credentials in it (a token goes in token_file), or why not. */
export function ntfyUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an http or https URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http or https URL";
  if (!url.hostname) return "must name a host";
  if (url.username || url.password) return "must not carry a user or password (put a token in ntfy.token_file)";
  if (url.pathname === "/" || url.pathname === "") return "must name the topic, e.g. https://ntfy.sh/<topic>";
  return null;
}

const NotificationsSchema = z
  .object({
    desktop: z.boolean().default(false),
    ntfy: z
      .object({
        url: z
          .string()
          .max(2000)
          .refine((u) => ntfyUrlProblem(u) === null, (u) => ({ message: ntfyUrlProblem(u) ?? "invalid" })),
        token_file: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    reminder_hours: z.number().int().min(0).max(MAX_REMINDER_HOURS).default(DEFAULT_REMINDER_HOURS),
  })
  .strict();

/** Parse the section (`raw` is server.yaml's whole document); `dataDir` resolves a relative token_file. */
export function parseNotificationConfig(raw: unknown, dataDir: string): NotificationConfigResult {
  const section =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).notifications : undefined;
  if (section === undefined || section === null) return { ok: true, settings: NOTIFICATIONS_OFF };
  const parsed = NotificationsSchema.safeParse(section);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `notifications.${issue.path.join(".") || "(section)"}: ${issue.message}`),
      settings: NOTIFICATIONS_OFF,
    };
  }
  const { desktop, ntfy, reminder_hours } = parsed.data;
  const tokenFile = ntfy?.token_file ? (isAbsolute(ntfy.token_file) ? ntfy.token_file : resolve(dataDir, ntfy.token_file)) : null;
  return {
    ok: true,
    settings: {
      desktop,
      ntfy: ntfy ? { url: ntfy.url, tokenFile } : null,
      reminderHours: reminder_hours,
    },
  };
}

/** Read and parse the section from data/server.yaml. A refused file is off, with the reason. */
export function loadNotificationConfig(configPath: string, options: ServerConfigFileOptions = {}): NotificationConfigResult {
  const read = readCheckedFile(configPath, options);
  if (!read.ok) return { ok: false, errors: [`data/server.yaml ${read.error}`], settings: NOTIFICATIONS_OFF };
  if (read.text === null) return { ok: true, settings: NOTIFICATIONS_OFF };
  let raw: unknown;
  try {
    raw = parseYaml(read.text);
  } catch (e) {
    return { ok: false, errors: [`data/server.yaml: ${e instanceof Error ? e.message : String(e)}`], settings: NOTIFICATIONS_OFF };
  }
  return parseNotificationConfig(raw, dirname(configPath));
}

/** A printable token without spaces (it goes in a header). */
function validToken(token: string): boolean {
  if (token.length === 0 || token.length > 1000) return false;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) return false;
  }
  return true;
}

/**
 * The ntfy token from token_file, through the same checks as server.yaml
 * and, since it is a secret, not readable by the group or others either.
 * Errors never include the file's content.
 */
export function readNtfyToken(
  path: string,
  options: ServerConfigFileOptions = {},
): { ok: true; token: string } | { ok: false; error: string } {
  const read = readCheckedFile(path, { ...options, secret: true }, MAX_TOKEN_BYTES);
  if (!read.ok) return { ok: false, error: `ntfy.token_file ${read.error}` };
  if (read.text === null) return { ok: false, error: "ntfy.token_file does not exist" };
  const token = read.text.trim();
  if (!validToken(token)) return { ok: false, error: "ntfy.token_file must hold one token: printable characters, no spaces" };
  return { ok: true, token };
}
