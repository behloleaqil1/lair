/**
 * The readiness report (docs/design/planner-act.md §4.4): for each part with an off/observe/act mode, whether the
 * evidence of the last planner.act_evidence.days says it may switch to act, and, for a part already in act, whether a
 * change it applied was undone or edited back within 24 hours. It reads only planner.db (proposals, changes, the
 * mode history and the would_* records in planner_state) and the spend events. It never writes and never switches a
 * mode: that stays the owner's config change.
 */
import type {
  ChangeView,
  PlannerReadinessView,
  ReadinessCriterionView,
  ReadinessPart,
  ReadinessRowView,
} from "../../shared/planner-types.js";
import type { PlannerStore, StoredProposal } from "./store.js";

/** planner_state: the modes at each config load that changed them, the oldest first */
export const MODE_HISTORY = "mode_history";
export const MAX_MODE_HISTORY = 200;
/** planner_state: what the backlog and spec parts would have done in observe, the oldest first */
export const WOULD = "act_evidence";
export const MAX_WOULD = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LISTED = 50;
/** The backlog's default skip marker (planner-act.md §4.1); a would_add for a task it marks is a failed sample */
export const DEFAULT_SKIP_PATTERN = /\[(owner-only|blocked)\]/i;

export interface ModeEntry {
  at: number;
  mode: string;
  /** Each planner guard's mode, by its config key */
  guards: Record<string, string>;
  /** Each part's mode (backlog.mode, backlog.assign, spec_first.mode); a part missing here is off */
  parts: Partial<Record<Exclude<ReadinessPart, "planner.mode">, string>>;
}

/** One thing a part would have done in observe (recorded by that part, once per task, or task and agent) */
export interface WouldRecord {
  kind: "would_add" | "would_assign" | "would_spec";
  task: string;
  /** would_assign: the agent it would have given the line to */
  agent: string | null;
  at: number;
  /** The task's plan text when recorded (at most 500 characters) */
  planText: string;
  /** would_spec: a spec link of the task's that had already merged (a false positive), else null */
  specLink: string | null;
}

/** Append a would_* record (the newest MAX_WOULD are kept). */
export function recordWould(store: PlannerStore, project: string, record: WouldRecord): void {
  const all = store.get<WouldRecord[]>(project, WOULD) ?? [];
  store.set(project, WOULD, [...all, { ...record, planText: record.planText.slice(0, 500) }].slice(-MAX_WOULD));
}

/** The history with `entry` appended, or null when the modes are the newest entry's. */
export function nextModeHistory(history: ModeEntry[], entry: ModeEntry): ModeEntry[] | null {
  const newest = history.at(-1);
  const same = (a: ModeEntry, b: ModeEntry) =>
    a.mode === b.mode && JSON.stringify(a.guards) === JSON.stringify(b.guards) && JSON.stringify(a.parts) === JSON.stringify(b.parts);
  if (newest && same(newest, entry)) return null;
  return [...history, entry].slice(-MAX_MODE_HISTORY);
}

