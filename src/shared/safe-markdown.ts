/**
 * The supervisor's answers are agent output, so the dashboard treats them as
 * untrusted (docs/design/ROADMAP.md, rule 2). This is the one Markdown
 * reader both sides use: the server cleans an answer with its link policy
 * before keeping it (src/server/supervisor/answers.ts), and the dashboard
 * renders what parseMarkdown() returns as React elements, never as HTML.
 *
 * - No HTML: a tag is text, shown as written; nothing here makes an element
 *   from it.
 * - No images: `![alt](src)` is its alt text.
 * - Links only to the dashboard's own routes (`#/...`) and to the
 *   repository's host (`https://github.com/<owner>/<name>/...`); any other
 *   link is its text, not clickable.
 * - Bounded: the text is cut, lines are cut, blocks and nesting are capped,
 *   and every scan is linear (an opener with no closer is not searched for
 *   again).
 *
 * What it reads: headings, paragraphs, lists (one level), fenced code,
 * quotes, rules; inline code, **strong**, *emphasis*, links and
 * backslash escapes.
 */

export interface LinkPolicy {
  /** The repository's web address (https://github.com/<owner>/<name>), or null: no host links */
  repoUrl: string | null;
}

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code"; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" };

/** The most an answer holds */
export const MAX_MARKDOWN_CHARS = 20_000;
/** Longer lines are cut before anything reads them */
const MAX_LINE = 2000;
const MAX_BLOCKS = 400;
const MAX_LIST_ITEMS = 200;
const MAX_DEPTH = 3;
const MAX_HREF = 500;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that opens or closes fenced code: its marker run is the first group */
export const MARKDOWN_FENCE = FENCE;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ROUTE = /^#\/[A-Za-z0-9\-._~/?=&%:@]{0,300}$/;

const char = (code: number) => String.fromCharCode(code);
/**
 * Control characters but newline and tab, the line and paragraph
 * separators, and the bidirectional overrides and isolates (text that reads
 * other than it is), built from their codes
 */
const INVISIBLE = new RegExp(
  `[${char(0)}-${char(8)}${char(0x0b)}${char(0x0c)}${char(0x0e)}-${char(0x1f)}${char(0x7f)}` +
    `${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`,
  "g",
);

/** Text without control characters (newlines and tabs stay), with \r\n as \n, cut to `max`. */
export function plainText(text: string, max: number = MAX_MARKDOWN_CHARS): string {
  const out = text
    .slice(0, max + 1000)
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "");
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * The link `href` may stand for, or null when it may not be one: a route of
 * the dashboard (`#/...`, or `/#/...`), or an https address under the
 * repository's web address, without credentials.
 */
export function allowedHref(href: string, policy: LinkPolicy): string | null {
  const raw = href.trim();
  if (raw.length === 0 || raw.length > MAX_HREF) return null;
  const route = raw.startsWith("/#/") ? raw.slice(1) : raw;
  if (route.startsWith("#/")) return ROUTE.test(route) ? route : null;
  if (!policy.repoUrl) return null;
  let url: URL;
  let repo: URL;
  try {
    url = new URL(raw);
    repo = new URL(policy.repoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || repo.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.host.toLowerCase() !== repo.host.toLowerCase()) return null;
  const base = repo.pathname.replace(/\/+$/, "").toLowerCase();
  const path = url.pathname.toLowerCase();
  if (base === "" || (path !== base && !path.startsWith(`${base}/`))) return null;
  return url.toString();
}

/** A heading's text without its closing #s (`## Title ##`), trimmed by hand: no backtracking on a long line. */
function headingText(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === 0 || /\s/.test(text[hashes - 1]))) end = hashes;
  return text.slice(0, end).trim();
}

interface LinkMatch {
  label: string;
  href: string;
  end: number;
}

