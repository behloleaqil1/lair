/**
 * The money guard (docs/design/cloud-runners.md §4). Spend is the larger of
 * the provider's cost reading and Lair's meter; at the limit or above no
 * machine starts, and the trip stands until the owner clears it (an owner
 * session's request, POST /api/cloud/trip/clear): a higher limit or a new
 * period alone does not. It fails closed: a spend Lair can't tell (a machine
 * it could not describe, a cost reading that failed) or a day outside the
 * period refuses a start too. A provider reading of "unknown" (no data yet)
 * leaves the meter to decide.
 */
import type { CloudGuardState, CloudProviderSpend } from "../../shared/cloud-types.js";
import type { CloudBudgetSettings } from "./config.js";

export interface StoredTrip {
  /** The limit and period when it tripped */
  limit: number;
  periodStart: string;
  periodEnd: string;
  spend: number;
  reason: string;
  at: number;
}

/** What the owner does to clear a trip */
export const CLEAR_TRIP_HINT =
  "only the owner clears it (Machines, the machine's detail, Clear the trip): a higher cloud.budget.limit or a new period alone does not";

export interface GuardInput {
  budget: CloudBudgetSettings;
  now: number;
  /** The meter's total, or null when it can't be told */
  meter: number | null;
  meterError: string | null;
  provider: readonly CloudProviderSpend[];
  /** The trip that stands (not cleared by the owner), whatever the limit and period are now */
  trip: StoredTrip | null;
}

export interface GuardVerdict {
  state: CloudGuardState;
  allowed: boolean;
  reason: string;
  /** The spend the verdict used (null when unknown) */
  spend: number | null;
  /** The provider's readings summed (accounts with no data yet count 0) */
  providerAmount: number | null;
  /** Spend reached the limit just now: the caller records the trip */
  trips: boolean;
}

export function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function refuse(state: CloudGuardState, reason: string, spend: number | null = null, providerAmount: number | null = null): GuardVerdict {
  return { state, allowed: false, reason, spend, providerAmount, trips: false };
}

export function evaluateGuard(input: GuardInput): GuardVerdict {
  const { budget, now } = input;
  if (input.trip) {
    return refuse(
      "tripped",
      `tripped on ${new Date(input.trip.at).toISOString()}: ${input.trip.reason}; ${CLEAR_TRIP_HINT}`,
      input.trip.spend,
    );
  }
  if (now < budget.startMs) return refuse("refused", `the budget period starts on ${budget.periodStart}`);
  if (now >= budget.endMs) return refuse("refused", `the budget period ended on ${budget.periodEnd}`);
  if (input.meter === null || !Number.isFinite(input.meter)) {
    return refuse("refused", `spend unknown: ${input.meterError ?? "the meter has not read every machine yet"}`);
  }
  let providerAmount = 0;
  const unknown: string[] = [];
  for (const reading of input.provider) {
    if (reading.state === "error") {
      return refuse("refused", `spend unknown: the cost reading for profile ${reading.profile} failed: ${reading.detail ?? "no detail"}`);
    }
    if (reading.state === "not_read") return refuse("refused", `spend unknown: no cost reading for profile ${reading.profile} yet`);
    if (reading.state === "unknown") {
      unknown.push(reading.profile);
      continue;
    }
    if (reading.amount === null || !Number.isFinite(reading.amount)) {
      return refuse("refused", `spend unknown: the cost reading for profile ${reading.profile} has no amount`);
    }
    providerAmount += reading.amount;
  }
  const spend = Math.max(providerAmount, input.meter);
  const parts = `provider ${dollars(providerAmount)}${unknown.length > 0 ? ` (no data yet: ${unknown.join(", ")})` : ""}, meter ${dollars(input.meter)}`;
  if (spend >= budget.limit) {
    return {
      state: "tripped",
      allowed: false,
      reason: `spend ${dollars(spend)} reached the limit ${dollars(budget.limit)} (${parts})`,
      spend,
      providerAmount,
      trips: true,
    };
  }
  const percent = (spend / budget.limit) * 100;
  return {
    state: percent >= budget.warnPercent ? "warning" : "ok",
    allowed: true,
    reason: `spend ${dollars(spend)} of ${dollars(budget.limit)} (${parts})`,
    spend,
    providerAmount,
    trips: false,
  };
}
