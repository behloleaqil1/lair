/**
 * The planner agent's proposals (docs/design/planner.md#checks): its only
 * output, a JSON file in its run's directory. Lair reads it with bounds and
 * checks every proposal, in order, against the schema, fill's task-id rules,
 * the allowlist, the tasks file as the earlier proposals left it, and the
 * cap. The agent is the untrusted party: nothing it writes is acted on
 * before these checks, and its text only ever becomes a description.
 */
import { z } from "zod";
import { PLANNER_OPS, type PlannerOp } from "../../shared/planner-types.js";
import { isValidTaskId } from "../agents/types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { clean, readInside } from "./files.js";
import { applyEdit, findTask, MAX_DESCRIPTION_CHARS, type TaskEdit, type TasksDoc } from "./tasks-file.js";

export const PROPOSAL_FILE = "proposals.json";
export const MAX_PROPOSAL_FILE_BYTES = 256 * 1024;
const MAX_REASON_CHARS = 500;
/** More items than this and the file is refused whole */
const MAX_ITEMS = 1000;

const ProposalSchema = z
  .object({
    op: z.enum(PLANNER_OPS),
    task: z.string().min(1).max(200),
    agent: z.string().min(1).max(100).optional(),
    text: z.string().min(1).max(4000).optional(),
    reason: z.string().min(1).max(4000),
  })
  .strict();

const FileSchema = z.object({ proposals: z.array(z.unknown()).max(MAX_ITEMS) }).strict();

export type ProposalFile = { ok: true; items: unknown[] } | { ok: false; reason: string };