export interface ReadinessInput {
  now: number;
  days: number;
  minSamples: number;
  minAgreement: number;
  /** The ops a verifier's approve applies by itself in act (verifier.auto_apply with approval never) */
  autoOps: string[];
  /** Proposals since the window's start */
  proposals: StoredProposal[];
  /** Changes since the window's start or the switch to act, whichever is earlier, the oldest first */
  changes: ChangeView[];
  /** The times of planner_dedupe_pending's would_refuse and refuse events in the window; null: spend is not readable */
  dedupeEvents: number[] | null;
  history: ModeEntry[];
  would: WouldRecord[];
  doneMarker: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ratio = (n: number, d: number) => Math.round((n / d) * 100) / 100;
/** A diff row's line ("+5 a|b|c|d" -> "a|b|c|d") */
const body = (row: string) => row.replace(/^[-+]\d+ /, "");

/** A tasks file line's agent and task (fill's format, agent|name|task|description), or null for any other line. */
function lineOf(line: string, doneMarker: string): { agent: string; task: string; done: boolean } | null {
  const marker = doneMarker.trimEnd();
  const done = line.startsWith(marker);
  const text = done ? line.slice(marker.length).trimStart() : line;
  if (!done && text.startsWith("#")) return null;
  const fields = text.split("|");
  if (fields.length < 4) return null;
  return { agent: fields[0].trim(), task: fields[2].trim(), done };
}

/** The most per UTC day, and that day. */
function perDay(times: number[]): { most: number; day: string | null } {
  const counts = new Map<string, number>();
  for (const t of times) {
    const day = iso(t).slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let most = 0;
  let day: string | null = null;
  for (const [d, n] of counts) if (n > most) [most, day] = [n, d];
  return { most, day };
}

function verdictOf(criteria: ReadinessCriterionView[]): "ready" | "not_yet" {
  return criteria.every((c) => c.ok) ? "ready" : "not_yet";
}

/** The mode a part had at `at` (the newest entry at or before it), or null when the history doesn't reach back. */
function modeAt(history: ModeEntry[], at: number): ModeEntry | null {
  let found: ModeEntry | null = null;
  for (const e of history) if (e.at <= at) found = e;
  return found;
}

const partMode = (e: ModeEntry | null | undefined, part: ReadinessPart): string =>
  !e ? "off" : part === "planner.mode" ? e.mode : (e.parts[part] ?? "off");

/** When the newest streak of act began, or null when the part is not in act now. */
export function switchedAt(history: ModeEntry[], part: ReadinessPart): number | null {
  let at: number | null = null;
  for (let i = history.length - 1; i >= 0 && partMode(history[i], part) === "act"; i--) at = history[i].at;
  return at;
}

function plannerRow(input: ReadinessInput, since: number): ReadinessRowView {
  const { minSamples, minAgreement, autoOps } = input;
  const verified = input.proposals.filter(
    (p) => autoOps.includes(p.op) && (p.verifierVerdict === "approve" || p.verifierVerdict === "reject" || p.verifierVerdict === "unsure"),
  );
  const approved = verified.filter((p) => p.verifierVerdict === "approve" && (p.decidedBy ?? "").startsWith("owner"));
  const agreed = approved.filter((p) => p.status === "applied");
  const refusals = input.proposals
    .filter((p) => p.status === "rejected" && p.decidedBy === "lair" && (p.refusal ?? "").endsWith("(planner.act.refuse_undone_days)"))
    .map((p) => p.decidedAt ?? p.createdAt);
  const dedupe = input.dedupeEvents === null ? null : perDay(input.dedupeEvents);
  const refused = perDay(refusals);
  // The entry in force when the window starts, and every entry since: recheck_on_change observe or act in each
  const start = modeAt(input.history, since);
  const covering = start ? [start, ...input.history.filter((e) => e.at > since)] : [];
  const lastOff = covering.filter((e) => e.guards.recheck_on_change !== "observe" && e.guards.recheck_on_change !== "act").at(-1);
  const offUntil = lastOff ? (input.history.find((e) => e.at > lastOff.at)?.at ?? null) : null;
  const criteria: ReadinessCriterionView[] = [
    {
      id: "verified",
      label: "(1) verified samples",
      ok: verified.length >= minSamples,
      detail:
        autoOps.length === 0
          ? "no op applies by itself on a verifier's approve (verifier.auto_apply with approval never)"
          : `${verified.length} verified proposals in auto-applied ops (${autoOps.join(", ")}); ${minSamples} needed`,
    },
    {
      id: "agreement",
      label: "(2) owner agreement",
      ok: approved.length > 0 && agreed.length / approved.length >= minAgreement,
      detail:
        approved.length === 0
          ? "the owner decided none the verifier approved"
          : `the owner approved ${agreed.length} of the ${approved.length} the verifier approved (${ratio(agreed.length, approved.length)}); ${minAgreement} needed`,
    },
    {
      id: "dedupe",
      label: "(3) dedupe_pending would_refuse per day",
      ok: dedupe !== null && dedupe.most <= 1,
      detail:
        dedupe === null
          ? "the spend events can't be read (agents.spend)"
          : dedupe.most === 0
            ? "none"
            : `at most ${dedupe.most} on one day (${dedupe.day}); at most 1 allowed`,
    },
    {
      id: "refusals",
      label: "(4) refusal-window refusals per day",
      ok: refused.most <= 1,
      detail: refused.most === 0 ? "none" : `at most ${refused.most} on one day (${refused.day}); at most 1 allowed`,
    },
    {
      id: "recheck_history",
      label: "(5) recheck_on_change history",
      ok: start !== null && lastOff === undefined,
      detail:
        start === null
          ? `no mode history before ${iso(since).slice(0, 10)}`
          : lastOff === undefined
            ? "observe or act for the whole window"
            : offUntil === null
              ? `recheck_on_change is ${lastOff.guards.recheck_on_change}`
              : `recheck_on_change was ${lastOff.guards.recheck_on_change} until ${iso(offUntil).slice(0, 10)}`,
    },
  ];
  return { part: "planner.mode", mode: partMode(input.history.at(-1), "planner.mode"), verdict: verdictOf(criteria), criteria, failed: [], undone: [] };
}

/** The change after `at` that added the task's line: the owner's outside edit, or an applied proposal. */
function addedLater(changes: ChangeView[], task: string, at: number, doneMarker: string): boolean {
  return changes.some(
    (c) =>
      Date.parse(c.at) > at &&
      c.outcome === "applied" &&
      ((c.source === "proposal" && c.op === "add" && c.task === task) ||
        (c.source === "external" && c.diff.some((row) => row.startsWith("+") && lineOf(body(row), doneMarker)?.task === task))),
  );
}

/** The agent of the first assignment of the task after `at` (an outside edit or an applied proposal), or null. */
function nextAgent(changes: ChangeView[], task: string, at: number, doneMarker: string): string | null {
  for (const c of changes) {
    if (Date.parse(c.at) <= at || c.outcome !== "applied") continue;
    if (c.source === "proposal" && (c.op === "add" || c.op === "reassign" || c.op === "assign") && c.task === task && c.agent) return c.agent;
    if (c.source !== "external") continue;
    for (const row of c.diff) {
      const line = row.startsWith("+") ? lineOf(body(row), doneMarker) : null;
      if (line?.task === task && line.agent !== "") return line.agent;
    }
  }
  return null;
}

/** A task closed by `at`: a done change for it at or before then. */
const closedBy = (changes: ChangeView[], task: string, at: number) =>
  changes.some((c) => c.op === "mark_done" && c.outcome === "applied" && c.task === task && Date.parse(c.at) <= at);

function backlogRow(input: ReadinessInput, mode: string): ReadinessRowView {
  const records = input.would.filter((r) => r.kind === "would_add");
  const tasks = [...new Set(records.map((r) => r.task))];
  const added = tasks.filter((task) => addedLater(input.changes, task, Math.min(...records.filter((r) => r.task === task).map((r) => r.at)), input.doneMarker));
  const bad = [...new Set(records.filter((r) => DEFAULT_SKIP_PATTERN.test(r.planText) || closedBy(input.changes, r.task, r.at)).map((r) => r.task))];
  const criteria: ReadinessCriterionView[] = [
    { id: "samples", label: "would_add samples", ok: records.length >= input.minSamples, detail: `${records.length} would_add records; ${input.minSamples} needed` },
    {
      id: "agreement",
      label: "later added",
      ok: tasks.length > 0 && added.length / tasks.length >= input.minAgreement,
      detail: `${added.length} of ${tasks.length} task ids were later added by the owner or approved; ${input.minAgreement} needed`,
    },
    { id: "no_skipped", label: "none for a closed or skipped task", ok: bad.length === 0, detail: bad.length === 0 ? "none" : `${bad.length} for a closed or skipped task` },
  ];
  return { part: "backlog.mode", mode, verdict: verdictOf(criteria), criteria, failed: bad.slice(0, MAX_LISTED), undone: [] };
}

function assignRow(input: ReadinessInput, mode: string): ReadinessRowView {
  const records = input.would.filter((r) => r.kind === "would_assign");
  let matched = 0;
  let counted = 0;
  const failed: string[] = [];
  for (const r of records) {
    const next = nextAgent(input.changes, r.task, r.at, input.doneMarker);
    if (next === null) continue;
    counted += 1;
    if (next === r.agent) matched += 1;
    else failed.push(r.task);
  }
  const criteria: ReadinessCriterionView[] = [
    { id: "samples", label: "would_assign samples", ok: records.length >= input.minSamples, detail: `${records.length} would_assign records; ${input.minSamples} needed` },
    {
      id: "agreement",
      label: "matched the next assignment",
      ok: counted > 0 && matched / counted >= input.minAgreement,
      detail: `${matched} of ${counted} matched the assignment that came next (${records.length - counted} had none); ${input.minAgreement} needed`,
    },
  ];
  return { part: "backlog.assign", mode, verdict: verdictOf(criteria), criteria, failed: failed.slice(0, MAX_LISTED), undone: [] };
}

function specRow(input: ReadinessInput, mode: string): ReadinessRowView {
  const records = input.would.filter((r) => r.kind === "would_spec");
  const needed = Math.min(5, input.minSamples);
  const bad = [...new Set(records.filter((r) => r.specLink !== null).map((r) => r.task))];
  const criteria: ReadinessCriterionView[] = [
    { id: "samples", label: "would_spec samples", ok: records.length >= needed, detail: `${records.length} would_spec records; ${needed} needed` },
    {
      id: "no_false_positive",
      label: "none for a task with a merged spec link",
      ok: bad.length === 0,
      detail: bad.length === 0 ? "none" : `${bad.length} for a task whose spec had already merged`,
    },
  ];
  return { part: "spec_first.mode", mode, verdict: verdictOf(criteria), criteria, failed: bad.slice(0, MAX_LISTED), undone: [] };
}

/**
 * After the switch to act: the changes the planner applied since then that the owner undid, or that an outside edit
 * removed or changed (its diff takes out the line the change wrote), within 24 hours.
 */
function undoneSince(changes: ChangeView[], from: number): ReadinessRowView["undone"] {
  const out: ReadinessRowView["undone"] = [];
  const byId = new Map(changes.map((c) => [c.id, c]));
  for (const c of changes) {
    const at = Date.parse(c.at);
    if (at < from || c.source !== "proposal" || c.outcome !== "applied") continue;
    const until = at + DAY_MS;
    const undo = c.undoneBy ? byId.get(c.undoneBy) : undefined;
    if (undo && Date.parse(undo.at) <= until) {
      out.push({ change: c.id, op: c.op, task: c.task, at: c.at, how: "undone" });
      continue;
    }
    const wrote = c.diff.find((row) => row.startsWith("+"));
    if (!wrote) continue;
    const edited = changes.some(
      (e) =>
        e.source === "external" &&
        Date.parse(e.at) > at &&
        Date.parse(e.at) <= until &&
        e.diff.some((row) => row.startsWith("-") && body(row) === body(wrote)),
    );
    if (edited) out.push({ change: c.id, op: c.op, task: c.task, at: c.at, how: "edited back" });
  }
  return out.slice(0, MAX_LISTED);
}

/** The report. Pure: the caller reads the stores. */
export function readinessReport(all: ReadinessInput): PlannerReadinessView {
  const since = all.now - all.days * DAY_MS;
  const input = { ...all, would: all.would.filter((r) => r.at >= since) };
  const newest = input.history.at(-1);
  const rows = [
    plannerRow(input, since),
    backlogRow(input, partMode(newest, "backlog.mode")),
    assignRow(input, partMode(newest, "backlog.assign")),
    specRow(input, partMode(newest, "spec_first.mode")),
  ].map((row): ReadinessRowView => {
    const from = switchedAt(input.history, row.part);
    if (from === null) return row;
    const undone = undoneSince(input.changes, from);
    return undone.length > 0 ? { ...row, verdict: "switch_back", undone } : row;
  });
  return { at: iso(input.now), since: iso(since), days: input.days, minSamples: input.minSamples, minAgreement: input.minAgreement, rows };
}
