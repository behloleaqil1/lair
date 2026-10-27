/**
 * The Settings forms' logic, without a DOM: fields from a section's JSON
 * Schema and the project's values, the widget each gets, and the changes a
 * draft makes (sent to PUT /api/settings/projects/:id). Components only draw
 * what this returns, so a module's new block or field needs no UI code.
 */
import type {
  FieldError,
  FieldHint,
  FieldWidget,
  JsonSchema,
  KnownSource,
  KnownValues,
  PathSegment,
  SettingsChange,
  SettingsSection,
} from "../shared/settings-types";
import { isCommandKey, isPlainObject, pathKey } from "../shared/settings-rules";

export type FieldKind = FieldWidget | "object" | "record" | "objects";

export interface FieldModel {
  key: string;
  /** From the file's top level */
  path: PathSegment[];
  /** Within the section, record keys and list indices as "*" (how hints are keyed) */
  pattern: string;
  schema: JsonSchema;
  kind: FieldKind;
  /** Undefined: not set (its default applies) */
  value: unknown;
  defaultValue: unknown;
  required: boolean;
  help?: string;
  advanced: boolean;
  /** Lair may run what this holds: changes to it are confirmed before a save */
  command: boolean;
  /** Decides what Lair runs or where it sends code and tokens: confirmed before a save too */
  sensitive: boolean;
  /** For a select: the allowed values; for text and lists: values to pick from */
  options?: string[];
  /** A key no schema knows: kept as it is, shown read-only */
  readOnly: boolean;
}

const PATH_KEY = /(^|_)(file|dir|path|directory|repo)$|^(path|cwd|work_dir|worktree_dir|log_file|session_dir)$/;
const GLOB_KEY = /(^|_)(paths|globs|ignore|test_files|compose_files|files)$/;
const LONG_TEXT = /(^|_)(instructions|description|body|prompt)$/;

const OPTION_KEYS: Record<string, KnownSource> = {
  adapter: "adapters",
  model: "models",
  machine: "machines",
  lane: "lanes",
  runners: "lanes",
  agent: "agents",
  agents: "agents",
};

/** A nullable schema's non-null side; other schemas unchanged. */
export function unwrap(schema: JsonSchema): JsonSchema {
  const options = schema.anyOf?.filter((s) => s.type !== "null");
  if (options && options.length === 1 && schema.anyOf!.length === 2) {
    return { ...options[0], default: schema.default ?? options[0].default, description: schema.description ?? options[0].description };
  }
  return schema;
}

function isStringList(schema: JsonSchema): boolean {
  const items = schema.items ? unwrap(schema.items) : undefined;
  return schema.type === "array" && !!items && (items.type === "string" || (items.enum?.every((v) => typeof v === "string") ?? false));
}

/** The widget a field gets: its hint's, else by schema and key. */
export function kindOf(key: string, schema: JsonSchema, hint: FieldHint | undefined, container?: PathSegment): FieldKind {
  if (hint?.widget) return hint.widget;
  const s = unwrap(schema);
  if (s.enum || s.const !== undefined) return "select";
  if (s.anyOf || s.oneOf || s.allOf) return "yaml";
  switch (s.type) {
    case "boolean":
      return "toggle";
    case "number":
    case "integer":
      return "number";
    case "string":
      if (LONG_TEXT.test(key)) return "textarea";
      if (PATH_KEY.test(key)) return "path";
      return "text";
    case "array": {
      if (isStringList(s)) {
        if (isCommandKey(key, container)) return "argv";
        if (GLOB_KEY.test(key)) return "globs";
        return "list";
      }
      const items = s.items ? unwrap(s.items) : undefined;
      if (items?.type === "object" && items.properties) return "objects";
      return "yaml";
    }
    case "object":
      if (s.properties && Object.keys(s.properties).length > 0) return "object";
      if (typeof s.additionalProperties === "object") return "record";
      return "yaml";
    default:
      return "yaml";
  }
}

function hintFor(section: SettingsSection, pattern: string): FieldHint | undefined {
  return section.hints[pattern];
}

