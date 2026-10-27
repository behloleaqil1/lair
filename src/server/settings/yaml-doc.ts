/**
 * Form changes applied to a project file through the yaml library's
 * Document API, so what nobody changed stays as it was: comments, key
 * order, quoting, flow or block style, and keys no form knows.
 *
 * A changed scalar keeps its node (its comments and quoting); a map or list
 * set to a new value is updated key by key and item by item; a node whose
 * kind changes (a scalar becoming a map) is replaced, keeping its comments.
 */
import {
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node as YamlNode,
} from "yaml";
import type { PathSegment, SettingsChange } from "../../shared/settings-types.js";
import { isPlainObject, pathKey } from "../../shared/settings-rules.js";

/** A change that can't be applied to the file (HTTP 400, nothing written). */
export class ChangeError extends Error {
  readonly statusCode = 400;
}

/** How Settings prints a document: no folding of long lines, `["a", "b"]` for flow lists. */
export const TO_STRING = { lineWidth: 0, flowCollectionPadding: false } as const;

export const MAX_CHANGES = 500;
export const MAX_PATH_DEPTH = 32;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** A flow list (`["a", "b"]`) is used for new lists of scalars up to this many characters */
const FLOW_MAX = 120;

type Collection = YAMLMap<unknown, unknown> | YAMLSeq<unknown>;
type Child = YamlNode | null | undefined;

/** Parse a project file into a document; YAML errors are returned, not thrown. */
export function parseConfigDocument(text: string): { doc: Document<YamlNode, true>; errors: string[] } {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true }) as unknown as Document<YamlNode, true>;
  return { doc, errors: doc.errors.map((e) => e.message) };
}

function keyOf(pair: Pair<unknown, unknown>): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function findPair(map: YAMLMap<unknown, unknown>, key: string): Pair<unknown, unknown> | undefined {
  return map.items.find((p) => keyOf(p) === key);
}

function getChild(parent: Collection, segment: PathSegment): { node: Child; exists: boolean } {
  if (isMap(parent)) {
    const pair = findPair(parent, String(segment));
    return { node: pair?.value as Child, exists: pair !== undefined };
  }
  if (typeof segment !== "number") return { node: undefined, exists: false };
  return { node: parent.items[segment] as Child, exists: segment < parent.items.length };
}

function setChild(parent: Collection, segment: PathSegment, node: YamlNode, at: PathSegment[]): void {
  if (isMap(parent)) {
    const pair = findPair(parent, String(segment));
    if (pair) pair.value = node;
    else parent.items.push(new Pair(new Scalar(String(segment)), node));
    return;
  }
  if (typeof segment !== "number" || segment > parent.items.length) {
    throw new ChangeError(`${pathKey(at)}: no such list item`);
  }
  if (segment === parent.items.length) parent.items.push(node);
  else parent.items[segment] = node;
}

function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** New lists of scalars print as flow lists (`["git", "pull"]`), like the argv lists in the docs. */
function styleNew(node: YamlNode): void {
  if (isSeq(node)) {
    const scalars = node.items.every((item) => isScalar(item));
    const width = JSON.stringify(node.toJSON()).length;
    if (scalars && node.items.length > 0 && width <= FLOW_MAX) node.flow = true;
    else for (const item of node.items) if (isNode(item)) styleNew(item);
  } else if (isMap(node)) {
    for (const pair of node.items) if (isNode(pair.value)) styleNew(pair.value);
  }
}

function makeNode(doc: Document<YamlNode, true>, value: unknown): YamlNode {
  const node = doc.createNode(value) as YamlNode;
  styleNew(node);
  return node;
}

function carryComments(from: Child, to: YamlNode): void {
  if (!from || !isNode(from)) return;
  if (from.commentBefore) to.commentBefore = from.commentBefore;
  if (from.comment) to.comment = from.comment;
  if (from.spaceBefore) to.spaceBefore = from.spaceBefore;
}

/** Make the node at parent[segment] hold `value`, keeping what is unchanged. */
function assign(doc: Document<YamlNode, true>, parent: Collection, segment: PathSegment, existing: Child, value: unknown, at: PathSegment[]): void {
  if (existing && isMap(existing) && isPlainObject(value)) {
    existing.items = existing.items.filter((pair) => Object.prototype.hasOwnProperty.call(value, keyOf(pair)));
    for (const [key, v] of Object.entries(value)) {
      const pair = findPair(existing, key);
      if (pair) assign(doc, existing, key, pair.value as Child, v, [...at, key]);
      else existing.items.push(new Pair(new Scalar(key), makeNode(doc, v)));
    }
    return;
  }
  if (existing && isSeq(existing) && Array.isArray(value)) {
    value.forEach((v, i) => {
      if (i < existing.items.length) assign(doc, existing, i, existing.items[i] as Child, v, [...at, i]);
      else existing.items.push(makeNode(doc, v));
    });
    existing.items.splice(value.length);
    return;
  }
  if (existing && isScalar(existing) && isScalarValue(value) && existing.value !== null && typeof existing.value === typeof value) {
    if (existing.value !== value) existing.value = value;
    return;
  }
  const node = makeNode(doc, value);
  if (isSeq(existing) && isSeq(node) && existing.flow !== undefined) node.flow = existing.flow;
  carryComments(existing, node);
  setChild(parent, segment, node, at);
}

