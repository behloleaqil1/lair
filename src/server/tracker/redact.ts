/**
 * Redaction of every text the tracker sends to GitHub (issue titles and
 * bodies, comments, field values): a repository may be public, and task text
 * comes from agents and plan files. Built-in rules run first, by default:
 * the values of secret-looking environment variables, token and key shapes,
 * credentials in URLs, `password=...` pairs, absolute paths and the home
 * directory, email addresses and private network addresses. Then the
 * owner's `redact_patterns`. Control characters are dropped and the text is
 * bounded.
 */
import { homedir } from "os";

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
/** Shorter values are too common to be secrets worth a literal replace */
const MIN_SECRET_LENGTH = 8;

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // user:password@ in a URL
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[redacted]"],
  // Absolute paths on this kind of machine, and the home directory written as ~
  [/(^|[\s"'`(=:,[<])(?:\/(?:Users|home|root|private|tmp|var|opt|srv|mnt|Volumes|etc|usr|Library)(?:\/[^\s"'`)\],;<>]*)?)/g, "$1[path]"],
  [/(^|[\s"'`(=:,[<])~\/[^\s"'`)\],;<>]*/g, "$1[path]"],
  [/\b[A-Za-z]:\\[^\s"'`)\],;<>]+/g, "[path]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, "[address]"],
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RedactorOptions {
  /** The owner's patterns (tracker.redact_patterns), applied after the built-in ones */
  patterns: RegExp[];
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export type Redact = (text: string, max: number) => string;

/** A redactor with the built-in rules, this process's secret values and home directory, then the owner's patterns. */
export function makeRedactor(options: RedactorOptions): Redact {
  const env = options.env ?? process.env;
  const literals = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_ENV.test(name) && value.trim().length >= MIN_SECRET_LENGTH) literals.add(value.trim());
  }
  const home = options.home ?? homedir();
  // Longest first, so a secret that contains another is replaced whole
  const secretRules = [...literals].sort((a, b) => b.length - a.length).map((v) => new RegExp(escapeRegExp(v), "g"));
  const homeRule = home && home.length > 1 ? new RegExp(`${escapeRegExp(home)}[^\\s"'\`)\\],;<>]*`, "g") : null;
  return (text, max) => {
    let out = text;
    for (const rule of secretRules) out = out.replace(rule, "[redacted]");
    if (homeRule) out = out.replace(homeRule, "[path]");
    for (const [rule, replacement] of RULES) out = out.replace(rule, replacement);
    out = applyPatterns(out, options.patterns);
    // eslint-disable-next-line no-control-regex
    out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
    return bound(out, max);
  };
}

function applyPatterns(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

const bound = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...` : text);

/**
 * A repository's redactor: `base` (the built-in rules and the project's
 * patterns), then the repository's own patterns, then the bound. The text is
 * bounded only after every pattern ran, so a cut never leaves part of a
 * name the patterns would have caught.
 */
export function withPatterns(base: Redact, patterns: RegExp[]): Redact {
  if (patterns.length === 0) return base;
  return (text, max) => bound(applyPatterns(base(text, Number.POSITIVE_INFINITY), patterns).trim(), max);
}

/** One line: newlines become spaces (a title, a field value). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
