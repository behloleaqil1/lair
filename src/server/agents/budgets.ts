/**
 * Per-agent and per-project token and cost budgets, per UTC day and month.
 *
 * Usage is fed by the fleet budget (src/server/fleet/budget.ts): every cost
 * recorded there with a project (and agent) attribution lands in the agents
 * ledger, including the usage the agents module reads from run logs, which
 * it records through the fleet budget too. A soft limit warns; a hard limit
 * stops new runs for that scope and raises a `spend` decision.
 */
import type { BudgetLine, BudgetMetric, BudgetScopeView } from "../../shared/agents-types.js";
import type { CostAttribution, CostEvent } from "../fleet/budget.js";
import type { AgentsSettings, BudgetLimits } from "./config.js";
import type { AgentsStore } from "./store.js";

export const BUDGET_METRICS: readonly BudgetMetric[] = ["daily_tokens", "daily_cost", "monthly_tokens", "monthly_cost"];

/** What the agents module needs from the fleet budget (BudgetManager has it). */
export interface FleetBudget {
  recordCost(provider: string, cost: number, reason?: string, attribution?: CostAttribution): void;
  onCost(listener: (event: CostEvent) => void): () => void;
  isProviderAvailable(provider: string): boolean;
}

function isDaily(metric: BudgetMetric): boolean {
  return metric.startsWith("daily_");
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

/** Evaluate one scope (the project when `agent` is null). */
export function evaluateBudget(
  store: AgentsStore,
  project: string,
  agent: string | null,
  limits: BudgetLimits | undefined,
  now: number,
): BudgetScopeView | null {
  if (!limits) return null;
  const lines: BudgetLine[] = [];
  for (const metric of BUDGET_METRICS) {
    const limit = limits[metric];
    if (!limit || (limit.soft === undefined && limit.hard === undefined)) continue;
    const usage = store.usageSince(project, agent, periodStart(metric, now));
    const used = metric.endsWith("_tokens") ? usage.tokens : Math.round(usage.cost * 1e6) / 1e6;
    const level =
      limit.hard !== undefined && used >= limit.hard
        ? "hard"
        : limit.soft !== undefined && used >= limit.soft
          ? "soft"
          : "ok";
    lines.push({ metric, period: periodKey(metric, now), used, soft: limit.soft, hard: limit.hard, level });
  }
  return {
    scope: agent === null ? "project" : "agent",
    agent: agent ?? undefined,
    lines,
    blocked: lines.some((line) => line.level === "hard"),
  };
}

/** "agent worker-a used 9 cost in day 2026-01-31 (hard limit 8)" */
export function describeUsage(scope: BudgetScopeView, line: BudgetLine, which: "soft" | "hard"): string {
  const who = scope.scope === "project" ? "the project" : `agent ${scope.agent}`;
  const unit = line.metric.endsWith("_cost") ? "cost" : "tokens";
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