/** A link's `(href "title")`: the address may hold one level of parentheses, so `(javascript:alert(1))` is one link */
const LINK_TARGET = /^\(\s*((?:[^\s()]|\([^\s()]{0,100}\)){1,500})(?:\s+"[^"\n]{0,200}")?\s*\)/;

/** `[label](href)` (or `[label](href "title")`) at `start`, bounded. */
function matchLink(text: string, start: number): LinkMatch | null {
  if (text[start] !== "[") return null;
  const close = text.indexOf("](", start + 1);
  if (close === -1 || close - start > 300) return null;
  const label = text.slice(start + 1, close);
  if (label.includes("[") || label.includes("]")) return null;
  const m = LINK_TARGET.exec(text.slice(close + 1, close + 1 + MAX_HREF + 320));
  if (!m) return null;
  return { label, href: m[1], end: close + 1 + m[0].length };
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!<>|~]/;

/** Inline Markdown as a list of runs. `links`: false inside a link's own label. */
export function parseInline(text: string, policy: LinkPolicy, depth = 0, links = true): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  /** marker -> a position from which it has no closer: searching again from there or later finds none */
  const noCloser = new Map<string, number>();
  const flush = () => {
    if (buf.length > 0) out.push({ type: "text", text: buf });
    buf = "";
  };
  const closer = (marker: string, from: number): number => {
    const known = noCloser.get(marker);
    if (known !== undefined && known <= from) return -1;
    const at = text.indexOf(marker, from);
    if (at === -1) noCloser.set(marker, from);
    return at;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = closer(fence, i + n);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: text.slice(i + n, end).replace(/^ (.+) $/, "$1") });
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }
    if (c === "!" && text[i + 1] === "[") {
      // An image is its alt text: no image is ever loaded
      const m = matchLink(text, i + 1);
      if (m) {
        buf += m.label;
        i = m.end;
        continue;
      }
    }
    if (c === "[" && links) {
      const m = matchLink(text, i);
      if (m) {
        flush();
        const children = depth < MAX_DEPTH ? parseInline(m.label, policy, depth + 1, false) : [{ type: "text" as const, text: m.label }];
        const href = allowedHref(m.href, policy);
        if (href) out.push({ type: "link", href, children });
        else out.push(...children);
        i = m.end;
        continue;
      }
    }
    if (c === "<") {
      // An autolink: a link when it is allowed, else its address as text. Anything else in <> is text as written
      const m = /^<([a-z][a-z0-9+.-]{1,15}:[^\s<>]{1,500})>/i.exec(text.slice(i, i + 520));
      if (m) {
        const href = links ? allowedHref(m[1], policy) : null;
        if (href) {
          flush();
          out.push({ type: "link", href, children: [{ type: "text", text: m[1] }] });
        } else {
          buf += m[1];
        }
        i += m[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const double = text[i + 1] === c;
      const marker = double ? c + c : c;
      const after = text[i + marker.length];
      // `_` inside a word (snake_case) is not emphasis
      const inWord = c === "_" && i > 0 && /[A-Za-z0-9]/.test(text[i - 1]);
      if (after !== undefined && !/\s/.test(after) && after !== c && !inWord) {
        const end = closer(marker, i + marker.length + 1);
        if (end !== -1 && !/\s/.test(text[end - 1]) && !(c === "_" && /[A-Za-z0-9]/.test(text[end + marker.length] ?? ""))) {
          flush();
          const children = parseInline(text.slice(i + marker.length, end), policy, depth + 1, links);
          out.push(double ? { type: "strong", children } : { type: "em", children });
          i = end + marker.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** The blocks of a Markdown text, cut to MAX_MARKDOWN_CHARS. */
export function parseMarkdown(markdown: string, policy: LinkPolicy): Block[] {
  const lines = plainText(markdown)
    .split("\n")
    .map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line));
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" "), policy) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i];
    if (line.trim() === "") {
      endParagraph();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const marker = fence[1][0];
      const length = fence[1].length;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const closing = FENCE.exec(lines[i]);
        if (closing && closing[1][0] === marker && closing[1].length >= length && lines[i].trim() === closing[1]) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, children: parseInline(headingText(heading[2] ?? ""), policy) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      endParagraph();
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = ITEM.exec(lines[i]);
        if (next && /\d/.test(next[1]) === ordered) {
          if (items.length < MAX_LIST_ITEMS) items.push(next[2]);
          i++;
          continue;
        }
        // An indented line continues the item above
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i]) && !FENCE.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items: items.map((text) => parseInline(text, policy)) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(body.join(" "), policy) });
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  endParagraph();
  return blocks;
}

/** The text of inline runs, without their markup (a title, a summary). */
export function inlineText(runs: Inline[]): string {
  return runs.map((r) => (r.type === "text" || r.type === "code" ? r.text : inlineText(r.children))).join("");
}