function checkPath(path: unknown): PathSegment[] {
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH_DEPTH) {
    throw new ChangeError(`a change needs a path of 1 to ${MAX_PATH_DEPTH} keys`);
  }
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Number.isInteger(segment) || segment < 0) throw new ChangeError("a list index is a whole number from 0");
    } else if (typeof segment !== "string" || segment.length === 0 || segment.length > 200) {
      throw new ChangeError("a key is a string of 1 to 200 characters");
    } else if (FORBIDDEN_KEYS.has(segment)) {
      throw new ChangeError(`the key ${segment} is not allowed`);
    }
  }
  if (typeof path[0] !== "string") throw new ChangeError("a change starts with a top-level key");
  return path as PathSegment[];
}

function checkValue(value: unknown, at: string, depth = 0): void {
  if (depth > 64) throw new ChangeError(`${at}: the value is nested too deeply`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkValue(v, `${at}.${i}`, depth + 1));
  } else if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new ChangeError(`${at}: the key ${key} is not allowed`);
      checkValue(v, `${at}.${key}`, depth + 1);
    }
  } else if (!isScalarValue(value)) {
    throw new ChangeError(`${at}: not a YAML value`);
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ChangeError(`${at}: not a finite number`);
  }
}

/** The collection at path[0..i], created (a map, or a list before an index) where it is missing or empty. */
function containerFor(doc: Document<YamlNode, true>, path: PathSegment[], create: boolean): Collection | null {
  let current: Collection;
  if (isMap(doc.contents)) {
    current = doc.contents;
  } else if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    if (!create) return null;
    const map = new YAMLMap<unknown, unknown>();
    doc.contents = map;
    current = map;
  } else {
    throw new ChangeError("the file's top level is not a mapping");
  }
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const { node } = getChild(current, segment);
    if (isMap(node) || isSeq(node)) {
      current = node;
      continue;
    }
    if (node && !(isScalar(node) && node.value === null)) {
      throw new ChangeError(`${pathKey(path.slice(0, i + 1))} is not a mapping or a list`);
    }
    if (!create) return null;
    const made: Collection = typeof path[i + 1] === "number" ? new YAMLSeq<unknown>() : new YAMLMap<unknown, unknown>();
    carryComments(node, made);
    setChild(current, segment, made, path.slice(0, i + 1));
    current = made;
  }
  return current;
}

function applyOne(doc: Document<YamlNode, true>, change: SettingsChange): void {
  const path = checkPath(change.path);
  const last = path[path.length - 1];
  if (change.remove === true) {
    const parent = containerFor(doc, path, false);
    if (!parent) return;
    if (isMap(parent)) parent.items = parent.items.filter((pair) => keyOf(pair) !== String(last));
    else if (typeof last === "number" && last < parent.items.length) parent.items.splice(last, 1);
    return;
  }
  if (!("value" in change) || change.value === undefined) {
    throw new ChangeError(`${pathKey(path)}: a change sets a value or removes the key`);
  }
  checkValue(change.value, pathKey(path));
  const parent = containerFor(doc, path, true)!;
  const { node } = getChild(parent, last);
  assign(doc, parent, last, node, change.value, path);
}

/** Validate the shape of a change list (before anything is applied). */
export function checkChanges(changes: unknown): SettingsChange[] {
  if (!Array.isArray(changes) || changes.length === 0) throw new ChangeError("no changes");
  if (changes.length > MAX_CHANGES) throw new ChangeError(`at most ${MAX_CHANGES} changes in one save`);
  for (const change of changes) {
    if (!isPlainObject(change)) throw new ChangeError("a change is an object with a path");
    checkPath(change.path);
  }
  return changes as SettingsChange[];
}

/**
 * The file's text with `changes` applied, in order. Throws ChangeError for a
 * change that can't apply, and when the file itself doesn't parse (edit it in
 * the YAML tab then).
 */
export function applyChanges(text: string, changes: SettingsChange[]): string {
  const { doc, errors } = parseConfigDocument(text);
  if (errors.length > 0) {
    throw new ChangeError(`the file has YAML errors; fix them in the YAML tab first: ${errors[0]}`);
  }
  for (const change of checkChanges(changes)) applyOne(doc, change);
  return doc.toString(TO_STRING);
}

/** A new document from a plain object (key order kept), with a comment at the top. */
export function newConfigText(values: Record<string, unknown>, headerComment: string): string {
  const { doc } = parseConfigDocument("");
  const map = new YAMLMap<unknown, unknown>();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) map.items.push(new Pair(new Scalar(key), makeNode(doc, value)));
  }
  doc.contents = map;
  doc.commentBefore = headerComment;
  return doc.toString(TO_STRING);
}
