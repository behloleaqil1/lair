/**
 * AI spend, part 2: what the spend API, the daily summary and the notices show (docs/design/ai-spend.md §4.4). SQL
 * sums over indexed columns, bounded by the window; numbers, ids and enums only (never a prompt, a log line or a
 * blocker's text). A window past the per-run rows' retention reads the daily aggregates (and the runs of days not
 * aggregated yet), so it has no per-task detail.
 */
import type {
  SpendGroupBy,
  SpendGroupView,
  SpendGuardId,
  SpendGuardView,
  SpendPlannerView,
  SpendReportView,
  SpendTotalsView,
  SpendUnit,
  SpendWasteShare,
  SpendWindow,
} from "../../shared/agents-types.js";
import type { SpendFacts } from "./spend-classify.js";
import type { AgentsStore, SpendCell } from "./store.js";

export const DAY_MS = 86_400_000;
/** Groups in a report, the most waste first */
const MAX_GROUPS = 200;
const MAX_REVIEW_HEADS = 20;
const TOP_TASKS = 10;

/** The UTC day of a time, "YYYY-MM-DD" */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** 00:00 UTC of a time's day */
export const dayStart = (ms: number): number => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);

const WINDOW_DAYS: Record<Exclude<SpendWindow, "today">, number> = { "7d": 7, "30d": 30, "1y": 365 };

/** A window's start: "today" is the UTC day, the others count back from `now`. */
export function windowStart(window: SpendWindow, now: number): number {
  return window === "today" ? dayStart(now) : now - WINDOW_DAYS[window] * DAY_MS;
}

