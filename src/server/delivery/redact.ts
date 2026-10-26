/**
 * Redaction for what delivery stores and serves. Command lines, command
 * output and log lines can carry credentials: a URL with user:password, a
 * token in an argument, a `password=...` in a log line. Every argv, output,
 * detail, error and log line goes through redact() before it is written to
 * the store or sent to the UI.
 */
const RULES: [RegExp, string][] = [
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***:***@"],
  // Tokens with a known shape
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}\b/g, "$1_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "glpat-***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-***"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_***"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // key=value and key: value where the key names a secret
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    "$1$2***",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
