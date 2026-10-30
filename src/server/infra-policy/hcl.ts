/**
 * A small reader for the parts of HCL (.tf, .tofu) the policy scan needs:
 * blocks with their labels, string attributes and object attributes. It
 * never evaluates anything. Input it cannot read throws HclError, and the
 * scan treats that as a violation (fail closed).
 */

export class HclError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "HclError";
  }
}

export type Value =
  | { kind: "string"; value: string; interpolated: boolean }
  | { kind: "object"; attrs: Map<string, Value> }
  | { kind: "other"; raw: string };

export interface Block {
  type: string;
  labels: string[];
  line: number;
  attrs: Map<string, Value>;
  blocks: Block[];
}

type Token =
  | { t: "ident"; v: string; line: number }
  | { t: "string"; v: string; interpolated: boolean; line: number }
  | { t: "punct"; v: string; line: number }
  | { t: "nl"; line: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  /** Read a quoted string starting after the opening quote; handles ${...} (with nested strings) and escapes */
  const readQuoted = (): { v: string; interpolated: boolean } => {
    let v = "";
    let interpolated = false;
    const start = line;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        i++;
        return { v, interpolated };
      }
      if (c === "\n") throw new HclError("unterminated string", start);
      if (c === "\\") {
        const next = src[i + 1] ?? "";
        v += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 2;
        continue;
      }
      if ((c === "$" || c === "%") && src[i + 1] === c && src[i + 2] === "{") {
        // "$${" and "%%{" are escapes for a literal "${" and "%{"
        v += c + "{";
        i += 3;
        continue;
      }
      if ((c === "$" || c === "%") && src[i + 1] === "{") {
        interpolated = true;
        let depth = 0;
        while (i < n) {
          const d = src[i];
          if (d === "{") depth++;
          else if (d === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          } else if (d === '"') {
            i++;
            readQuoted();
            continue;
          } else if (d === "\n") line++;
          i++;
        }
        if (depth !== 0) throw new HclError("unterminated interpolation", start);
        continue;
      }
      v += c;
      i++;
    }
    throw new HclError("unterminated string", start);
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      out.push({ t: "nl", line });
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const start = line;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      if (i >= n) throw new HclError("unterminated comment", start);
      i += 2;
    } else if (c === '"') {
      const at = line;
      i++;
      const s = readQuoted();
      out.push({ t: "string", v: s.v, interpolated: s.interpolated, line: at });
    } else if (c === "<" && src[i + 1] === "<") {
      // heredoc: <<TAG or <<-TAG, up to a line holding only the tag
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(src.slice(i));
      if (!m) throw new HclError("bad heredoc", line);
      const at = line;
      const tag = m[1];
      i += m[0].length;
      line++;
      let body = "";
      let closed = false;
      while (i < n) {
        let end = src.indexOf("\n", i);
        if (end === -1) end = n;
        const text = src.slice(i, end);
        i = Math.min(end + 1, n);
        line++;
        if (text.trim() === tag) {
          closed = true;
          break;
        }
        body += text + "\n";
      }
      if (!closed) throw new HclError("unterminated heredoc", at);
      out.push({ t: "string", v: body, interpolated: true, line: at });
      out.push({ t: "nl", line: line - 1 });
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      out.push({ t: "ident", v: src.slice(i, j), line });
      i = j;
    } else {
      out.push({ t: "punct", v: c, line });
      i++;
    }
  }
  return out;
}