/** Each guard and the config key of its mode (docs/design/ai-spend.md §4.5, §4.6) */
export const GUARD_KEYS: Record<SpendGuardId, { path: string[]; root: "agents" | "planner"; fallback: "off" | "observe" }> = {
  quota: { root: "agents", path: ["failover", "quota", "mode"], fallback: "off" },
  task_no_result_cap: { root: "agents", path: ["spend", "guards", "task_no_result_cap", "mode"], fallback: "off" },
  wake_events: { root: "agents", path: ["fill", "wake", "events", "mode"], fallback: "off" },
  hung_repeat: { root: "agents", path: ["recovery", "hung_repeat", "mode"], fallback: "off" },
  budget: { root: "agents", path: ["budgets", "guard_mode"], fallback: "observe" },
  planner_prefilter_closed: { root: "planner", path: ["guards", "prefilter_closed"], fallback: "off" },
  planner_handled_messages: { root: "planner", path: ["guards", "handled_messages"], fallback: "off" },
  planner_skip_unchanged: { root: "planner", path: ["guards", "skip_unchanged", "mode"], fallback: "off" },
  planner_recheck_on_change: { root: "planner", path: ["guards", "recheck_on_change"], fallback: "off" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Each guard's mode as the project's config sets it (the default where it doesn't). */
export function guardModes(config: { agents?: unknown; planner?: unknown }): Record<SpendGuardId, SpendGuardView["mode"]> {
  const modes = {} as Record<SpendGuardId, SpendGuardView["mode"]>;
  for (const [guard, { root, path, fallback }] of Object.entries(GUARD_KEYS) as [SpendGuardId, (typeof GUARD_KEYS)[SpendGuardId]][]) {
    let value: unknown = config[root];
    for (const key of path) value = isObject(value) ? value[key] : undefined;
    modes[guard] = value === "off" || value === "observe" || value === "act" ? value : fallback;
  }
  return modes;
}

// ============ SUMS ============

interface Acc {
  runs: number;
  minutes: number;
  requests: number | null;
  turns: number | null;
  tokens: number | null;
  cost: number | null;
  reportedRuns: number;
}

const empty = (): Acc => ({ runs: 0, minutes: 0, requests: null, turns: null, tokens: null, cost: null, reportedRuns: 0 });
const plus = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

function add(acc: Acc, cell: SpendCell): void {
  acc.runs += cell.runs;
  acc.minutes += cell.minutes ?? 0;
  acc.requests = plus(acc.requests, cell.requests);
  acc.turns = plus(acc.turns, cell.turns);
  acc.tokens = plus(acc.tokens, cell.tokens);
  acc.cost = plus(acc.cost, cell.cost);
  acc.reportedRuns += cell.reportedRuns ?? 0;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function totalsOf(acc: Acc): SpendTotalsView {
  const reported = acc.reportedRuns > 0;
  return {
    runs: acc.runs,
    minutes: round(acc.minutes, 1),
    requests: acc.requests,
    turns: acc.turns,
    tokens: reported ? acc.tokens : null,
    cost: reported && acc.cost !== null ? round(acc.cost, 6) : null,
    reported,
    reportedRuns: acc.reportedRuns,
  };
}

interface ClassAccs {
  productive: Acc;
  idle: Acc;
  noResult: Acc;
  unclassified: Acc;
  reloads: number;
  lairRestarts: number;
}

const classAccs = (): ClassAccs => ({ productive: empty(), idle: empty(), noResult: empty(), unclassified: empty(), reloads: 0, lairRestarts: 0 });

function addClass(accs: ClassAccs, cell: SpendCell): void {
  const target = cell.class === "productive" ? accs.productive : cell.class === "idle" ? accs.idle : cell.class === "no_result" ? accs.noResult : accs.unclassified;
  add(target, cell);
  accs.reloads += cell.reloads ?? 0;
  accs.lairRestarts += cell.lairRestarts ?? 0;
}

const UNITS = ["cost", "tokens", "requests", "turns", "minutes", "runs"] as const;

/** (idle + no_result) / (productive + idle + no_result) in each unit; null where the unit has nothing */
function wasteOf(accs: ClassAccs): SpendWasteShare {
  const share = {} as SpendWasteShare;
  for (const unit of UNITS) {
    const value = (acc: Acc) => (unit === "runs" ? acc.runs : unit === "minutes" ? acc.minutes : (acc[unit] ?? 0));
    const waste = value(accs.idle) + value(accs.noResult);
    const all = waste + value(accs.productive);
    share[unit] = all > 0 ? round(waste / all, 4) : null;
  }
  return share;
}

/** The panel's unit: cost when any was reported, then requests, then minutes, then runs. */
function unitOf(accs: ClassAccs): SpendUnit {
  const sum = (pick: (a: Acc) => number | null) =>
    [accs.productive, accs.idle, accs.noResult].reduce((n, a) => n + (pick(a) ?? 0), 0);
  if (sum((a) => (a.reportedRuns > 0 ? a.cost : null)) > 0) return "cost";
  if (sum((a) => a.requests) > 0) return "requests";
  if (sum((a) => a.minutes) > 0) return "minutes";
  return "runs";
}

const wasteIn = (accs: ClassAccs, unit: SpendUnit): number => {
  const value = (acc: Acc) => (unit === "runs" ? acc.runs : unit === "minutes" ? acc.minutes : (acc[unit] ?? 0));
  return value(accs.idle) + value(accs.noResult);
};

const all = (accs: ClassAccs): Acc => {
  const total = empty();
  for (const acc of [accs.productive, accs.idle, accs.noResult, accs.unclassified]) {
    total.runs += acc.runs;
    total.minutes += acc.minutes;
    total.requests = plus(total.requests, acc.requests);
    total.turns = plus(total.turns, acc.turns);
    total.tokens = plus(total.tokens, acc.tokens);
    total.cost = plus(total.cost, acc.cost);
    total.reportedRuns += acc.reportedRuns;
  }
  return total;
};

export interface ReportInput {
  store: AgentsStore;
  project: string;
  window: SpendWindow;
  by: SpendGroupBy;
  now: number;
  /** Per-run rows are kept this many days: a longer window reads the daily aggregates */
  retentionDays: number;
  facts?: SpendFacts;
  modes: Record<SpendGuardId, SpendGuardView["mode"]>;
}

export class SpendReportError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The spend of one window ([from, to)), as GET /api/agents/spend gives it. */
export function spendReport(input: ReportInput): SpendReportView {
  const from = windowStart(input.window, input.now);
  return spendReportBetween({ ...input, from, to: input.now + 1 });
}

/** The same for any [from, to): the daily summary uses it for the day that ended. */
export function spendReportBetween(input: ReportInput & { from: number; to: number }): SpendReportView {
  const { store, project, by, from, to } = input;
  const long = to - from > input.retentionDays * DAY_MS;
  if (long && by === "task") {
    throw new SpendReportError(`a window past ${input.retentionDays} days comes from the daily aggregates, which have no per-task detail: use by=project, agent, reason, origin or provider`);
  }
  // A long window: the daily aggregates of the days before retention's cutoff, and every run from the cutoff on (a
  // row that came after its day's summary counts at once), plus a run before it whose day has no aggregate yet
  const cutoff = Math.min(Math.max(dayStart(input.now - input.retentionDays * DAY_MS), dayStart(from)), to);
  const cellsBy = (group: SpendGroupBy): SpendCell[] =>
    long
      ? [
          ...store.spendDailyCells(project, utcDay(from), utcDay(cutoff), group as Exclude<SpendGroupBy, "task">),
          ...store.spendCells(project, from, to, group, cutoff),
        ]
      : store.spendCells(project, from, to, group);
  const cells = cellsBy(by);

  const overall = classAccs();
  const groups = new Map<string, ClassAccs>();
  const reasons = new Map<string, { class: string; reason: string; acc: Acc }>();
  for (const cell of cells) {
    addClass(overall, cell);
    const key = by === "project" ? project : String(cell.g);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = classAccs()));
    addClass(group, cell);
    const reasonKey = `${cell.class}/${cell.reason}`;
    let reason = reasons.get(reasonKey);
    if (!reason) reasons.set(reasonKey, (reason = { class: cell.class, reason: cell.reason, acc: empty() }));
    add(reason.acc, cell);
  }
  const unit = unitOf(overall);
  const waste = wasteOf(overall);
  const groupViews: SpendGroupView[] = [...groups.entries()]
    .sort((a, b) => wasteIn(b[1], unit) - wasteIn(a[1], unit) || all(b[1]).runs - all(a[1]).runs || a[0].localeCompare(b[0]))
    .slice(0, MAX_GROUPS)
    .map(([key, accs]) => ({
      key,
      totals: totalsOf(all(accs)),
      productive: totalsOf(accs.productive),
      idle: totalsOf(accs.idle),
      noResult: totalsOf(accs.noResult),
      unclassified: totalsOf(accs.unclassified),
      waste: wasteOf(accs),
      reloads: accs.reloads,
      lairRestarts: accs.lairRestarts,
    }));

  const counts = store.guardCounts(project, from, to);
  const guards: SpendGuardView[] = (Object.keys(GUARD_KEYS) as SpendGuardId[]).map((guard) => ({
    guard,
    key: `${GUARD_KEYS[guard].root}.${GUARD_KEYS[guard].path.join(".")}`,
    mode: input.modes[guard],
    would: counts.filter((c) => c.kind === "guard_would" && c.guard === guard).reduce((n, c) => n + c.n, 0),
    did: counts.filter((c) => c.kind === "guard_did" && c.guard === guard).reduce((n, c) => n + c.n, 0),
  }));

  return {
    project,
    window: input.window,
    by,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    source: long ? "aggregates" : "runs",
    unit,
    totals: totalsOf(all(overall)),
    productive: totalsOf(overall.productive),
    idle: totalsOf(overall.idle),
    noResult: totalsOf(overall.noResult),
    unclassified: totalsOf(overall.unclassified),
    waste,
    wasteShare: waste[unit],
    groups: groupViews,
    reasons: [...reasons.values()]
      .sort((a, b) => b.acc.runs - a.acc.runs || a.reason.localeCompare(b.reason))
      .map((r) => ({ class: r.class as SpendReportView["reasons"][number]["class"], reason: r.reason, totals: totalsOf(r.acc) })),
    reloads: overall.reloads,
    lairRestarts: overall.lairRestarts,
    topTasks: long
      ? null
      : store.spendTaskStreaks(project, from, to, 1, TOP_TASKS).map((t) => ({
          task: t.task,
          attempts: t.attempts,
          noResult: t.noResult,
          chains: t.chains,
          lastEndedAt: new Date(t.lastEndedAt).toISOString(),
        })),
    reviewsPerHead: long ? null : store.spendReviewHeads(project, from, to, MAX_REVIEW_HEADS),
    planner: plannerView(input, from, to, () => cellsBy("origin")),
    guards,
  };
}

/** Planner acceptance: proposals by status and verdict, runs with an applied proposal, cost per applied proposal. */
function plannerView(input: ReportInput, from: number, to: number, byOrigin: () => SpendCell[]): SpendPlannerView | null {
  const acceptance = input.facts?.plannerAcceptance?.(input.project, from, to) ?? null;
  if (!acceptance) return null;
  const cells = byOrigin().filter((c) => c.g === "planner" || c.g === "verifier");
  const reported = cells.some((c) => c.reportedRuns > 0);
  const cost = cells.reduce<number | null>((n, c) => plus(n, c.cost), null);
  const applied = acceptance.proposals.applied;
  return {
    ...acceptance,
    costPerApplied: reported && cost !== null && applied > 0 ? round(cost / applied, 6) : null,
    wasteShare: acceptance.runs > 0 ? round((acceptance.runs - acceptance.runsWithApplied) / acceptance.runs, 4) : null,
  };
}
