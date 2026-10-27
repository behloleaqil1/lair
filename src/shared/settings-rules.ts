/**
 * Which config fields make Lair execute something, and which values look
 * like secrets. The server enforces both on every save
 * (src/server/settings/); the forms use the same rules to mark fields.
 *
 * Both rules go by key name and value shape, never by module, so a block a
 * new module adds is covered without a change here.
 */
import type { PathSegment } from "./settings-types.js";

/** `ask_cmd`, `start_cmd`, `branch_state_cmd`, `update_cmd`, `cmd`... (any value shape) */
const COMMAND_KEY = /(^|_)cmds?$/;
/** Keys whose value is the command itself, when it is a string or an argv */
const RUN_KEYS = new Set(["run", "command", "argv", "probe"]);
/** Keys naming a program or script Lair runs */
const PROGRAM_KEYS = new Set(["gate_script", "kiro_cli", "script", "program", "executable"]);
/** Containers whose argv children are commands (watchdog actions, triage commands, probes) */
const COMMAND_CONTAINERS = new Set(["actions", "commands", "probes", "hooks"]);
/** Siblings of a run/command key that change what runs */
const COMMAND_CONTEXT = new Set(["env", "cwd"]);

const MAX_DEPTH = 64;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An argv: a non-empty list of strings. */
export function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** A string, an argv, or a list of argvs (a sequence of steps). */
function isCommandValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (isArgv(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isArgv);
}

/** "a.b.0.c": how paths are shown and matched against parser messages. */
export function pathKey(path: readonly PathSegment[]): string {
  return path.map(String).join(".");
}

/**
 * Whether the field `key` (with `value`, in an object whose keys are
 * `siblings`) makes Lair execute something. `container` is the key of the
 * object it is in.
 */
export function isCommandField(key: string, value: unknown, siblings: Record<string, unknown>, container?: PathSegment): boolean {
  if (value === undefined || value === null) return false;
  if (COMMAND_KEY.test(key)) return true;
  if (RUN_KEYS.has(key)) return isCommandValue(value);
  if (PROGRAM_KEYS.has(key)) return typeof value === "string";
  if (typeof container === "string" && COMMAND_CONTAINERS.has(container) && Array.isArray(value) && isCommandValue(value)) {
    return true;
  }
  if (COMMAND_CONTEXT.has(key)) {
    return Object.entries(siblings).some(([k, v]) => RUN_KEYS.has(k) && isCommandValue(v));
  }
  return false;
}

/**
 * Whether a field may run something, by its key alone (`container` is the
 * key of the object it is in): how the forms mark a field before it has a
 * value. The server decides with isCommandField, which also looks at it.
 */
export function isCommandKey(key: string, container?: PathSegment): boolean {
  return (
    COMMAND_KEY.test(key) ||
    RUN_KEYS.has(key) ||
    PROGRAM_KEYS.has(key) ||
    (typeof container === "string" && COMMAND_CONTAINERS.has(container))
  );
}

/**
 * Every command-bearing field of a config (its own rule above), keyed by
 * dotted path, with its value. A field inside one is not listed again.
 */
export function collectCommands(root: unknown): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const walk = (node: unknown, path: PathSegment[], depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i], depth + 1));
      return;
    }
    if (!isPlainObject(node)) return;
    const container = path.length > 0 ? path[path.length - 1] : undefined;
    for (const [key, value] of Object.entries(node)) {
      const here = [...path, key];
      if (isCommandField(key, value, node, container)) {
        found.set(pathKey(here), value);
      } else {
        walk(value, here, depth + 1);
      }
    }
  };
  walk(root, [], 0);
  return found;
}

// ============ SECRETS ============

/**
 * Keys that name a secret. Keys that point at one (`token_env`,
 * `password_file`, `token_cmd`) don't match: the pattern is anchored at the
 * end of the key.
 */
const SECRET_KEY =
  /^(?:.*[_-])?(token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credentials?)$/i;

/** Values that are a secret wherever they appear */
const SECRET_VALUES: { what: string; pattern: RegExp }[] = [
  { what: "a private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { what: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { what: "a GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { what: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { what: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { what: "an AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { what: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { what: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { what: "an API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { what: "a URL with a password", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
];

/** Values are cut to this before the patterns run (bounded input) */
const MAX_SCANNED = 8192;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** What a value looks like ("a GitHub token"), or null when it looks like no secret. */
export function secretValueKind(value: string): string | null {
  const text = value.length > MAX_SCANNED ? value.slice(0, MAX_SCANNED) : value;
  for (const { what, pattern } of SECRET_VALUES) {
    if (pattern.test(text)) return what;
  }
  return null;
}

export interface SecretFinding {
  path: string;
  /** Why: the key's name, or what the value looks like */
  why: string;
}

/** The fields of a config that hold (or look like they hold) a secret. */
export function findSecrets(root: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const walk = (node: unknown, path: PathSegment[], key: string | null, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof node === "string" || typeof node === "number") {
      if (key !== null && isSecretKey(key) && String(node).length > 0) {
        findings.push({ path: pathKey(path), why: `its name (${key}) says it holds a secret` });
        return;
      }
      if (typeof node === "string") {
        const kind = secretValueKind(node);
        if (kind) findings.push({ path: pathKey(path), why: `the value looks like ${kind}` });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i], key, depth + 1));
      return;
    }
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k], k, depth + 1);
    }
  };
  walk(root, [], null, 0);
  return findings;
}