/** The proposal file of a run: a regular file in the run's directory (no symlink), at most 256 KB, JSON. */
export function readProposalFile(path: string, runDir: string): ProposalFile {
  const read = readInside(path, [runDir], MAX_PROPOSAL_FILE_BYTES, "whole");
  if (!read.ok) return { ok: false, reason: `the proposal file: ${read.reason}` };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch (e) {
    return { ok: false, reason: `the proposal file is not JSON (${e instanceof Error ? e.message.slice(0, 200) : "parse error"})` };
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the proposal file is not {"proposals": [...]} (${issue.path.join(".") || "(root)"}: ${issue.message})` };
  }
  return { ok: true, items: parsed.data.proposals };
}

/** A proposal after the checks: what to store, and the edit it makes when accepted. */
export interface CheckedProposal {
  index: number;
  op: string;
  task: string;
  agent: string | null;
  text: string | null;
  reason: string;
  refusal: string | null;
  /** The tasks-file edit (null for unblock, and when refused) */
  edit: TaskEdit | null;
}

export interface CheckContext {
  maxProposals: number;
  allowlist: string[];
  plannerAgent: string | null;
  taskIdPattern: RegExp | null;
  doneMarker: string;
  /** The tasks file now */
  doc: TasksDoc;
  /** The agent's display name for a new or reassigned line */
  nameOf: (agent: string) => string;
  /** The active run of a task, if any */
  activeRun: (task: string) => { id: string; agent: string } | null;
}

function field(value: unknown, max: number): string {
  return typeof value === "string" ? clean(value, max) : "";
}

/** Check one proposal against the tasks file as `doc` is. Null when it passes; else why not. */
function refusalOf(p: z.infer<typeof ProposalSchema>, text: string | null, ctx: CheckContext, doc: TasksDoc): string | null {
  if (!isValidTaskId(p.task)) {
    return `${clean(p.task, 80)} is not a valid task id (1-128 letters, digits, '.', '_', '-', '/', ':', '#', starting with a letter or digit, no '.' or '..' segment)`;
  }
  if (ctx.taskIdPattern && !ctx.taskIdPattern.test(p.task)) return `task ${p.task} does not match planner.task_id_pattern`;
  const needsAgent = p.op === "add" || p.op === "reassign";
  if (needsAgent && !p.agent) return `${p.op} needs an agent`;
  if (!needsAgent && p.agent !== undefined) return `${p.op} takes no agent`;
  if (p.agent !== undefined) {
    if (!isValidDragonId(p.agent)) return `${clean(p.agent, 80)} is not a valid agent id`;
    if (p.agent === ctx.plannerAgent) return `${p.agent} is the planner agent: it never takes a task`;
    if (!ctx.allowlist.includes(p.agent)) return `agent ${p.agent} is not in agents.fill.agents (the allowlist)`;
  }
  const needsText = p.op === "add" || p.op === "reword";
  if (needsText && !text) return `${p.op} needs text (one line)`;
  if (!needsText && p.text !== undefined) return `${p.op} takes no text`;
  if (text && text.length > MAX_DESCRIPTION_CHARS) return `text is longer than ${MAX_DESCRIPTION_CHARS} characters`;
  const line = findTask(doc, p.task);
  if (p.op === "add") {
    if (line) return `task ${p.task} is already in the tasks file (line ${line.line})`;
    if (doc.done.has(p.task)) return `task ${p.task} is done (line ${doc.done.get(p.task)}): task ids are not reused`;
    return null;
  }
  if (!line) return `task ${p.task} has no open line in the tasks file`;
  if (p.op === "reassign" && p.agent === line.agent) return `task ${p.task} is already ${p.agent}'s`;
  if (p.op === "reassign" || p.op === "drop") {
    const active = ctx.activeRun(p.task);
    if (active) return `task ${p.task} has an active run (${active.id.slice(0, 8)} of ${active.agent}): ${p.op} it once that run ends`;
  }
  return null;
}

function editOf(p: z.infer<typeof ProposalSchema>, text: string | null, ctx: CheckContext): TaskEdit | null {
  switch (p.op) {
    case "add":
      return { op: "add", agent: p.agent ?? "", name: ctx.nameOf(p.agent ?? ""), task: p.task, description: text ?? "" };
    case "finish":
      return { op: "mark_done", task: p.task };
    case "reassign":
      return { op: "reassign", task: p.task, agent: p.agent ?? "", name: ctx.nameOf(p.agent ?? "") };
    case "reword":
      return { op: "reword", task: p.task, description: text ?? "" };
    case "drop":
      return { op: "drop", task: p.task };
    case "unblock":
      return null;
  }
}

/**
 * Check every item, in order. An accepted edit is applied to a working copy
 * of the tasks file, so a later proposal is checked against what the earlier
 * ones leave (and the file's bounds hold for all of them together). Items
 * past maxProposals are refused.
 */
export function checkProposals(items: unknown[], ctx: CheckContext): { checked: CheckedProposal[]; doc: TasksDoc } {
  const checked: CheckedProposal[] = [];
  const tasks = new Set<string>();
  let doc = ctx.doc;
  items.forEach((item, index) => {
    const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const base: CheckedProposal = {
      index,
      op: field(raw.op, 20) || "(none)",
      task: field(raw.task, 128) || "(none)",
      agent: typeof raw.agent === "string" ? field(raw.agent, 64) : null,
      text: typeof raw.text === "string" ? field(raw.text, MAX_DESCRIPTION_CHARS + 3) : null,
      reason: field(raw.reason, MAX_REASON_CHARS) || "(no reason given)",
      refusal: null,
      edit: null,
    };
    if (index >= ctx.maxProposals) {
      checked.push({ ...base, refusal: `over the cap of ${ctx.maxProposals} proposals per run` });
      return;
    }
    const parsed = ProposalSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      checked.push({ ...base, refusal: `not a proposal: ${issue.path.join(".") || "(item)"}: ${issue.message}` });
      return;
    }
    const p = parsed.data;
    // The text becomes a description: one line, control characters removed, never longer than a description
    const text = p.text !== undefined ? clean(p.text, 4000) : null;
    let refusal = refusalOf(p, text, ctx, doc);
    if (!refusal && tasks.has(p.task)) refusal = `another proposal of this run is about task ${p.task}`;
    if (!refusal && !clean(p.reason, MAX_REASON_CHARS)) refusal = "the reason is empty";
    const edit = refusal ? null : editOf(p, text, ctx);
    if (!refusal && edit) {
      const result = applyEdit(doc, edit, ctx.doneMarker);
      if (result.ok) doc = result.doc;
      else refusal = result.reason;
    }
    if (!refusal) tasks.add(p.task);
    checked.push({
      ...base,
      op: p.op,
      task: p.task,
      agent: p.agent ?? null,
      text,
      reason: clean(p.reason, MAX_REASON_CHARS),
      refusal,
      edit: refusal ? null : edit,
    });
  });
  return { checked, doc };
}

export function isOp(op: string): op is PlannerOp {
  return (PLANNER_OPS as readonly string[]).includes(op);
}