function optionsFor(key: string, s: JsonSchema, hint: FieldHint | undefined, known: KnownValues | null): string[] | undefined {
  if (s.enum) return s.enum.map(String);
  if (s.const !== undefined) return [String(s.const)];
  const source = hint?.options ?? OPTION_KEYS[key];
  return source && known ? known[source] : undefined;
}

export interface FieldContext {
  section: SettingsSection;
  known: KnownValues | null;
}

/** One field: `key` with `schema` at `path` (pattern: the section-relative hint key). */
export function fieldFor(
  key: string,
  schema: JsonSchema,
  value: unknown,
  path: PathSegment[],
  pattern: string[],
  ctx: FieldContext,
  required = false,
): FieldModel {
  const hintKey = pattern.join(".");
  const hint = hintFor(ctx.section, hintKey);
  const container = path.length > 1 ? path[path.length - 2] : undefined;
  const kind = kindOf(key, schema, hint, container);
  const s = unwrap(schema);
  const command =
    hint?.command === true ||
    (isCommandKey(key, container) && ["argv", "text", "textarea", "path", "yaml", "list"].includes(kind));
  return {
    key,
    path,
    pattern: hintKey,
    schema: s,
    kind,
    value,
    defaultValue: s.default,
    required,
    help: hint?.help ?? s.description,
    advanced: hint?.advanced === true,
    command,
    sensitive: hint?.sensitive === true,
    options: optionsFor(key, s, hint, ctx.known),
    readOnly: false,
  };
}

/** The fields of an object schema at `path`, then the keys `value` has that the schema doesn't know (read-only). */
export function fieldsOf(schema: JsonSchema, value: unknown, path: PathSegment[], pattern: string[], ctx: FieldContext): FieldModel[] {
  const s = unwrap(schema);
  const values = isPlainObject(value) ? value : {};
  const required = new Set(s.required ?? []);
  const fields: FieldModel[] = [];
  for (const [key, child] of Object.entries(s.properties ?? {})) {
    fields.push(fieldFor(key, child, values[key], [...path, key], [...pattern, key], ctx, required.has(key)));
  }
  for (const [key, child] of Object.entries(values)) {
    if (s.properties && key in s.properties) continue;
    if (typeof s.additionalProperties === "object") {
      fields.push(fieldFor(key, s.additionalProperties, child, [...path, key], [...pattern, "*"], ctx));
    } else {
      fields.push({
        key,
        path: [...path, key],
        pattern: [...pattern, key].join("."),
        schema: {},
        kind: "yaml",
        value: child,
        defaultValue: undefined,
        required: false,
        advanced: false,
        command: false,
        sensitive: false,
        readOnly: true,
      });
    }
  }
  return fields;
}

/** A section's fields from the project's values (top-level keys for a core section, else its block's). */
export function sectionFields(section: SettingsSection, values: Record<string, unknown> | null, known: KnownValues | null): FieldModel[] {
  const ctx: FieldContext = { section, known };
  const all = values ?? {};
  if (section.root) {
    return fieldsOf({ ...section.schema, additionalProperties: undefined }, pick(all, section.blocks), [], [], ctx);
  }
  const schema = unwrap(section.schema);
  if (schema.type === "object" && schema.properties) return fieldsOf(schema, all[section.key], [section.key], [], ctx);
  return [fieldFor(section.key, schema, all[section.key], [section.key], [], ctx)];
}

function pick(values: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in values) out[key] = values[key];
  return out;
}

/** The fields of one record entry or list item of `field` (a record or a list of objects). */
export function entryFields(field: FieldModel, entry: PathSegment, value: unknown, ctx: FieldContext): FieldModel[] {
  const schema =
    field.kind === "record"
      ? (field.schema.additionalProperties as JsonSchema)
      : (field.schema.items ?? {});
  const path = [...field.path, entry];
  const pattern = [...(field.pattern === "" ? [] : field.pattern.split(".")), "*"];
  const s = unwrap(schema);
  if (s.type === "object" && s.properties) return fieldsOf(s, value, path, pattern, ctx);
  return [fieldFor(String(entry), s, value, path, pattern, ctx)];
}

