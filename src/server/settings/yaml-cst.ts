/**
 * Form changes made in the project file's own text (the yaml library's CST:
 * every token of the file as written), so a save changes the lines it
 * changes and nothing else. Padded flow maps (`{ a: 1 }`), the spaces before
 * a comment, multi-line flow maps and `key:\n- a` lists stay exactly as they
 * were.
 *
 * Done in place:
 * - a scalar set to a scalar. Its quoting is kept, unless the value would
 *   then read as another type (`60`, `true`): it is double-quoted then;
 * - a list set to a list of the same length (item by item), and a map set
 *   to a map (key by key);
 * - a key removed from a block map or a flow map;
 * - a key with a scalar added to a block map or a flow map, like its
 *   siblings; a key with a map of scalars added to a block map whose values
 *   are flow maps, as a flow map like theirs.
 *
 * Anything else returns null, and yaml-doc.ts writes the document from its
 * nodes instead: a list that grows or shrinks, a map where there was none,
 * an alias, a block scalar, a multi-line string. So does a result that does
 * not read as the same values as the node-based write (yaml-doc.ts checks).
 */
import { CST, Composer, Parser, isMap, isScalar, isSeq, parse as parseYaml } from "yaml";
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";
import type { PathSegment, SettingsChange } from "../../shared/settings-types.js";
import { isPlainObject } from "../../shared/settings-rules.js";

type Coll = YAMLMap<unknown, unknown> | YAMLSeq<unknown>;
type ScalarValue = string | number | boolean | null;

interface Ctx {
  /** The file's line break */
  nl: string;
}

const MAX_DEPTH = 64;

function tok(type: CST.SourceToken["type"], source: string, indent = 0): CST.SourceToken {
  return { type, offset: -1, indent, source };
}

function isScalarValue(value: unknown): value is ScalarValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFlowScalar(token: CST.Token | null | undefined): token is CST.FlowScalar {
  return !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar");
}

function keyOf(pair: Pair<unknown, unknown>): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

/** An entry of a flow collection (not the padding or line break before its closing bracket). */
function isEntry(item: CST.CollectionItem): boolean {
  return item.key !== undefined || item.value !== undefined || (item.sep?.length ?? 0) > 0;
}

/** Whether `source`, read on its own, is `value` (a plain `60` is a number, not the string "60"). */
function reads(source: string, value: unknown): boolean {
  try {
    return parseYaml(source) === value;
  } catch {
    return false;
  }
}

const textOf = (value: ScalarValue): string => (typeof value === "string" ? value : String(value));

/** A new scalar token for `value`: plain where that reads as the value, else double-quoted. */
function scalarToken(value: ScalarValue, indent: number, inFlow: boolean, implicitKey: boolean, end: CST.SourceToken[]): CST.FlowScalar | null {
  if (typeof value === "string" && /[\r\n]/.test(value)) return null;
  const make = (type: Scalar.Type) => CST.createScalarToken(textOf(value), { indent, inFlow, implicitKey, end: [...end], type });
  let token = make("PLAIN");
  if (!isFlowScalar(token) || !reads(token.source, value)) token = make("QUOTE_DOUBLE");
  return isFlowScalar(token) && reads(token.source, value) ? token : null;
}

// ============ SCALARS ============

function setScalar(node: Scalar<unknown>, value: ScalarValue, inFlow: boolean): boolean {
  const token = node.srcToken;
  if (!isFlowScalar(token) || token.type === "alias") return false;
  if (node.value === value) return true;
  if (typeof value === "string" && /[\r\n]/.test(value)) return false;
  // A string keeps the token's quoting; a number, a boolean or null is plain
  CST.setScalarValue(token, textOf(value), { inFlow, type: typeof value === "string" ? undefined : "PLAIN" });
  if (!reads(token.source, value)) CST.setScalarValue(token, textOf(value), { inFlow, type: "QUOTE_DOUBLE" });
  return reads(token.source, value);
}

