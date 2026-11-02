/**
 * Lair's own spend meter (docs/design/cloud-runners.md §4): every run's
 * launch and stop, as the provider described them, times the machine's
 * hourly price, plus storage for every month of the period begun so far,
 * plus the spend before the meter's first run (meter_start). It errs high:
 * each run is rounded up to whole minutes and counts one at least, a run
 * with no known stop counts up to when Lair saw it stopped (or up to now
 * while it runs), a stop the provider dated after this machine's clock is
 * not cut back to now, and a month of storage counts from its first day.
 */
import type { CloudMeterSpend } from "../../shared/cloud-types.js";
import type { CloudBudgetSettings, CloudMachineSettings } from "./config.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Storage by the hour errs high at February's rate: a month's price over its fewest hours */
const SHORTEST_MONTH_MS = 28 * DAY_MS;

export interface MeterRun {
  machine: string;
  launchedAt: number;
  /** null: still running (as far as Lair knows) */
  stoppedAt: number | null;
  /** The price when Lair recorded the run */
  pricePerHour: number;
}

export interface MeterInput {
  runs: readonly MeterRun[];
  machines: readonly Pick<CloudMachineSettings, "id" | "pricePerHour" | "storagePerMonth">[];
  budget: Pick<CloudBudgetSettings, "startMs" | "endMs" | "meterStart">;
  now: number;
}

/** Up to the next cent, so the meter never rounds spend down */
export function centsUp(amount: number): number {
  return Math.ceil(Math.round(amount * 1e6) / 1e4) / 100;
}

/** Hours billed for [from, to): whole minutes, rounded up */
export function billedHours(from: number, to: number): number {
  return to > from ? Math.ceil((to - from) / MINUTE_MS) / 60 : 0;
}

/**
 * Where a run's billing ends: a known stop as the provider dated it (never
 * clipped to this machine's clock, which may be behind the provider's), an
 * open run at now; and a minute after the launch at the earliest (EC2 bills
 * a minute at least per start), so a launch dated after now still counts.
 */
export function runEnd(run: Pick<MeterRun, "launchedAt" | "stoppedAt">, now: number): number {
  return Math.max(run.stoppedAt ?? now, run.launchedAt + MINUTE_MS);
}

/** Calendar months (UTC) of [startMs, endMs) begun by `now`, counting the current one */
export function monthsBegun(startMs: number, endMs: number, now: number): number {
  const last = Math.min(now, endMs - 1);
  if (last < startMs) return 0;
  const a = new Date(startMs);
  const b = new Date(last);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

export function meterSpend(input: MeterInput): CloudMeterSpend {
  const { budget, now } = input;
  const price = new Map(input.machines.map((m) => [m.id, m.pricePerHour]));
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  let compute = 0;
  let todays = 0;
  for (const run of input.runs) {
    // A price raised in the config since counts for earlier runs too
    const perHour = Math.max(run.pricePerHour, price.get(run.machine) ?? 0);
    const end = runEnd(run, now);
    compute += billedHours(Math.max(run.launchedAt, budget.startMs), Math.min(end, budget.endMs)) * perHour;
    todays += billedHours(Math.max(run.launchedAt, today), end) * perHour;
  }
  const perMonth = input.machines.reduce((sum, m) => sum + m.storagePerMonth, 0);
  const storage = monthsBegun(budget.startMs, budget.endMs, now) * perMonth;
  return {
    total: centsUp(budget.meterStart + compute + storage),
    compute: centsUp(compute),
    storage: centsUp(storage),
    start: budget.meterStart,
    today: centsUp(todays),
  };
}

/**
 * What the meter counts from `since` on, for the machines given (their runs
 * and counted gaps, and their storage by the hour at the shortest month's
 * rate): the spend a provider reading whose data ends at `since` does not
 * hold yet. The guard adds it to that reading, so the provider's lag never
 * hides a run.
 */
export function meterSince(input: MeterInput, since: number): number {
  const { budget, now } = input;
  const from = Math.max(since, budget.startMs);
  const price = new Map(input.machines.map((m) => [m.id, m.pricePerHour]));
  let compute = 0;
  for (const run of input.runs) {
    const current = price.get(run.machine);
    // Another account's machine: its own reading holds it
    if (current === undefined) continue;
    const perHour = Math.max(run.pricePerHour, current);
    compute += billedHours(Math.max(run.launchedAt, from), Math.min(runEnd(run, now), budget.endMs)) * perHour;
  }
  const until = Math.min(now, budget.endMs);
  const perMonth = input.machines.reduce((sum, m) => sum + m.storagePerMonth, 0);
  const storage = until > from ? (perMonth * (until - from)) / SHORTEST_MONTH_MS : 0;
  return centsUp(compute + storage);
}
