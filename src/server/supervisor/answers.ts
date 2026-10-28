/**
 * A supervisor's answer and its evidence, made fit to keep and show. The
 * answer is agent output: the owner reads it, so it is untrusted
 * (docs/design/ROADMAP.md, rule 2).
 *
 * - The answer: Markdown without control characters, cut to
 *   MAX_MARKDOWN_CHARS; secrets of known shapes taken out (redactSecrets);
 *   outside code, every HTML tag and comment removed, images reduced to
 *   their alt text, and links kept only when they go to the dashboard's own
 *   routes or to the repository's host (any other link is its text). The
 *   dashboard renders it with the same reader (src/shared/safe-markdown.ts),
 *   which makes no HTML and no other link either.
 * - The evidence: at most MAX_EVIDENCE items `{tool, args, note}`, `tool` an
 *   ops tool, `args` a small object (its strings redacted), `note` one line
 *   of plain text.
 */
import type { EvidenceItem } from "../../shared/supervisor-types.js";
import { allowedHref, MARKDOWN_FENCE, MAX_MARKDOWN_CHARS, plainText, type LinkPolicy } from "../../shared/safe-markdown.js";
import { opsTool } from "./ops-catalog.js";
import { redactSecrets, redactText, sanitize } from "./redact.js";

export const MAX_EVIDENCE = 30;
const MAX_ARGS_CHARS = 2000;
const MAX_NOTE = 500;

const AUTOLINK = /<([a-z][a-z0-9+.-]{1,15}:[^\s<>]{1,500})>/gi;
/** A link or image; its address may hold one level of parentheses (`javascript:alert(1)` is still one link) */
const LINK = /(!?)\[([^\][\n]{0,300})\]\(\s*((?:[^\s()]|\([^\s()]{0,100}\)){1,500})(?:\s+"[^"\n]{0,200}")?\s*\)/g;
const SCRIPT = /<(script|style)\b[^>]{0,500}>.*?<\/\1\s*>/gi;
const COMMENT = /<!--.*?(?:-->|$)/g;
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]{0,40}(?:\s[^<>]{0,1000})?\/?>/g;

/** Prose (no code in it): links checked, HTML out. */
function cleanProse(text: string, policy: LinkPolicy): string {
  return text
    .replace(AUTOLINK, (_m, href: string) => {
      const ok = allowedHref(href, policy);
      return ok ? `<${ok}>` : href;
    })
    .replace(LINK, (_m, image: string, label: string, href: string) => {
      if (image) return label;
      const ok = allowedHref(href, policy);
      return ok ? `[${label}](${ok})` : label;
    })
    .replace(SCRIPT, "")
    .replace(COMMENT, "")
    .replace(TAG, (tag) => (/^<[a-z][a-z0-9+.-]{1,15}:/i.test(tag) ? tag : ""));
}

/** One line outside fenced code: its code spans as written, the rest cleaned. */
function cleanLine(line: string, policy: LinkPolicy): string {
  let out = "";
  let prose = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      prose += line[i];
      i++;
      continue;
    }
    let n = 1;
    while (line[i + n] === "`") n++;
    const run = "`".repeat(n);
    const end = line.indexOf(run, i + n);
    if (end === -1) {
      prose += run;
      i += n;
      continue;
    }
    out += cleanProse(prose, policy) + line.slice(i, end + n);
    prose = "";
    i = end + n;
  }
  return out + cleanProse(prose, policy);
}

/** The answer as Lair keeps and shows it. */
export function sanitizeAnswer(markdown: string, policy: LinkPolicy): string {
  const lines = redactSecrets(plainText(markdown, MAX_MARKDOWN_CHARS)).split("\n");
  const out: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const f = MARKDOWN_FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1][0] === fence.marker && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = { marker: f[1][0], length: f[1].length };
      out.push(line);
      continue;
    }
    out.push(cleanLine(line.slice(0, 2000), policy));
  }
  return out.join("\n").trim();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The evidence an answer cites, checked; or why it is refused. */
export function sanitizeEvidence(value: unknown): { ok: true; evidence: EvidenceItem[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, evidence: [] };
  if (!Array.isArray(value)) return { ok: false, error: "evidence: a list of {tool, args, note}" };
  if (value.length > MAX_EVIDENCE) return { ok: false, error: `evidence: at most ${MAX_EVIDENCE} items` };
  const evidence: EvidenceItem[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    const at = `evidence[${i}]`;
    if (!isObject(item)) return { ok: false, error: `${at}: an object {tool, args, note}` };
    const unknown = Object.keys(item).find((k) => !["tool", "args", "note"].includes(k));
    if (unknown) return { ok: false, error: `${at}: unknown key ${redactText(unknown, 40)}` };
    if (typeof item.tool !== "string" || !opsTool(item.tool)) {
      return { ok: false, error: `${at}.tool: one of the ops tools (status.<module>, events.query, decisions.list, ...)` };
    }
    const args = item.args === undefined ? {} : item.args;
    if (!isObject(args)) return { ok: false, error: `${at}.args: an object` };
    if ((JSON.stringify(args) ?? "").length > MAX_ARGS_CHARS) return { ok: false, error: `${at}.args: at most ${MAX_ARGS_CHARS} characters of JSON` };
    const note = item.note === undefined ? "" : item.note;
    if (typeof note !== "string" || note.length > MAX_NOTE) return { ok: false, error: `${at}.note: text of at most ${MAX_NOTE} characters` };
    evidence.push({
      tool: item.tool,
      args: sanitize(args, { depth: 4, items: 20, keys: 20, text: 300 }) as Record<string, unknown>,
      note: redactSecrets(plainText(note, MAX_NOTE).replace(/\s+/g, " ").trim()),
    });
  }
  return { ok: true, evidence };
}
