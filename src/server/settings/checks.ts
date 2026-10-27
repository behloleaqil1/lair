/**
 * The checks of a Settings save that are not a module's parser: errors per
 * field from the parsers' messages, secrets, and the command-bearing fields
 * a change adds or alters (src/shared/settings-rules.ts).
 */
import { createHash } from "crypto";
import type { CommandChange, FieldError, PathSegment, SettingsSection } from "../../shared/settings-types.js";
import { collectCommands, findSecrets, isPlainObject, pathKey } from "../../shared/settings-rules.js";
import { stableJson } from "../reload/modules.js";

/** The keys loadProjectConfig requires */
export const REQUIRED_KEYS = ["name", "repo", "queue_file", "agents_dir", "gates_dir"] as const;

const MAX_MESSAGE = 1000;

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

/**
 * A parser's message as a field error. The parsers start messages with the
 * field's dotted path ("watchdog.interval_seconds: Number must be ..."); a
 * message without one has the path "".
 */
export function fieldError(message: string): FieldError {
  const text = clip(message);
  const match = /^([A-Za-z0-9_$*-]+(?:\.[^\s:.]+)*): ([\s\S]+)$/.exec(text);
  if (!match) return { path: "", message: text };
  const path = match[1].replace(/\.?\(root\)$/, "");
  return { path, message: match[2] };
}

/** Messages of the shape "a: x; b.c: y" (as loadProjectConfig joins them) as one error each. */
export function fieldErrors(messages: string[]): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  for (const message of messages.slice(0, 200)) {
    const bounded = message.length > 20 * MAX_MESSAGE ? message.slice(0, 20 * MAX_MESSAGE) : message;
    for (const part of bounded.split(/; (?=[A-Za-z0-9_$*-]+(?:\.[^\s:.]+)*: )/)) {
      const error = fieldError(part.trim());
      const key = `${error.path}\0${error.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(error);
      }
    }
  }
  return out;
}

/** The required keys a config lacks, one error each. */
export function requiredErrors(values: Record<string, unknown>): FieldError[] {
  return REQUIRED_KEYS.filter((key) => typeof values[key] !== "string" || (values[key] as string).length === 0).map(
    (key) => ({ path: key, message: "required" }),
  );
}

/** One error per field that holds a secret; the message never repeats the value. */
export function secretErrors(values: unknown): FieldError[] {
  return findSecrets(values).map((finding) => ({
    path: finding.path,
    message:
      `${finding.why}. Secrets never go in the project file: keep it in a file under data/ (mode 0600) or in an ` +
      `environment variable, and name that here instead (a *_env or *_file key)`,
  }));
}

function matches(pattern: string[], path: PathSegment[]): boolean {
  return pattern.length === path.length && pattern.every((p, i) => p === "*" || p === String(path[i]));
}

/** Fields a section's hints mark as commands, beyond the shared rule. */
function hintedCommands(values: unknown, sections: readonly SettingsSection[]): Map<string, unknown> {
  const patterns: string[][] = [];
  for (const section of sections) {
    for (const [field, hint] of Object.entries(section.hints)) {
      if (!hint.command) continue;
      const rel = field.split(".");
      patterns.push(section.root ? rel : [section.key, ...rel]);
    }
  }
  const found = new Map<string, unknown>();
  if (patterns.length === 0) return found;
  const walk = (node: unknown, path: PathSegment[]) => {
    if (path.length > 0 && patterns.some((p) => matches(p, path))) {
      if (node !== undefined && node !== null) found.set(pathKey(path), node);
      return;
    }
    if (path.length >= 32) return;
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
    else if (isPlainObject(node)) for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(values, []);
  return found;
}

/** Every command-bearing field of a config: the shared rule and the sections' hints. */
export function commandsOf(values: unknown, sections: readonly SettingsSection[]): Map<string, unknown> {
  const all = collectCommands(values);
  for (const [path, value] of hintedCommands(values, sections)) if (!all.has(path)) all.set(path, value);
  return all;
}

/**
 * The command-bearing fields `after` adds or changes compared to `before`,
 * with both values. Removing a command is not listed: it runs nothing new.
 */
export function commandChanges(before: unknown, after: unknown, sections: readonly SettingsSection[]): CommandChange[] {
  const old = commandsOf(before, sections);
  const changes: CommandChange[] = [];
  for (const [path, value] of commandsOf(after, sections)) {
    const was = old.get(path);
    if (was === undefined || stableJson(was) !== stableJson(value)) {
      changes.push({ path, before: was ?? null, after: value });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** What the owner confirms: a digest of exactly these command changes ("" when there are none). */
export function commandsDigest(changes: CommandChange[]): string {
  if (changes.length === 0) return "";
  return createHash("sha256").update(stableJson(changes)).digest("hex");
}
