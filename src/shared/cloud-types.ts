/**
 * Cloud machines as GET /api/cloud/status returns them (src/server/cloud/,
 * docs/configuration.md#cloud-machines): each machine's power state from its
 * provider, the spend (the provider's cost reading and Lair's own meter) and
 * the money guard's verdict. Read-only.
 */

/** A machine's power state as the provider reports it ("unknown": not read yet, or the last read failed) */
export type CloudPowerState =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "shutting-down"
  | "terminated"
  | "unknown";

export interface CloudMachineStatus {
  id: string;
  provider: "aws-ec2";
  region: string;
  /** The instance Lair starts, stops and describes, and the tag it must carry */
  instanceId: string;
  tag: string;
  state: CloudPowerState;
  /** The last launch (start) and stop the provider reports (ISO) */
  launchedAt: string | null;
  stoppedAt: string | null;
  lastCheckAt: string | null;
  /** Why the last describe failed */
  lastError: string | null;
  pricePerHour: number;
  storagePerMonth: number;
}

/** The provider's cost reading for one account (one profile) */
export interface CloudProviderSpend {
  profile: string;
  /** amount: a reading; unknown: the provider has no data yet; error: the read failed; not_read: none yet */
  state: "amount" | "unknown" | "error" | "not_read";
  amount: number | null;
  detail: string | null;
  readAt: string | null;
}

export interface CloudMeterSpend {
  /** meter_start + compute + storage */
  total: number;
  /** Every run's hours in the period times the machine's price_per_hour */
  compute: number;
  /** storage_per_month for every month of the period begun so far */
  storage: number;
  start: number;
  /** Compute since midnight UTC */
  today: number;
}

/**
 * ok: a start is allowed; warning: allowed, at warn_percent or more;
 * tripped: spend reached the limit (only the owner clears it, with POST
 * /api/cloud/trip/clear; a new limit or period alone does not); refused:
 * spend unknown, a reading failed, or outside the period.
 */
export type CloudGuardState = "ok" | "warning" | "tripped" | "refused";

/** A trip that stands until the owner clears it */
export interface CloudTrip {
  /** The limit and period when it tripped */
  limit: number;
  period: { start: string; end: string };
  spend: number;
  /** When it tripped (ISO): the clear request names it */
  at: string;
  reason: string;
}

/** POST /api/cloud/trip/clear's answer */
export interface CloudTripCleared {
  cleared: CloudTrip;
  /** The owner session's public id */
  by: string;
}

export interface CloudGuardStatus {
  state: CloudGuardState;
  /** Whether a start would be allowed now */
  allowed: boolean;
  reason: string;
  trip: CloudTrip | null;
  checkedAt: string | null;
}

export interface CloudBudgetStatus {
  limit: number;
  currency: "USD";
  period: { start: string; end: string };
  warnPercent: number;
  /** The larger of the provider's reading and the meter; null when it can't be told */
  spend: number | null;
  percent: number | null;
  meter: CloudMeterSpend | null;
  /** Why the meter can't be told (a machine's describe failed or never ran) */
  meterError: string | null;
  provider: CloudProviderSpend[];
  guard: CloudGuardStatus;
}

export interface CloudStatus {
  project: string;
  enabled: boolean;
  /** Config errors that keep the module from starting */
  errors: string[];
  checkSeconds: number | null;
  lastCheck: string | null;
  lastError: string | null;
  machines: CloudMachineStatus[];
  budget: CloudBudgetStatus | null;
}
