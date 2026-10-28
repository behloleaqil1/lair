/**
 * Text that came from a tool's own output, made safe to show: the API, the
 * dashboard and the Decision Inbox never get what could name an account or
 * an organisation (a sign-in portal's URL, a profile ARN with its account
 * id).
 */

/**
 * `text` without URLs, ARNs and runs of six or more digits (an account id,
 * a phone number), its whitespace folded. Every text from a tool's output
 * that Lair shows goes through it; a model id is kept only when it has none
 * of them (isShownModelId).
 */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S*/gi, "")
    .replace(/\barn:\S*/gi, "")
    .replace(/\d{6,}/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A model id from a tool's output that may be shown: not a URL or an ARN (a dated id such as model-20250101 is fine) */
export function isShownModelId(id: string): boolean {
  return !/:\/\//.test(id) && !/^arn:/i.test(id);
}
