/**
 * A small, forgiving XML reader for test reports (JUnit XML and the like):
 * elements, attributes, text, CDATA and the five named entities plus
 * numeric ones. No DTDs (so no external entities), no namespaces. Unclosed
 * or mismatched tags don't throw; the reader recovers the way a browser
 * would, by closing back to the matching open element.
 *
 * Reports are written by the code under test, so every scan is linear: no
 * regular expression runs over attribute text, a closing tag is matched
 * against at most the MAX_DEPTH innermost open elements, and at most
 * MAX_ELEMENTS elements and MAX_TEXT characters of text per element are
 * kept. Whatever reads the tree walks it without recursion.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text and CDATA directly inside this element */
  text: string;
}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 200_000;
const MAX_ATTRS = 64;
const MAX_TEXT = 256 * 1024;

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function fromCode(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,8});/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return fromCode(parseInt(lower.slice(2), 16), match);
    if (lower.startsWith("#")) return fromCode(parseInt(lower.slice(1), 10), match);
    return NAMED[lower] ?? match;
  });
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** Attributes of a start tag's body (after the name), in one left-to-right scan. */
function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let count = 0;
  let i = 0;
  const n = text.length;
  while (i < n && count < MAX_ATTRS) {
    while (i < n && isSpace(text[i])) i++;
    const nameStart = i;
    while (i < n && !isSpace(text[i]) && text[i] !== "=") i++;
    const name = text.slice(nameStart, i);
    while (i < n && isSpace(text[i])) i++;
    if (!name || text[i] !== "=") {
      // A bare word: skip it
      if (i === nameStart) i++;
      continue;
    }
    i++;
    while (i < n && isSpace(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, i + 1);
    const value = text.slice(i + 1, end < 0 ? n : end);
    attrs[name] = decodeEntities(value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value);
    count++;
    i = end < 0 ? n : end + 1;
  }
  return attrs;
}

function appendText(element: XmlElement, text: string): void {
  if (element.text.length >= MAX_TEXT) return;
  element.text += text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/** Parse a document; returns a synthetic root element named "#document". */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  const length = xml.length;
  let elements = 0;
  let i = 0;

  while (i < length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      appendText(top(), decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) appendText(top(), decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      appendText(top(), xml.slice(lt + 9, end < 0 ? length : end));
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? length : end + 1;
      continue;
    }
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      const name = xml.slice(lt + 2, end < 0 ? length : end).trim();
      // The stack holds at most MAX_DEPTH open elements, so this search is bounded
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? length : end + 1;
      continue;
    }

    // A start tag: find its closing '>' outside quoted attribute values
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < length; j++) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    const selfClosing = body.endsWith("/");
    const content = selfClosing ? body.slice(0, -1) : body;
    let nameEnd = 0;
    while (nameEnd < content.length && !isSpace(content[nameEnd]) && content[nameEnd] !== "/") nameEnd++;
    const name = content.slice(0, nameEnd);
    if (!name || elements >= MAX_ELEMENTS) continue;
    elements++;
    const element: XmlElement = { name, attrs: parseAttrs(content.slice(nameEnd)), children: [], text: "" };
    top().children.push(element);
    if (!selfClosing) {
      // Deeper than MAX_DEPTH, the outermost open element (below the root) is
      // forgotten: the tree keeps its shape, and a closing tag that only it
      // would match is ignored
      if (stack.length >= MAX_DEPTH) stack.splice(1, 1);
      stack.push(element);
    }
  }
  return root;
}

/** Every descendant element with this name, in document order (no recursion). */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [...element.children].reverse();
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el.name === name) out.push(el);
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return out;
}
