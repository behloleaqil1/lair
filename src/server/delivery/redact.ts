/**
 * Redaction for what delivery stores and serves. Command lines, command
 * output and log lines can carry credentials: a URL with user:password, a
 * token in an argument, a `password=...` in a log line. Every argv, output,
 * detail, error and log line goes through redact() before it is written to
 * the store or sent to the UI.
 */

/**
 * Key names that hold a secret, matched as the whole name or its last part
 * (DB_PASSWORD, access_token, api-key), never as a substring: `tokens: 1500`
 * and `token_count=3` stay as they are.
 */
const SECRET_KEY =
  "(?:[A-Za-z0-9]+[_.-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|(?:auth|access|refresh|api|id|session)[_-]?token)";

const RULES: [RegExp, string][] = [
  // PEM private keys, whole or cut off at the end of the text
  [
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "-----BEGIN $1PRIVATE KEY-----***",
  ],
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***:***@"],
  // Tokens with a known shape
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}\b/g, "$1_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "glpat-***"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "npm_***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-***"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_***"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***"],
  // JSON Web Tokens: three base64url parts, the first a JSON header
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "eyJ***"],
  // Authorization headers, whatever the scheme (Bearer, Basic, token, ...)
  [/\b(Authorization\s*[:=]\s*)([A-Za-z]+\s+)?[^\s,;"']+/gi, "$1$2***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // key=value and key: value where the key names a secret
  [
    new RegExp(`(?<![A-Za-z0-9.])(${SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"']+)`, "gi"),
    "$1$2***",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
