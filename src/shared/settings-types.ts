/**
 * The Settings API (src/server/settings/): project configs read, checked and
 * written from the dashboard. See docs/design/settings-ui.md.
 */

/** The subset of JSON Schema the converter (src/server/settings/json-schema.ts) produces and the forms read. */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  /** false: no other keys (a strict zod object); a schema: a record's values */
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  discriminator?: { propertyName: string };
  /** The value also goes through a refinement or transform the schema can't express */
  "x-refined"?: boolean;
}

/** How a form draws a field (inferred when a hint names none). */
export type FieldWidget = "text" | "textarea" | "number" | "toggle" | "select" | "argv" | "list" | "globs" | "path" | "yaml";

/** Values a field can pick from, read from the project's own config. */
export type KnownSource = "agents" | "adapters" | "models" | "lanes" | "machines" | "profiles";

/**
 * Where a field shows (docs/design/settings-v2.md, "Progressive
 * disclosure"): basic fields by default, advanced and expert ones folded.
 * Search finds every level.
 */
export type FieldLevel = "basic" | "advanced" | "expert";

export interface FieldHint {
  /** The field's name in words (default: its key, in words) */
  label?: string;
  help?: string;
  /** Default basic; `advanced: true` is the same as level advanced */
  level?: FieldLevel;
  /** The group it belongs to on its page ("Timeouts", "Roles") */
  group?: string;
  /** A value shown as an example when the field has no default */
  example?: string;
  widget?: FieldWidget;
  options?: KnownSource;
  /** Folded under "Show advanced" (the same as level advanced) */
  advanced?: boolean;
  /** Makes Lair execute something (most are recognized by key: src/shared/settings-rules.ts) */
  command?: boolean;
  /**
   * Decides what Lair runs or where it sends code and tokens without being a
   * command itself (a host, a checkout action, an API URL): a change to it
   * needs the owner's confirmation like a command's
   */
  sensitive?: boolean;
}

/** One section of the forms: a module's block, or a group of top-level keys. */
export interface SettingsSection {
  key: string;
  title: string;
  /** true: `schema` describes top-level keys (core settings); false: the block `key` */
  root: boolean;
  /** The top-level keys this section edits */
  blocks: string[];
  schema: JsonSchema;
  /** Field path within the section ("a.b", "*" for any record key or list index) -> hint */
  hints: Record<string, FieldHint>;
  /** Its part of docs/configuration.md */
  docs?: string;
  /** The block has an `enabled` switch */
  toggle: boolean;
}

export type PathSegment = string | number;

/** One form edit: set the value at `path` (from the file's top level), or remove that key. */
export interface SettingsChange {
  path: PathSegment[];
  value?: unknown;
  remove?: boolean;
}

/** A problem with a field (`path` dotted, "" when no field owns it). */
export interface FieldError {
  path: string;
  message: string;
}

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Too different to compare line by line: shown as the whole file replaced */
  replaced?: boolean;
}

/** A command-bearing field a save adds or changes: what Lair runs before and after. */
export interface CommandChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface SecretStatus {
  label: string;
  /** "data/owner.token" or "env NAME" */
  where: string;
  set: boolean;
}

export interface KnownValues {
  agents: string[];
  adapters: string[];
  models: string[];
  lanes: string[];
  machines: string[];
  /** ai.profiles ids */
  profiles: string[];
}

export interface ProjectFileInfo {
  id: string;
  /** Relative to Lair's directory */
  file: string;
  /** In projects/local/ (git-ignored) */
  local: boolean;
  /** Settings can write it (a regular file, no symlink) */
  writable: boolean;
  problem?: string;
}

export interface ProjectSettingsView extends ProjectFileInfo {
  hash: string;
  yaml: string;
  /** The parsed file (null when it doesn't parse) */
  values: Record<string, unknown> | null;
  /** What keeps the current file from loading ([] when it loads) */
  errors: FieldError[];
  /** Top-level keys no section knows: kept as they are, shown read-only */
  unknownKeys: string[];
  known: KnownValues;
  secrets: SecretStatus[];
}

/** The outcome of a dry run or a refused save. */
export interface SettingsCheck {
  ok: boolean;
  errors: FieldError[];
  /** current file -> candidate */
  diff: LineDiff;
  yaml: string;
  commands: CommandChange[];
  /** Send back as confirmCommands to accept exactly these command changes */
  commandsDigest: string;
  /** The candidate was built on another version than the one on disk */
  conflict: boolean;
  /** The file's hash now */
  currentHash: string | null;
}

export interface SaveRequest {
  baseHash: string;
  yaml?: string;
  changes?: SettingsChange[];
  confirmCommands?: string;
}

export interface SaveResult {
  hash: string;
  version: string;
  diff: LineDiff;
  /** The live reload's view of the project after the save (a problem, when its modules kept the old config) */
  reloadProblem: string | null;
}

export interface CreateProjectRequest {
  id: string;
  name: string;
  repo: string;
  github?: string;
  queue_file?: string;
  agents_dir?: string;
  gates_dir?: string;
  /** Section keys to switch on (`<block>: {enabled: true}`) */
  modules?: string[];
  confirmCommands?: string;
}

export interface RepoCheck {
  path: string;
  exists: boolean;
  gitRepo: boolean;
  /** owner/name from the GitHub remote (origin first) */
  github: string | null;
  remotes: { name: string; url: string; github: string | null }[];
  /** Proposed paths for the queue, agent logs and gates */
  suggested: { queue_file: string; agents_dir: string; gates_dir: string };
  problem?: string;
}

export type HistoryAction = "create" | "save" | "restore" | "file";

export interface HistoryVersion {
  version: string;
  at: string;
  action: HistoryAction;
  /** The owner session's public id (never its value); null for a version found on disk */
  by: string | null;
  hash: string;
  bytes: number;
  restoredFrom?: string;
  /** A version found on disk with a secret in it: only this note is kept, never its text */
  redacted?: boolean;
}

export interface HistoryDetail {
  info: HistoryVersion;
  yaml: string;
  /** The version before it -> this one (null for the oldest kept) */
  fromPrevious: LineDiff | null;
  /** The current file -> this one: what restoring it changes */
  restoreDiff: LineDiff;
}