/** Whether the section is switched on (its `enabled`, else its default). */
export function sectionEnabled(section: SettingsSection, values: Record<string, unknown> | null): boolean {
  const block = values?.[section.key];
  if (isPlainObject(block) && typeof block.enabled === "boolean") return block.enabled;
  return section.schema.properties?.enabled?.default === true;
}

// ============ VALUES ============

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameValue(a[k], b[k]));
  }
  return false;
}

/** `root` with the value at `path` set (undefined removes the key); `root` is not changed. */
export function setIn(root: unknown, path: PathSegment[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const list = Array.isArray(root) ? [...root] : [];
    if (value === undefined && rest.length === 0) {
      list.splice(head, 1);
      return list;
    }
    list[head] = setIn(list[head], rest, value);
    return list;
  }
  const object: Record<string, unknown> = isPlainObject(root) ? { ...root } : {};
  if (value === undefined && rest.length === 0) {
    delete object[head];
    return object;
  }
  object[head] = setIn(object[head], rest, value);
  return object;
}

export function getIn(root: unknown, path: PathSegment[]): unknown {
  let node = root;
  for (const segment of path) {
    if (typeof segment === "number") node = Array.isArray(node) ? node[segment] : undefined;
    else node = isPlainObject(node) ? node[segment] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * The changes that turn `before` into `after`: keys set or removed, objects
 * compared key by key, lists and scalars replaced whole. Keys nobody touched
 * are not sent, so the server leaves them (and their comments) alone.
 */
export function diffValues(before: unknown, after: unknown, path: PathSegment[] = []): SettingsChange[] {
  if (sameValue(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after) && path.length < 32) {
    const changes: SettingsChange[] = [];
    for (const key of Object.keys(before)) if (!(key in after)) changes.push({ path: [...path, key], remove: true });
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) changes.push({ path: [...path, key], value });
      else changes.push(...diffValues(before[key], value, [...path, key]));
    }
    return changes;
  }
  if (after === undefined) return [{ path, remove: true }];
  return [{ path, value: after }];
}

// ============ WIDGET VALUES ============

/** A list widget's text: one item per line (argv: one argument per line, never split on spaces). */
export function listToText(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n") : "";
}

/** The list a list widget's text means; empty lines are dropped, nothing else is changed. undefined when empty. */
export function textToList(text: string): string[] | undefined {
  const items = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  return items.length > 0 ? items : undefined;
}

/** A number field's text: empty unsets it; text that is no number is kept, so the server says why. */
export function textToNumber(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : trimmed;
}

/** "default: 60" for a field's placeholder, or "". */
export function defaultLabel(field: FieldModel): string {
  const d = field.defaultValue;
  if (d === undefined) return "";
  if (Array.isArray(d)) return d.length === 0 ? "default: none" : `default: ${d.join(" ")}`;
  if (isPlainObject(d)) return Object.keys(d).length === 0 ? "" : `default: ${JSON.stringify(d)}`;
  return `default: ${String(d)}`;
}

// ============ ERRORS ============

/** The errors at a field (exactly), and how many are inside it. */
export function errorsAt(errors: FieldError[], path: PathSegment[]): { here: string[]; inside: number } {
  const key = pathKey(path);
  const here = errors.filter((e) => e.path === key).map((e) => e.message);
  const inside = errors.filter((e) => e.path.startsWith(`${key}.`)).length;
  return { here, inside };
}

/** The errors no shown field owns: the file's own, and paths outside every section. */
export function generalErrors(errors: FieldError[], sections: SettingsSection[]): FieldError[] {
  const blocks = new Set(sections.flatMap((s) => s.blocks));
  return errors.filter((e) => e.path === "" || !blocks.has(e.path.split(".")[0]));
}

/** The section a top-level key belongs to. */
export function sectionOf(sections: SettingsSection[], key: string): SettingsSection | undefined {
  return sections.find((s) => s.blocks.includes(key));
}
