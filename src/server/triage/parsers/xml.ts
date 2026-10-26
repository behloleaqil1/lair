/**
 * A small, forgiving XML reader for test reports (JUnit XML and the like):
 * elements, attributes, text, CDATA and the five named entities plus
 * numeric ones. No DTDs, no namespaces. Unclosed or mismatched tags don't
 * throw; the reader recovers the way a browser would, by closing back to the
 * matching open element.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text and CDATA directly inside this element */
  text: string;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function fromCode(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return fromCode(parseInt(lower.slice(2), 16), match);
    if (lower.startsWith("#")) return fromCode(parseInt(lower.slice(1), 10), match);
    return NAMED[lower] ?? match;
  });
}

const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of text.matchAll(ATTR)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/** Parse a document; returns a synthetic root element named "#document". */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  const length = xml.length;
  let i = 0;

  while (i < length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      top().text += xml.slice(lt + 9, end < 0 ? length : end);
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
    const nameMatch = content.match(/^\s*([^\s/>]+)/);
    if (!nameMatch) continue;
    const element: XmlElement = {
      name: nameMatch[1],
      attrs: parseAttrs(content.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

/** Every descendant element with this name, in document order. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement) => {
    for (const child of el.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}