// ============ FLOW COLLECTIONS ============

/** The tokens after a flow value (padding before a comma or a bracket, a line break), taken off it; null when it has none of its own. */
function takeTrailing(value: CST.Token | undefined): CST.SourceToken[] | null {
  if (isFlowScalar(value)) {
    const out = value.end ?? [];
    value.end = [];
    return out;
  }
  if (value?.type === "flow-collection") {
    const at = value.end.findIndex((t) => t.type === "flow-map-end" || t.type === "flow-seq-end");
    return at < 0 ? null : value.end.splice(at + 1);
  }
  return null;
}

function putTrailing(value: CST.Token | undefined, tokens: CST.SourceToken[]): boolean {
  if (isFlowScalar(value)) {
    value.end = [...(value.end ?? []), ...tokens];
    return true;
  }
  if (value?.type === "flow-collection") {
    value.end.push(...tokens);
    return true;
  }
  return false;
}

function entriesOf(coll: CST.FlowCollection): number[] {
  return coll.items.flatMap((item, i) => (isEntry(item) ? [i] : []));
}

function removeFlow(coll: CST.FlowCollection, item: CST.CollectionItem): boolean {
  const at = coll.items.indexOf(item);
  const entries = entriesOf(coll);
  const pos = entries.indexOf(at);
  if (at < 0 || pos < 0) return false;
  if (entries.length > 1 && pos === entries.length - 1) {
    // The last entry: what followed it (the padding before the brace, a line break) now follows the one before it
    const moved = takeTrailing(item.value);
    if (moved === null || !putTrailing(coll.items[entries[pos - 1]].value, moved)) return false;
  } else if (entries.length > 1 && pos === 0) {
    // The first entry: the next one starts where it started, without its comma
    const next = coll.items[entries[1]];
    let k = 0;
    if (next.start[k]?.type === "comma") k++;
    while (next.start[k] && (next.start[k].type === "space" || next.start[k].type === "newline")) k++;
    next.start = [...item.start, ...next.start.slice(k)];
  }
  coll.items.splice(at, 1);
  return true;
}

function addFlow(coll: CST.FlowCollection, key: string, value: ScalarValue): boolean {
  if (coll.start.source !== "{") return false;
  const keyToken = scalarToken(key, coll.indent, true, true, []);
  const valueToken = scalarToken(value, coll.indent, true, false, []);
  if (!keyToken || !valueToken) return false;
  const sep = [tok("map-value-ind", ":", coll.indent), tok("space", " ", coll.indent)];
  const entries = entriesOf(coll);
  if (entries.length === 0) {
    coll.items.push({ start: [], key: keyToken, sep, value: valueToken });
    return true;
  }
  const lastAt = entries[entries.length - 1];
  const last = coll.items[lastAt];
  // On its own line when the entries are (a multi-line flow map), else after ", "
  const ws = last.start.filter((t) => t.type === "space" || t.type === "newline");
  const start = [tok("comma", ",", coll.indent), ...(ws.some((t) => t.type === "newline") ? ws.map((t) => ({ ...t })) : [tok("space", " ", coll.indent)])];
  const moved = takeTrailing(last.value);
  if (moved === null || !putTrailing(valueToken, moved)) return false;
  coll.items.splice(lastAt + 1, 0, { start, key: keyToken, sep, value: valueToken });
  return true;
}

// ============ BLOCK MAPS ============

