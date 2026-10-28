/**
 * What the ops API hands an AI supervisor, made safe to hand over: text
 * without what looks like a secret, a token, a URL's credentials, path or
 * query, an email address's local part, an ARN or a long run of digits (an
 * account id), and values cut to a
 * size, in structures cut to a depth and length. The supervisor is an agent,
 * and agents are the untrusted party (docs/design/ROADMAP.md, rules 2 and 5).
 *
 * The AI tools' scrub (src/server/ai/scrub.ts) removes URLs, ARNs and long
 * digit runs from a tool's output outright; here a URL keeps its scheme and
 * host, which a diagnosis needs ("api.example.com refused the connection"),
 * and secrets of known shapes go too.
 */

/** A string longer than this is cut before anything else reads it */
export const MAX_TEXT = 1000;

const URL = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s'"<>`]*)/gi;
const ARN = /\barn:[^\s'"`]+/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const AUTH_HEADER = /\b((?:proxy-)?authorization|x-[a-z0-9-]*(?:token|key|secret|session)[a-z0-9-]*)(\s*[:=]\s*)("?)[^\r\n"]*/gi;
const BEARER = /\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** An email address (a git Author line, an identity): its local part goes, its domain stays */
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\b/g;
/**
 * name=value, name: value and "name": "value" where the name says it holds a secret or a key (a value already
 * taken out stays): so a commit-id-shaped secret next to `token=` or `key=` goes too, while a bare commit id stays
 */
const SECRET_PAIR =
  /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|key|credential|cookie)[A-Za-z0-9_.-]*)("?\s*[:=]\s*"?)((?!\[)[^\s"',;&)}\]]+)/gi;
/** Known shapes: GitHub, OpenAI-style and Slack tokens, AWS and Google keys, JWTs, Lair's own ops tokens */
const KNOWN_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|lairops_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
/** A long run of token characters: a secret when it mixes cases and digits, or is long hex (a 40-digit commit id stays) */
const LONG_RUN = /[A-Za-z0-9+_=-]{32,}/g;
const WORD = /[A-Za-z0-9]{6,}/g;

function looksSecret(run: string): boolean {
  const hex = /^[0-9a-f]+$/i.test(run);
  if (hex) return !/^[0-9a-f]{40}$/.test(run);
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** A URL as scheme://host[:port]: its userinfo (user:password@), path, query and fragment, which can hold a token, go. */
function url(scheme: string, rest: string): string {
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/[^A-Za-z0-9.:[\]-]/g, "");
  const more = end !== -1 && rest.length > end + 1;
  return `${scheme.toLowerCase()}://${host || "[host]"}${more ? "/[...]" : ""}`;
}

/**
 * `text` with secrets, URL credentials and paths, ARNs and long digit runs
 * taken out, cut to `max` characters (before and after).
 */
export function redactText(text: string, max: number = MAX_TEXT): string {
  // Cut first: the expressions below never read more than this
  let out = text.length > max + 200 ? text.slice(0, max + 200) : text;
  out = out
    .replace(PRIVATE_KEY, "[private key]")
    .replace(URL, (_m, scheme: string, rest: string) => url(scheme, rest))
    .replace(ARN, "[arn]")
    .replace(EMAIL, (_m, domain: string) => `***@${domain}`)
    .replace(AUTH_HEADER, (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}[redacted]`)
    .replace(BEARER, (_m, word: string, space: string) => `${word}${space}[redacted]`)
    .replace(KNOWN_TOKEN, "[secret]")
    .replace(SECRET_PAIR, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(LONG_RUN, (run) => (looksSecret(run) ? "[secret]" : run))
    .replace(WORD, (word) => (/^[0-9a-f]{40}$/.test(word) ? word : word.replace(/\d{6,}/g, "[digits]")));
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** A URL's credentials (user:password@): the rest of the URL stays */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/?#@'"<>`]{1,200}@/gi;

/**
 * Prose an agent wrote for the owner (a supervisor's answer): secrets of
 * known shapes, private keys, Authorization and Bearer values, long
 * secret-looking runs and URL credentials taken out. Unlike redactText, a
 * URL keeps its path (a link to the repository is the point of it), and
 * nothing is cut: the caller bounds the text first.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[private key]")
    .replace(URL_USERINFO, "$1")
    .replace(AUTH_HEADER, (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}[redacted]`)
    .replace(BEARER, (_m, word: string, space: string) => `${word}${space}[redacted]`)
    .replace(KNOWN_TOKEN, "[secret]")
    .replace(LONG_RUN, (run) => (looksSecret(run) ? "[secret]" : run));
}

export interface Limits {
  /** Nested objects and arrays below this depth become "[...]" */
  depth: number;
  /** Items kept per array (the rest are counted) */
  items: number;
  /** Keys kept per object */
  keys: number;
  /** Characters kept per string */
  text: number;
}

export const DEFAULT_LIMITS: Limits = { depth: 8, items: 100, keys: 200, text: MAX_TEXT };

/**
 * A copy of `value` fit to hand over: every string redacted (keys too) and
 * cut, arrays and objects cut to the limits (a cut array ends with a note of
 * how many were left out), anything that isn't JSON dropped.
 */
export function sanitize(value: unknown, limits: Limits = DEFAULT_LIMITS, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactText(value, limits.text);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  if (depth >= limits.depth) return "[...]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.items).map((item) => sanitize(item, limits, depth + 1));
    if (value.length > limits.items) kept.push(`[${value.length - limits.items} more left out]`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || typeof item === "function") continue;
    if (n++ >= limits.keys) {
      out["[more]"] = "keys left out";
      break;
    }
    out[redactText(key, 100)] = sanitize(item, limits, depth + 1);
  }
  return out;
}

/**
 * sanitize(), then tighter limits until its JSON fits `maxBytes`: big
 * statuses come back shorter rather than not at all.
 */
export function bounded(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const steps: Limits[] = [
    DEFAULT_LIMITS,
    { depth: 6, items: 25, keys: 100, text: 400 },
    { depth: 5, items: 8, keys: 50, text: 200 },
    { depth: 3, items: 3, keys: 20, text: 120 },
  ];
  for (let i = 0; i < steps.length; i++) {
    const out = sanitize(value, steps[i]);
    if (Buffer.byteLength(JSON.stringify(out) ?? "null", "utf-8") <= maxBytes) return { value: out, truncated: i > 0 };
  }
  return { value: "[too large: ask for less]", truncated: true };
}

/** Keys whose values are secrets or personal (an email) in a project's config; the name of an env variable or of a file is not */
const SECRET_KEY = /(token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|credential|e-?mail)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/**
 * A project's config as an AI supervisor may see it: every `env` map (a
 * command's environment) removed, a value whose key names a secret
 * replaced (a `*_env` key that names a variable, and a `*_file` path, stay),
 * and every string redacted as above.
 */
export function redactConfig(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[...]";
  if (Array.isArray(value)) return value.map((item) => redactConfig(item, depth + 1));
  if (value === null || typeof value !== "object") return typeof value === "string" ? redactText(value) : value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^env$/i.test(key) || (/_env$/i.test(key) && item !== null && typeof item === "object")) {
      out[key] = "[removed: a command's environment]";
      continue;
    }
    if (SECRET_KEY.test(key)) {
      const names = /_env$/i.test(key) && typeof item === "string" && ENV_NAME.test(item);
      const path = /_file$/i.test(key) && typeof item === "string";
      if (!names && !path) {
        out[key] = "[redacted]";
        continue;
      }
    }
    out[key] = redactConfig(item, depth + 1);
  }
  return out;
}
