/**
 * Per-agent and per-project budgets, per UTC day and month.
 *
 * Token and cost limits count the agents ledger, which the fleet budget
 * (src/server/fleet/budget.ts) feeds: every cost recorded there with a
 * project (and agent) attribution lands in it, including the usage the
 * agents module reads from run logs, which it records through the fleet
 * budget too. Request and minute limits (AI spend G5,
 * docs/design/ai-spend.md §4.5) count the spend records of ended runs: the
 * model requests an adapter's log shows and the runs' agent-minutes, for
 * adapters that report no tokens. A soft limit warns; a hard limit stops
 * new runs for that scope and raises a `spend` decision. A request or minute
 * hard limit does that only with budgets.guard_mode `act`: `observe` records
 * what it would hold, `off` nothing.
 */
import type { BudgetLine, BudgetMetric, BudgetScopeView } from "../../shared/agents-types.js";
import type { CostAttribution, CostEvent } from "../fleet/budget.js";
import type { AgentsSettings, BudgetLimits, GuardMode } from "./config.js";
import type { SpendNotice } from "./spend.js";
import { DAY_MS, dayStart, utcDay } from "./spend-report.js";
import type { AgentsStore } from "./store.js";

export const BUDGET_METRICS: readonly BudgetMetric[] = [
  "daily_tokens",
  "daily_cost",
  "monthly_tokens",
  "monthly_cost",
  "daily_requests",
  "daily_minutes",
  "monthly_requests",
  "monthly_minutes",
];

/** What the agents module needs from the fleet budget (BudgetManager has it). */
export interface FleetBudget {
  recordCost(provider: string, cost: number, reason?: string, attribution?: CostAttribution): void;
  onCost(listener: (event: CostEvent) => void): () => void;
  isProviderAvailable(provider: string): boolean;
}

function isDaily(metric: BudgetMetric): boolean {
  return metric.startsWith("daily_");
}

/** A request or minute metric (G5): counted from the spend records, under budgets.guard_mode */
export function isSpendMetric(metric: BudgetMetric): boolean {
  return metric.endsWith("_requests") || metric.endsWith("_minutes");
}

/** Whether a line's hard limit holds new runs: always for tokens and cost; for requests and minutes only in act. */
export function holdsRuns(line: BudgetLine): boolean {
  return line.guard === undefined || line.guard === "act";
}