/** A map of scalars as a flow map like its siblings (`{ a: 1 }` or `{a: 1}`), when every sibling's value is a flow map. */
function flowMapLikeSiblings(items: CST.CollectionItem[], value: Record<string, unknown>, indent: number, end: CST.SourceToken[]): CST.FlowCollection | null {
  const siblings = items.map((item) => item.value).filter((v): v is CST.Token => v !== undefined);
  const maps = siblings.filter((v): v is CST.FlowCollection => v.type === "flow-collection" && v.start.source === "{");
  if (siblings.length === 0 || maps.length !== siblings.length) return null;
  const model = maps.find((m) => entriesOf(m).length > 0);
  const padded = model ? model.items[0].start.some((t) => t.type === "space" || t.type === "newline") : false;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const out: CST.CollectionItem[] = [];
  for (const [i, [k, v]] of entries.entries()) {
    if (!isScalarValue(v)) return null;
    const keyToken = scalarToken(k, indent, true, true, []);
    const valueToken = scalarToken(v, indent, true, false, i === entries.length - 1 && padded ? [tok("space", " ", indent)] : []);
    if (!keyToken || !valueToken) return null;
    out.push({
      start: i === 0 ? (padded ? [tok("space", " ", indent)] : []) : [tok("comma", ",", indent), tok("space", " ", indent)],
      key: keyToken,
      sep: [tok("map-value-ind", ":", indent), tok("space", " ", indent)],
      value: valueToken,
    });
  }
  return { type: "flow-collection", offset: -1, indent, start: tok("flow-map-start", "{", indent), items: out, end: [tok("flow-map-end", "}", indent), ...end] };
}

function addBlock(ctx: Ctx, coll: CST.BlockMap, key: string, value: unknown): boolean {
  const items = coll.items as unknown as CST.CollectionItem[];
  let lastAt = -1;
  items.forEach((item, i) => {
    if (item.sep !== undefined) lastAt = i;
  });
  if (lastAt < 0) return false;
  // After the last entry, on a line of its own at the entries' indentation
  const endsLine = /\n$/.test(CST.stringify(items[lastAt]));
  const end = endsLine ? [tok("newline", ctx.nl, coll.indent)] : [];
  // The indentation of an entry on a line of its own (the first one's is its parent's), else the map's
  const sibling = items.slice(1).find((item) => item.sep !== undefined && item.start[item.start.length - 1]?.type === "space");
  const spaces = sibling ? sibling.start[sibling.start.length - 1].source : " ".repeat(coll.indent);
  const indent = spaces.length > 0 ? [tok("space", spaces, coll.indent)] : [];
  const keyToken = scalarToken(key, coll.indent, false, true, []);
  const valueToken: CST.Token | null = isScalarValue(value)
    ? scalarToken(value, coll.indent, false, false, end)
    : isPlainObject(value)
      ? flowMapLikeSiblings(items, value, coll.indent, end)
      : null;
  if (!keyToken || !valueToken) return false;
  items.splice(lastAt + 1, 0, {
    start: endsLine ? indent : [tok("newline", ctx.nl, coll.indent), ...indent],
    key: keyToken,
    sep: [tok("map-value-ind", ":", coll.indent), tok("space", " ", coll.indent)],
    value: valueToken,
  });
  return true;
}

// ============ CHANGES ============

function childOf(parent: Coll, segment: PathSegment): { node: unknown } | null {
  if (isMap(parent)) return { node: parent.items.find((p) => keyOf(p) === String(segment))?.value };
  if (typeof segment !== "number") return null;
  return { node: parent.items[segment] };
}

const inFlow = (coll: Coll) => coll.srcToken?.type === "flow-collection";

function remove(map: YAMLMap<unknown, unknown>, key: string): boolean {
  const pair = map.items.find((p) => keyOf(p) === key);
  if (!pair) return true;
  const coll = map.srcToken;
  const item = pair.srcToken;
  if (!coll || !item) return false;
  if (coll.type === "block-map") {
    const items = coll.items as unknown as CST.CollectionItem[];
    const at = items.indexOf(item);
    if (at < 0) return false;
    // A block map's entry holds its own line: its comment lines before it, the line itself and its line break.
    // The first entry's indentation is its parent's (after `key:`), so the next entry, now first, drops its own
    if (at === 0 && items.length > 1) {
      const next = items[1];
      let k = 0;
      while (next.start[k]?.type === "space") k++;
      next.start = [...item.start, ...next.start.slice(k)];
    }
    items.splice(at, 1);
    return true;
  }
  return coll.type === "flow-collection" && removeFlow(coll, item);
}

