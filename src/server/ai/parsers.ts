/**
 * Readers of a tool's model list (its models_cmd output). Both are bounded:
 * at most MAX_MODEL_LINES lines are read, each cut to MAX_MODEL_LINE_CHARS
 * before any pattern sees it, and at most MAX_MODELS models are kept. The
 * output is the tool's text, so every id must look like a model id (never
 * an option), and labels and notes are plain one-line text.
 */
import type { ToolModel, ToolModelsParser } from "../../shared/types.js";
import { isShownModelId, scrub } from "./scrub.js";

export const MAX_MODEL_LINES = 2000;
export const MAX_MODEL_LINE_CHARS = 400;
export const MAX_MODELS = 300;
const MAX_TEXT = 200;

/** As the agents module's MODEL_ID: never starting with "-" */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/** A parsed model: every field set, as the models API returns it. */
export type ParsedModel = Required<Pick<ToolModel, "id" | "label" | "notes" | "default">>;

/** Terminal colours and other escape sequences, then the remaining control characters */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** The output's lines: bounded, without escape sequences or control characters. */
function cleanLines(output: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start <= output.length && lines.length < MAX_MODEL_LINES) {
    let end = output.indexOf("\n", start);
    if (end < 0) end = output.length;
    const raw = output.slice(start, Math.min(end, start + MAX_MODEL_LINE_CHARS * 2));
    const text = raw.replace(/\r$/, "").replace(ESCAPES, "").replace(/\t/g, "  ").replace(CONTROL, " ");
    lines.push(text.slice(0, MAX_MODEL_LINE_CHARS));
    start = end + 1;
  }
  return lines;
}

/** A label or a note: one line, bounded, without what could name an account or an organisation (scrub) */
const plain = (text: string) => scrub(text).slice(0, MAX_TEXT);

function add(models: ParsedModel[], model: ParsedModel): void {
  // A "model" that is a URL or an ARN is not shown (scrub.ts)
  if (!isShownModelId(model.id)) return;
  if (models.length >= MAX_MODELS || models.some((m) => m.id === model.id)) return;
  models.push(model);
}

/** "2.20x credits", "1.00x", "0.5x": a cost multiplier column */
const COST = /^\d+(?:\.\d+)?x\b/i;

/**
 * `kiro-cli chat --list-models`: one model per line, indented, the default
 * marked with "*", then columns separated by two or more spaces: the cost
 * multiplier and a description. The "*" may be indented too.
 *
 *     * auto                 1.00x credits  Models chosen by task for optimal usage
 *       claude-opus-4.5      2.20x credits  Claude Opus 4.5 model
 *
 * A line that is not indented or marked (a heading) is not a model.
 */
export function parseKiroModels(output: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const line of cleanLines(output)) {
    const match = /^(?:\s*(\*)\s+|\s+)(\S+)(?:\s{2,}(.*))?$/.exec(line.replace(/\s+$/, ""));
    if (!match || !MODEL_ID.test(match[2])) continue;
    const columns = (match[3] ?? "").split(/\s{2,}/).map(plain).filter((c) => c.length > 0);
    let notes = "";
    let label = "";
    if (columns.length >= 2) {
      notes = columns.slice(0, -1).join(" · ");
      label = columns[columns.length - 1];
    } else if (columns.length === 1) {
      if (COST.test(columns[0])) notes = columns[0];
      else label = columns[0];
    }
    add(models, { id: match[2], label: label || match[2], notes, default: match[1] === "*" });
  }
  // One default at most: the first one marked
  let seen = false;
  for (const model of models) {
    if (model.default && seen) model.default = false;
    if (model.default) seen = true;
  }
  return models;
}

/**
 * One model per line, for custom tools: the first word is the model id, the
 * rest of the line its label. Blank lines and lines starting with "#" are
 * skipped; a leading "* " marks the default.
 */
export function parseLineModels(output: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  let defaultSeen = false;
  for (const line of cleanLines(output)) {
    let text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    let isDefault = false;
    if (text.startsWith("* ")) {
      isDefault = !defaultSeen;
      text = text.slice(2).trim();
    }
    const [id, ...rest] = text.split(/\s+/);
    if (!MODEL_ID.test(id)) continue;
    const label = plain(rest.join(" "));
    const before = models.length;
    add(models, { id, label: label || id, notes: "", default: isDefault });
    if (isDefault && models.length > before) defaultSeen = true;
  }
  return models;
}

/** The parser a tool names (models_parser; "lines" when it names none). */
export function parseModels(parser: ToolModelsParser | undefined, output: string): ParsedModel[] {
  return parser === "kiro" ? parseKiroModels(output) : parseLineModels(output);
}

/** A preset's known list, as the API returns it. */
export function knownModels(models: readonly ToolModel[] | undefined): ParsedModel[] {
  const out: ParsedModel[] = [];
  for (const model of models ?? []) {
    if (typeof model?.id !== "string" || !MODEL_ID.test(model.id)) continue;
    add(out, {
      id: model.id,
      label: (typeof model.label === "string" ? plain(model.label) : "") || model.id,
      notes: typeof model.notes === "string" ? plain(model.notes) : "",
      default: model.default === true,
    });
  }
  return out;
}
