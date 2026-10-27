/**
 * The Settings view's change to the notifications section of
 * data/server.yaml. Only that section is written: the yaml library's
 * Document keeps every other key and comment (server.update_cmd, say) as it
 * was. The file must pass the same checks as when it is read (a regular
 * file of this user, no symbolic link, not writable by others); a missing
 * one is created. The write is atomic (a temporary file created with
 * O_EXCL, fsynced, renamed over it) and leaves the file 0600.
 */
import { randomBytes } from "crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { Document, isMap, parseDocument } from "yaml";
import type { NotificationSettingsUpdate } from "../../shared/notification-types.js";
import { readCheckedFile, type ServerConfigFileOptions } from "../restart/server-config.js";
import { DEFAULT_REMINDER_HOURS, MAX_REMINDER_HOURS, ntfyUrlProblem, parseNotificationConfig } from "./config.js";

export type SaveResult = { ok: true } | { ok: false; code: 400 | 409 | 500; error: string };

/** Replace `path` with `text` atomically, mode 0600. */
function writeOwnerOnly(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(text, "utf-8");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Check an update's shape; the URL rules are the config's. */
export function updateProblem(update: NotificationSettingsUpdate): string | null {
  if (update.ntfyUrl !== null) {
    const problem = ntfyUrlProblem(update.ntfyUrl);
    if (problem) return `ntfyUrl ${problem}`;
  }
  const hours = update.reminderHours;
  if (hours !== undefined && (!Number.isInteger(hours) || hours < 0 || hours > MAX_REMINDER_HOURS)) {
    return `reminderHours must be a whole number from 0 to ${MAX_REMINDER_HOURS}`;
  }
  return null;
}

export function saveNotificationSettings(
  configPath: string,
  update: NotificationSettingsUpdate,
  options: ServerConfigFileOptions = {},
): SaveResult {
  const problem = updateProblem(update);
  if (problem) return { ok: false, code: 400, error: problem };
  const read = readCheckedFile(configPath, options);
  if (!read.ok) return { ok: false, code: 409, error: `data/server.yaml ${read.error}` };

  const parsed = read.text === null ? null : parseDocument(read.text, { uniqueKeys: true });
  if (parsed && parsed.errors.length > 0) {
    return { ok: false, code: 409, error: `data/server.yaml does not parse (${parsed.errors[0].message}): fix it first` };
  }
  if (parsed && parsed.contents !== null && !isMap(parsed.contents)) {
    return { ok: false, code: 409, error: "data/server.yaml must be a mapping of sections: fix it first" };
  }
  const doc: Document = parsed && parsed.contents !== null ? (parsed as unknown as Document) : new Document({});

  // token_file is set in the file only (the view never sees or sends it): keep it
  const tokenFile = doc.getIn(["notifications", "ntfy", "token_file"]);
  const hours = doc.getIn(["notifications", "reminder_hours"]);
  const section: Record<string, unknown> = { desktop: update.desktop };
  if (update.ntfyUrl !== null) {
    section.ntfy = { url: update.ntfyUrl, ...(typeof tokenFile === "string" ? { token_file: tokenFile } : {}) };
  }
  section.reminder_hours = update.reminderHours ?? (typeof hours === "number" ? hours : DEFAULT_REMINDER_HOURS);
  doc.set("notifications", doc.createNode(section));

  // What the notifier will read back
  const check = parseNotificationConfig(doc.toJS(), dirname(configPath));
  if (!check.ok) return { ok: false, code: 400, error: check.errors.join("; ") };
  try {
    // As Settings prints YAML: no folded lines, ["a", "b"] for flow lists
    writeOwnerOnly(configPath, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  } catch (e) {
    return { ok: false, code: 500, error: `could not write data/server.yaml: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}