/** Start of the metric's UTC period containing `now`. */
export function periodStart(metric: BudgetMetric, now: number): number {
  const d = new Date(now);
  return isDaily(metric)
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** "2026-01-31" for daily metrics, "2026-01" for monthly ones. */
export function periodKey(metric: BudgetMetric, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return isDaily(metric) ? day : day.slice(0, 7);
}

/** An agent's limits: per_agent.<id> metrics over the agent default. */
export function agentLimits(settings: AgentsSettings, agent: string): BudgetLimits | undefined {
  const base = settings.budgets.agent;
  const own = settings.budgets.perAgent[agent];
  if (!base && !own) return undefined;
  return { ...base, ...own };
}

/** What the request and minute lines need: the guard's mode, and how long spend keeps its per-run records */
export interface SpendBudgetOptions {
  guardMode: GuardMode;
  /** agents.spend.retention_days: the days before it are read from the daily aggregates */
  retentionDays: number;
}

/**
 * Requests and agent-minutes of the runs that ended in a period, from the spend records. A period that reaches back
 * past retention's cutoff (a month with a short retention_days) reads the days before it from the daily aggregates.
 */
function spendUsed(store: AgentsStore, project: string, agent: string | null, since: number, now: number, retentionDays: number) {
  const cutoff = dayStart(now - retentionDays * DAY_MS);
  return cutoff > since
    ? store.spendUsageSince(project, agent, since, { before: cutoff, fromDay: utcDay(since), toDay: utcDay(cutoff) })
    : store.spendUsageSince(project, agent, since);
}

/** Evaluate one scope (the project when `agent` is null). */
export function evaluateBudget(
  store: AgentsStore,
  project: string,
  agent: string | null,
  limits: BudgetLimits | undefined,
  now: number,
  spend?: SpendBudgetOptions,
): BudgetScopeView | null {
  if (!limits) return null;
  const lines: BudgetLine[] = [];
  for (const metric of BUDGET_METRICS) {
    const limit = limits[metric];
    if (!limit || (limit.soft === undefined && limit.hard === undefined)) continue;
    const since = periodStart(metric, now);
    let used: number;
    if (isSpendMetric(metric)) {
      // Config load refuses these limits while spend is off, so without its options there is nothing to count
      if (!spend) continue;
      const spent = spendUsed(store, project, agent, since, now, spend.retentionDays);
      used = metric.endsWith("_requests") ? spent.requests : Math.round(spent.minutes * 10) / 10;
    } else {
      const ledger = store.usageSince(project, agent, since);
      used = metric.endsWith("_tokens") ? ledger.tokens : Math.round(ledger.cost * 1e6) / 1e6;
    }
    const level =
      limit.hard !== undefined && used >= limit.hard
        ? "hard"
        : limit.soft !== undefined && used >= limit.soft
          ? "soft"
          : "ok";
    const line: BudgetLine = { metric, period: periodKey(metric, now), used, soft: limit.soft, hard: limit.hard, level };
    if (isSpendMetric(metric) && spend) line.guard = spend.guardMode;
    lines.push(line);
  }
  return {
    scope: agent === null ? "project" : "agent",
    agent: agent ?? undefined,
    lines,
    blocked: lines.some((line) => line.level === "hard" && holdsRuns(line)),
  };
}

const UNITS: Record<string, string> = { cost: "cost", tokens: "tokens", requests: "requests", minutes: "agent-minutes" };

/** "agent worker-a used 9 cost in day 2026-01-31 (hard limit 8)" */
export function describeUsage(scope: BudgetScopeView, line: BudgetLine, which: "soft" | "hard"): string {
  const who = scope.scope === "project" ? "the project" : `agent ${scope.agent}`;
  const unit = UNITS[line.metric.slice(line.metric.indexOf("_") + 1)];
  const period = isDaily(line.metric) ? `day ${line.period}` : `month ${line.period}`;
  return `${who} used ${line.used} ${unit} in ${period} (${which} limit ${which === "hard" ? line.hard : line.soft})`;
}

/** When the metric's period ends: the next UTC day or month. */
export function periodEnd(metric: BudgetMetric, now: number): number {
  const d = new Date(periodStart(metric, now));
  return isDaily(metric)
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ============ NOTICES (G5) ============

/** A budget notice for the owner (attention: notice, class agents.spend_notice): titles and numbers only */
export type BudgetNotice = Omit<SpendNotice, "code"> & { code: "budget_soft" | "would_block" };

/** "project", or "agent:<id>" */
export const scopeKeyOf = (scope: BudgetScopeView): string => (scope.scope === "project" ? "project" : `agent:${scope.agent}`);

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * A soft limit reached, with AI spend on: one notice per scope, metric and period (key `budget_soft:...`), withdrawn
 * when the period ends (ref `budget_notice:<metric>:<period>:<scope>`).
 */
export function softNotice(scope: BudgetScopeView, line: BudgetLine): BudgetNotice {
  const scopeKey = scopeKeyOf(scope);
  const text = describeUsage(scope, line, "soft");
  return {
    key: `budget_soft:${scopeKey}:${line.metric}:${line.period}`,
    ref: `budget_notice:${line.metric}:${line.period}:${scopeKey}`,
    code: "budget_soft",
    facts: { scope: scopeKey, metric: line.metric, period: line.period, used: line.used, soft: line.soft ?? null, hard: line.hard ?? null },
    question: `Budget: ${text}`,
    context: [
      `${capital(text)}.`,
      line.hard === undefined
        ? "There is no hard limit for it: nothing is held."
        : line.guard !== undefined && line.guard !== "act"
          ? `Its hard limit is ${line.hard}; with budgets.guard_mode ${line.guard}, reaching it holds nothing.`
          : `At its hard limit (${line.hard}) new runs and restarts ${scope.scope === "project" ? "in the project" : `of ${scope.agent}`} wait until the period ends, and you are asked.`,
      "",
      "This notice is withdrawn when the period ends.",
    ].join("\n"),
  };
}

/**
 * G5 observe: a request or minute hard limit reached that act would hold new runs at. One notice per scope, metric
 * and period (key `guard_would:budget:...`, the key of its guard_would event), withdrawn when the period ends.
 */
export function wouldBlockNotice(scope: BudgetScopeView, line: BudgetLine, until: string): BudgetNotice {
  const scopeKey = scopeKeyOf(scope);
  const text = describeUsage(scope, line, "hard");
  return {
    key: `guard_would:budget:${scopeKey}:${line.metric}:${line.period}`,
    ref: `budget_notice:${line.metric}:${line.period}:${scopeKey}`,
    code: "would_block",
    facts: { guard: "budget", scope: scopeKey, metric: line.metric, period: line.period, used: line.used, hard: line.hard ?? null, until },
    question: `Budget (observe): ${text}: would hold new runs until ${until}`,
    context: [
      `${capital(text)}. With budgets.guard_mode act, new runs and restarts ${scope.scope === "project" ? "in the project" : `of ${scope.agent}`} would wait until ${until} and you would be asked. It is in observe mode, so they go on as before.`,
      "",
      "This notice is withdrawn when the period ends.",
    ].join("\n"),
  };
}

/** Why a budget notice is moot (its ref after `budget_notice:`), or null while it stands: once its period is over. */
export function budgetNoticeMoot(rest: string, now: number): string | null {
  const [metric, period] = rest.split(":");
  if (!(BUDGET_METRICS as readonly string[]).includes(metric) || !period) return null;
  return periodKey(metric as BudgetMetric, now) !== period ? `the ${isDaily(metric as BudgetMetric) ? "day" : "month"} ${period} is over` : null;
}
