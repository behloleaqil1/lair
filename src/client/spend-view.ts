/**
 * Home's AI spend panel and an agent's Spend line (docs/design/ai-spend.md §4.4), kept apart from the components so
 * tests check the same rules. Everything here reads GET /api/agents/spend (SpendReportView): numbers, ids and enums.
 *
 * - The bars: one per unit with data (cost, tokens, requests, model turns, agent-minutes, runs), split into
 *   productive, idle and no result (and "not classified yet" while a run's module hasn't recorded its result). Cost
 *   and tokens only where an adapter reported them: otherwise "not reported", never an estimate.
 * - The waste share in the report's unit, the top waste reasons and the tasks with the most attempts without a
 *   completion, the table by project, agent, origin or task, reloads and Lair-restart losses, and one line per guard.
 */
import type {
  SpendClass,
  SpendGroupBy,
  SpendGroupView,
  SpendGuardId,
  SpendGuardView,
  SpendReportView,
  SpendTotalsView,
  SpendUnit,
  SpendWindow,
} from "../shared/agents-types";

/** The panel's windows: the UTC day so far, and the last 7 days */
export type SpendPanelWindow = Extract<SpendWindow, "today" | "7d">;
export const SPEND_PANEL_WINDOWS: readonly { id: SpendPanelWindow; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
];

/** The table's groupings */
export type SpendTableBy = Extract<SpendGroupBy, "project" | "agent" | "origin" | "task">;
export const SPEND_TABLE_GROUPS: readonly { id: SpendTableBy; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "task", label: "Task" },
  { id: "origin", label: "Started by" },
  { id: "project", label: "Project" },
];

/** The endpoint the panel reads (owner only) */
export const spendEndpoint = (range: SpendPanelWindow, by: SpendGroupBy): string => `/agents/spend?window=${range}&by=${by}`;

export const NOT_REPORTED = "not reported";

/** What a window is called in a sentence */
export const WINDOW_PHRASE: Record<SpendPanelWindow, string> = { today: "today (UTC)", "7d": "in the last 7 days" };

// ============ UNITS AND NUMBERS ============

type BarUnit = SpendUnit | "tokens" | "turns";
const BAR_UNITS: readonly BarUnit[] = ["cost", "tokens", "requests", "turns", "minutes", "runs"];

const UNIT_LABEL: Record<BarUnit, string> = {
  cost: "Cost",
  tokens: "Tokens",
  requests: "Model requests",
  turns: "Model turns",
  minutes: "Agent time",
  runs: "Runs",
};

/** The unit as the waste share's sentence names it ("42% of the cost") */
const UNIT_PHRASE: Record<SpendUnit, string> = { cost: "the cost", requests: "the model requests", minutes: "the agent time", runs: "the runs" };