const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private lineAt(): number {
    return (this.peek() ?? this.tokens[this.tokens.length - 1])?.line ?? 1;
  }

  private skipNewlines(): void {
    while (this.peek()?.t === "nl") this.pos++;
  }

  private isPunct(v: string): boolean {
    const tok = this.peek();
    return tok?.t === "punct" && tok.v === v;
  }

  /** Body of a block (or file): items until `}` (or the end when `top`) */
  parseBody(top: boolean): { attrs: Map<string, Value>; blocks: Block[] } {
    const attrs = new Map<string, Value>();
    const blocks: Block[] = [];
    for (;;) {
      this.skipNewlines();
      const tok = this.peek();
      if (!tok) {
        if (top) return { attrs, blocks };
        throw new HclError("missing }", this.lineAt());
      }
      if (tok.t === "punct" && tok.v === "}") {
        if (top) throw new HclError("unexpected }", tok.line);
        this.pos++;
        return { attrs, blocks };
      }
      if (tok.t !== "ident") throw new HclError("expected a name", tok.line);
      this.pos++;
      if (this.isPunct("=")) {
        this.pos++;
        attrs.set(tok.v, this.parseValue(!top));
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.t === "string") {
          labels.push(next.v);
          this.pos++;
        } else if (next?.t === "ident") {
          labels.push(next.v);
          this.pos++;
        } else break;
      }
      if (!this.isPunct("{")) throw new HclError(`expected { after ${tok.v}`, tok.line);
      this.pos++;
      const inner = this.parseBody(false);
      blocks.push({ type: tok.v, labels, line: tok.line, ...inner });
      // the closing brace ends the line
      const after = this.peek();
      if (after && after.t !== "nl" && !(after.t === "punct" && after.v === "}")) {
        throw new HclError("expected a new line after }", after.line);
      }
    }
  }

  /** A value: a plain string, an object, or anything else (kept as raw text) */
  private parseValue(inObject: boolean): Value {
    const first = this.peek();
    if (!first) throw new HclError("missing value", this.lineAt());
    const second = this.tokens[this.pos + 1];
    const endsHere = (tok: Token | undefined) =>
      !tok || tok.t === "nl" || (tok.t === "punct" && (tok.v === "," || (inObject && tok.v === "}")));
    if (first.t === "string" && endsHere(second)) {
      this.pos++;
      return { kind: "string", value: first.v, interpolated: first.interpolated };
    }
    if (first.t === "punct" && first.v === "{") {
      const save = this.pos;
      const after = this.skipValue(inObject);
      // object only when it is the whole value
      if (endsHere(this.tokens[after])) {
        this.pos = save + 1;
        const obj = this.parseObject();
        return { kind: "object", attrs: obj };
      }
      this.pos = save;
    }
    const start = this.pos;
    this.pos = this.skipValue(inObject, true);
    const raw = this.tokens
      .slice(start, this.pos)
      .map((tok) => (tok.t === "nl" ? " " : tok.t === "string" ? JSON.stringify(tok.v) : tok.v))
      .join("");
    return { kind: "other", raw };
  }

  /** The index after the value starting at pos (balanced brackets; ends at a new line or comma at depth 0) */
  private skipValue(inObject: boolean, toEnd = false): number {
    let p = this.pos;
    const stack: string[] = [];
    const start = p;
    for (; p < this.tokens.length; p++) {
      const tok = this.tokens[p];
      if (tok.t === "punct") {
        if (OPEN[tok.v]) stack.push(OPEN[tok.v]);
        else if (tok.v === "}" || tok.v === "]" || tok.v === ")") {
          if (stack.length === 0) {
            if (inObject && tok.v === "}") return p;
            throw new HclError(`unexpected ${tok.v}`, tok.line);
          }
          if (stack.pop() !== tok.v) throw new HclError(`mismatched ${tok.v}`, tok.line);
          if (stack.length === 0 && !toEnd && p > start) return p + 1;
        } else if (tok.v === "," && stack.length === 0 && inObject) return p;
      } else if (tok.t === "nl" && stack.length === 0) return p;
    }
    if (stack.length > 0) throw new HclError("missing closing bracket", this.lineAt());
    return p;
  }

  /** Entries of an object value after its `{`, up to and including `}` */
  private parseObject(): Map<string, Value> {
    const attrs = new Map<string, Value>();
    for (;;) {
      while (this.peek()?.t === "nl" || this.isPunct(",")) this.pos++;
      const tok = this.peek();
      if (!tok) throw new HclError("missing }", this.lineAt());
      if (tok.t === "punct" && tok.v === "}") {
        this.pos++;
        return attrs;
      }
      if (tok.t !== "ident" && tok.t !== "string") throw new HclError("expected a key", tok.line);
      this.pos++;
      if (!(this.isPunct("=") || this.isPunct(":"))) throw new HclError("expected = after key", tok.line);
      this.pos++;
      attrs.set(tok.v, this.parseValue(true));
    }
  }
}

/** Parse the text of a .tf or .tofu file into its top-level blocks. */
export function parseHcl(src: string): Block[] {
  return new Parser(tokenize(src)).parseBody(true).blocks;
}

/** Turn a .tf.json document into the same blocks (only what the scan reads). */
export function parseHclJson(src: string): Block[] {
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch {
    throw new HclError("invalid JSON", 1);
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(doc)) throw new HclError("expected a JSON object", 1);

  const toValue = (v: unknown): Value => {
    if (typeof v === "string") return { kind: "string", value: v, interpolated: v.includes("${") };
    if (isObj(v)) return { kind: "object", attrs: new Map(Object.entries(v).map(([k, x]) => [k, toValue(x)])) };
    return { kind: "other", raw: JSON.stringify(v) };
  };
  /** JSON allows an object or an array of objects wherever HCL has one block */
  const each = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : [];
  const NESTED = new Set(["provisioner", "required_providers"]);
  const bodyOf = (type: string, labels: string[], body: Record<string, unknown>): Block => {
    const attrs = new Map<string, Value>();
    const blocks: Block[] = [];
    for (const [key, val] of Object.entries(body)) {
      if (NESTED.has(key)) {
        // provisioner: [{ "local-exec": {...} }]; required_providers: {...}
        if (key === "provisioner") {
          for (const p of each(val)) for (const [kind, inner] of Object.entries(p)) blocks.push(bodyOf("provisioner", [kind], isObj(inner) ? inner : {}));
        } else for (const e of each(val)) blocks.push(bodyOf(key, [], e));
      } else attrs.set(key, toValue(val));
    }
    return { type, labels, line: 1, attrs, blocks };
  };

  const out: Block[] = [];
  for (const [section, content] of Object.entries(doc)) {
    for (const group of each(content)) {
      if (section === "resource" || section === "data") {
        for (const [rtype, named] of Object.entries(group)) {
          for (const inst of each(named)) {
            for (const [name, body] of Object.entries(inst)) {
              for (const b of each(body)) out.push(bodyOf(section, [rtype, name], b));
            }
          }
        }
      } else if (section === "module" || section === "provider") {
        for (const [name, body] of Object.entries(group)) {
          for (const b of each(body)) out.push(bodyOf(section, [name], b));
        }
      } else if (section === "terraform") {
        out.push(bodyOf("terraform", [], group));
      }
    }
  }
  return out;
}