function add(ctx: Ctx, map: YAMLMap<unknown, unknown>, key: string, value: unknown): boolean {
  const coll = map.srcToken;
  if (coll?.type === "flow-collection") return isScalarValue(value) && addFlow(coll, key, value);
  return coll?.type === "block-map" && addBlock(ctx, coll, key, value);
}

function set(ctx: Ctx, parent: Coll, segment: PathSegment, value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const found = childOf(parent, segment);
  if (!found) return false;
  const node = found.node;
  if (node === undefined) return isMap(parent) && add(ctx, parent, String(segment), value);
  if (isScalar(node) && isScalarValue(value)) return setScalar(node, value, inFlow(parent));
  if (isSeq(node) && Array.isArray(value)) {
    return value.length === node.items.length && value.every((v, i) => set(ctx, node, i, v, depth + 1));
  }
  if (isMap(node) && isPlainObject(value)) {
    for (const pair of [...node.items]) {
      if (!Object.prototype.hasOwnProperty.call(value, keyOf(pair)) && !remove(node, keyOf(pair))) return false;
    }
    return Object.entries(value).every(([k, v]) => set(ctx, node, k, v, depth + 1));
  }
  return false;
}

function applyChange(ctx: Ctx, doc: Document.Parsed, change: SettingsChange): boolean {
  let parent: unknown = doc.contents;
  for (const segment of change.path.slice(0, -1)) {
    if (!isMap(parent) && !isSeq(parent)) return false;
    const found = childOf(parent, segment);
    if (!found) return false;
    const node = found.node;
    // Nothing to remove under a key that isn't there; a set there makes maps, which is not done in place
    if (node === undefined || (isScalar(node) && node.value === null)) return change.remove === true;
    parent = node;
  }
  if (!isMap(parent) && !isSeq(parent)) return false;
  const last = change.path[change.path.length - 1];
  if (change.remove === true) return isMap(parent) && remove(parent, String(last));
  return set(ctx, parent, last, change.value);
}

/**
 * `text` with `changes` made in place, or null when one of them can't be
 * (yaml-doc.ts then writes the document from its nodes). The changes are
 * already checked (checkChanges) and known to apply.
 */
export function editInPlace(text: string, changes: readonly SettingsChange[]): string | null {
  try {
    const tokens = Array.from(new Parser().parse(text));
    const docs = Array.from(new Composer({ keepSourceTokens: true, uniqueKeys: true }).compose(tokens));
    if (docs.length !== 1 || docs[0].errors.length > 0) return null;
    const ctx: Ctx = { nl: text.includes("\r\n") ? "\r\n" : "\n" };
    for (const change of changes) if (!applyChange(ctx, docs[0], change)) return null;
    return tokens.map((token) => CST.stringify(token)).join("");
  } catch {
    return null;
  }
}

/** Whether most of the file's flow maps have a space inside their braces (`{ a: 1 }`), so a whole-file write keeps them so. */
export function paddedFlowMaps(text: string): boolean {
  let padded = 0;
  let tight = 0;
  const visit = (token: CST.Token | null | undefined, depth: number): void => {
    if (!token || depth > MAX_DEPTH) return;
    if (token.type === "document") {
      visit(token.value, depth + 1);
    } else if (token.type === "block-map" || token.type === "block-seq" || token.type === "flow-collection") {
      if (token.type === "flow-collection" && token.start.source === "{" && entriesOf(token).length > 0) {
        if (token.items[0].start.some((t) => t.type === "space" || t.type === "newline")) padded++;
        else tight++;
      }
      for (const item of token.items as unknown as CST.CollectionItem[]) {
        visit(item.key, depth + 1);
        visit(item.value, depth + 1);
      }
    }
  };
  try {
    for (const token of new Parser().parse(text)) visit(token, 0);
  } catch {
    return false;
  }
  return padded > tight;
}