/** A totals' value in a unit; null when the unit has nothing (cost and tokens not reported, no request counts) */
export function valueIn(t: SpendTotalsView, unit: BarUnit): number | null {
  switch (unit) {
    case "cost":
      return t.reported ? t.cost : null;
    case "tokens":
      return t.reported ? t.tokens : null;
    case "requests":
      return t.requests;
    case "turns":
      return t.turns;
    case "minutes":
      return t.minutes;
    case "runs":
      return t.runs;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function formatCost(n: number): string {
  if (n > 0 && n < 0.01) return "under $0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Math.round(n).toLocaleString("en-US");
}

export function formatMinutes(n: number): string {
  if (n < 60) return `${Math.round(n * 10) / 10} min`;
  return `${(n / 60).toFixed(1)} h`;
}

export const formatShare = (share: number): string => `${Math.round(share * 100)}%`;

/** A value in its unit, in words */
export function formatIn(unit: BarUnit, n: number): string {
  switch (unit) {
    case "cost":
      return formatCost(n);
    case "tokens":
      return `${formatCount(n)} tokens`;
    case "requests":
      return n === 1 ? "1 request" : `${formatCount(n)} requests`;
    case "turns":
      return n === 1 ? "1 turn" : `${formatCount(n)} turns`;
    case "minutes":
      return formatMinutes(n);
    case "runs":
      return plural(n, "run");
  }
}

// ============ BARS ============

export type SpendSegmentClass = "productive" | "idle" | "noResult" | "unclassified";

export const CLASS_LABEL: Record<SpendSegmentClass, string> = {
  productive: "Productive",
  idle: "Idle",
  noResult: "No result",
  unclassified: "Not classified yet",
};

/** What each class means, for the legend */
export const CLASS_HINT: Record<SpendSegmentClass, string> = {
  productive: "moved the work on: a done or ready line, a queued gate, a new blocker, a review, proposals, an answer",
  idle: "ran to the end and changed nothing: the same wait or blocker again, no queue line, no review",
  noResult: "failed, hung, hit a limit or was stopped",
  unclassified: "its module hasn't recorded the run's result yet",
};

export interface SpendSegment {
  class: SpendSegmentClass;
  value: number;
  /** Of the bar's total, 0 to 1 */
  share: number;
  text: string;
}

export interface SpendBar {
  unit: BarUnit;
  label: string;
  /** "not reported" in place of the bar: no run's adapter reported this unit */
  notReported: boolean;
  total: number;
  totalText: string;
  segments: SpendSegment[];
}

const SEGMENTS: readonly SpendSegmentClass[] = ["productive", "idle", "noResult", "unclassified"];

/**
 * One bar per unit with data. Cost and tokens with no reported run say "not reported" instead; a unit nothing
 * counted (no request lines, no turns) is left out. Not-classified-yet runs are a segment only when there are some.
 */
export function spendBars(report: SpendReportView): SpendBar[] {
  const bars: SpendBar[] = [];
  for (const unit of BAR_UNITS) {
    const total = valueIn(report.totals, unit);
    if (unit === "cost" || unit === "tokens") {
      if (!report.totals.reported || total === null) {
        if (report.totals.runs > 0) bars.push({ unit, label: UNIT_LABEL[unit], notReported: true, total: 0, totalText: NOT_REPORTED, segments: [] });
        continue;
      }
    } else if (total === null || (total === 0 && unit !== "runs")) continue;
    const segments = SEGMENTS.map((cls) => {
      const value = valueIn(report[cls], unit) ?? 0;
      return { class: cls, value, share: total && total > 0 ? value / total : 0, text: formatIn(unit, value) };
    }).filter((s) => s.class !== "unclassified" || s.value > 0);
    bars.push({ unit, label: UNIT_LABEL[unit], notReported: false, total: total ?? 0, totalText: formatIn(unit, total ?? 0), segments });
  }
  return bars;
}

/** "42% of the model requests went to idle runs or runs with no result", or null when nothing was classified */
export function wasteSentence(report: SpendReportView): string | null {
  if (report.wasteShare === null) return null;
  return `${formatShare(report.wasteShare)} of ${UNIT_PHRASE[report.unit]} went to idle runs or runs with no result`;
}

// ============ REASONS AND TASKS ============

/** Each class reason in plain words (docs/design/ai-spend.md §4.2); an unknown one shows as its id */
export const REASON_LABEL: Record<string, string> = {
  done: "finished the task",
  ready: "marked its work ready",
  blocked: "reported a new blocker",
  gate_queued: "queued a gate",
  review_recorded: "recorded a review",
  proposals: "wrote planner proposals",
  verdicts: "checked the planner's proposals",
  answered: "answered",
  waiting_same: "waited again on the same thing",
  waiting_unnamed: "waited on nothing Lair can watch",
  blocked_repeat: "reported the same blocker again",
  no_line: "wrote no queue line",
  no_review: "review run with no review",
  no_proposals: "planner run with no proposals",
  no_verdicts: "check of proposals with no verdict",
  no_answer: "supervisor run with no answer",
  hung: "hung",
  crashed: "crashed",
  dead_on_start: "died as it started",
  never_started: "never started",
  rate_limit: "hit a rate limit or quota",
  provider_error: "provider error",
  unreachable: "provider unreachable",
  exit_unknown: "ended while Lair was restarting",
  lost: "lost in a Lair restart",
  vars_lost: "lost its run details in a Lair restart",
  lost_claim: "lost its task to another run",
  stopped: "stopped",
  pending: "waiting for its module's result",
  not_recorded: "no result recorded",
};

export const reasonLabel = (reason: string): string => REASON_LABEL[reason] ?? reason.replace(/_/g, " ");

const CLASS_OF: Record<SpendClass, SpendSegmentClass> = { productive: "productive", idle: "idle", no_result: "noResult", unclassified: "unclassified" };

export interface WasteReasonRow {
  key: string;
  class: SpendSegmentClass;
  label: string;
  runs: number;
  /** In the report's unit (runs only, when the unit is runs) */
  amount: string;
}

/** The idle and no-result reasons that cost the most in the report's unit, then by runs; at most `n` */
export function topWasteReasons(report: SpendReportView, n = 5): WasteReasonRow[] {
  const unit = report.unit;
  return report.reasons
    .filter((r) => r.class === "idle" || r.class === "no_result")
    .map((r) => ({ r, value: valueIn(r.totals, unit) ?? 0 }))
    .sort((a, b) => b.value - a.value || b.r.totals.runs - a.r.totals.runs || a.r.reason.localeCompare(b.r.reason))
    .slice(0, n)
    .map(({ r, value }) => ({
      key: `${r.class}/${r.reason}`,
      class: CLASS_OF[r.class],
      label: reasonLabel(r.reason),
      runs: r.totals.runs,
      amount: unit === "runs" ? "" : formatIn(unit, value),
    }));
}

export interface TaskAttemptRow {
  task: string;
  text: string;
}

/** The tasks with the most attempts since their last completion; at most `n` (none past the per-run records) */
export function topTaskRows(report: SpendReportView, n = 5): TaskAttemptRow[] {
  return (report.topTasks ?? []).slice(0, n).map((t) => ({
    task: t.task,
    text: `${plural(t.attempts, "attempt")} without a completion: ${t.noResult} with no result, in ${plural(t.chains, "chain")}`,
  }));
}

// ============ THE TABLE ============

const ORIGIN_LABEL: Record<string, string> = {
  fill: "Fill (the tasks file)",
  review: "Reviews",
  planner: "Planner",
  verifier: "Planner's check",
  supervisor: "Supervisor",
  owner: "You (Start a run)",
  other: "Other",
};

export interface SpendGroupRow {
  key: string;
  /** The group's name as shown: an agent or task id, a project, or an origin in words */
  name: string;
  /** Agent and task ids are shown as code */
  code: boolean;
  runs: number;
  productive: number;
  idle: number;
  noResult: number;
  /**
   * In the report's unit; in the next unit the group has when it has none of that one (a group whose adapters report
   * no cost: "100% of requests"); "—" when nothing of it was classified
   */
  waste: string;
  requests: string;
  minutes: string;
  tokens: string;
  cost: string;
  reported: boolean;
}

const UNIT_SHORT: Record<SpendUnit, string> = { cost: "cost", requests: "requests", minutes: "time", runs: "runs" };

function groupWaste(group: SpendGroupView, unit: SpendUnit): string {
  for (const u of [unit, "requests", "minutes", "runs"] as const) {
    const share = group.waste[u];
    if (share !== null) return u === unit ? formatShare(share) : `${formatShare(share)} of ${UNIT_SHORT[u]}`;
  }
  return "—";
}

export function groupRow(group: SpendGroupView, report: Pick<SpendReportView, "by" | "unit">): SpendGroupRow {
  const t = group.totals;
  return {
    key: group.key,
    name: report.by === "origin" ? (ORIGIN_LABEL[group.key] ?? group.key) : group.key,
    code: report.by === "agent" || report.by === "task",
    runs: t.runs,
    productive: group.productive.runs,
    idle: group.idle.runs,
    noResult: group.noResult.runs,
    waste: groupWaste(group, report.unit),
    requests: t.requests === null ? "—" : formatCount(t.requests),
    minutes: formatMinutes(t.minutes),
    tokens: t.reported && t.tokens !== null ? formatCount(t.tokens) : NOT_REPORTED,
    cost: t.reported && t.cost !== null ? formatCost(t.cost) : NOT_REPORTED,
    reported: t.reported,
  };
}

export const groupRows = (report: SpendReportView): SpendGroupRow[] => report.groups.map((g) => groupRow(g, report));

/** Reloads and Lair-restart losses, in words */
export function lossesSentence(report: Pick<SpendReportView, "reloads" | "lairRestarts">): string {
  return `${plural(report.reloads, "context reload")} (a restart that re-sent a failed run's context) · ${plural(report.lairRestarts, "run")} ended by a Lair restart`;
}

// ============ GUARDS ============

/** Each guard: what it is in words, and what one verdict does */
const GUARD_TEXT: Record<SpendGuardId, { name: string; one: string; many: (n: number) => string }> = {
  quota: { name: "Provider quota cooldown", one: "cooled a provider once", many: (n) => `cooled a provider ${n} times` },
  task_no_result_cap: { name: "Park a task after repeated failures", one: "parked a task once", many: (n) => `parked tasks ${n} times` },
  wake_events: { name: "Wake waiting agents on their event", one: "started a waiting agent on its event once", many: (n) => `started waiting agents on their events ${n} times` },
  hung_repeat: { name: "Park a task that hangs again", one: "parked a task once", many: (n) => `parked tasks ${n} times` },
  budget: { name: "Request and time budgets", one: "held new runs once", many: (n) => `held new runs ${n} times` },
  planner_prefilter_closed: { name: "Planner: leave out finished work", one: "left out finished work once", many: (n) => `left out finished work ${n} times` },
  planner_handled_messages: { name: "Planner: mark carried-out requests", one: "marked a request carried out once", many: (n) => `marked requests carried out ${n} times` },
  planner_skip_unchanged: { name: "Planner: skip a run when nothing changed", one: "skipped a planner run once", many: (n) => `skipped planner runs ${n} times` },
  planner_recheck_on_change: { name: "Planner: keep what still holds after a tasks-file edit", one: "kept a run's valid proposals once", many: (n) => `kept runs' valid proposals ${n} times` },
};

export const MODE_LABEL: Record<SpendGuardView["mode"], string> = { off: "off", observe: "watching", act: "on" };
export const MODE_TONE: Record<SpendGuardView["mode"], "neutral" | "info" | "success"> = { off: "neutral", observe: "info", act: "success" };

export interface GuardLine {
  guard: SpendGuardId;
  name: string;
  /** Its config key, for the tooltip */
  key: string;
  mode: SpendGuardView["mode"];
  modeLabel: string;
  text: string;
  would: number;
  did: number;
}

/** A guard the panel doesn't know yet (a newer server) still gets its line */
const unknownGuard = (guard: string) => ({ name: guard.replace(/_/g, " "), one: "acted once", many: (n: number) => `acted ${n} times` });

/** One line per guard: its mode, and what it would have done (watching) or did (on) in the window */
export function guardLines(guards: readonly SpendGuardView[], range: SpendPanelWindow): GuardLine[] {
  const when = WINDOW_PHRASE[range];
  return guards.map((g) => {
    const words = GUARD_TEXT[g.guard] ?? unknownGuard(g.guard);
    const times = (n: number) => (n === 1 ? words.one : words.many(n));
    let text: string;
    if (g.mode === "observe") {
      text = g.would > 0 ? `Would have ${times(g.would)} ${when}; it changed nothing` : `Nothing it would have done ${when}`;
      if (g.did > 0) text += ` (it ${times(g.did)} while it was on)`;
    } else if (g.mode === "act") {
      text = g.did > 0 ? `It ${times(g.did)} ${when}` : `Nothing to do ${when}`;
      if (g.would > 0) text += ` (and would have ${times(g.would)} while it was watching)`;
    } else {
      text = g.did + g.would > 0 ? `Off (before that, ${times(g.did + g.would)} ${when} while it was watching or on)` : "Off";
    }
    return { guard: g.guard, name: words.name, key: g.key, mode: g.mode, modeLabel: MODE_LABEL[g.mode], text, would: g.would, did: g.did };
  });
}

// ============ AN AGENT'S SPEND LINE ============

/**
 * An agent's line in its detail (today's report, by agent): its runs per class, then its cost, else its requests,
 * else its time, saying when tokens and cost are not reported.
 */
export function agentSpendLine(report: SpendReportView, agent: string): string {
  const group = report.groups.find((g) => g.key === agent);
  if (!group || group.totals.runs === 0) return "No runs ended today (UTC).";
  const parts = [`${group.productive.runs} productive`, `${group.idle.runs} idle`, `${group.noResult.runs} with no result`];
  if (group.unclassified.runs > 0) parts.push(`${group.unclassified.runs} not classified yet`);
  const t = group.totals;
  const amount =
    t.reported && t.cost !== null
      ? `cost ${formatCost(t.cost)}`
      : t.requests !== null
        ? `${formatIn("requests", t.requests)}, ${formatMinutes(t.minutes)} (tokens and cost ${NOT_REPORTED})`
        : `${formatMinutes(t.minutes)} (tokens and cost ${NOT_REPORTED})`;
  return `Today (UTC): ${plural(t.runs, "run")}: ${parts.join(", ")} · ${amount}`;
}
