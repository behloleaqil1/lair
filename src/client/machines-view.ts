/**
 * The Machines section (the old Machines and Nodes views): the project's
 * machines with their runners and placement's probes, its cloud machines
 * with their power state and the money guard, and the lair-node machines
 * registered with this server. Kept apart from the components so tests
 * check the same rules.
 */
import type { MachineStatus } from "../shared/types";
import type { PlacementJob, PlacementLane, PlacementMachine, PlacementStatus } from "../shared/placement-types";
import type { CloudMachineStatus, CloudStatus } from "../shared/cloud-types";
import type { Node } from "../shared/server-types";
import { laneSlots, machineBadge, machineLoad, machineState } from "./placement-view";

export interface MachineRow {
  id: string;
  /** local, ssh, probed only (a placement machine the project's machines: doesn't name), or a cloud provider */
  type: string;
  state: string;
  badge: string;
  /** "heavy ✓, light ✗" */
  runners: string;
  load: string;
  lastCheck: string | null;
  status: MachineStatus | null;
  probe: PlacementMachine | null;
  /** The machine under cloud: (provider state), when it is one */
  cloud: CloudMachineStatus | null;
}

/** "running", "stopped", "unknown: <why>" */
export function cloudState(m: CloudMachineStatus): string {
  return m.state === "unknown" && m.lastError ? `unknown: ${m.lastError}` : m.state;
}

/** A stopped cloud machine is not a fault: it runs only while there is work */
export function cloudBadge(m: CloudMachineStatus): string {
  if (m.state === "running") return "badge-success";
  if (m.state === "stopped") return "badge-neutral";
  if (m.state === "pending" || m.state === "stopping") return "badge-warning";
  return "badge-error";
}

/** Each machine once: the project's machines, placement's probes of them (or of others it names), and its cloud machines. */
export function machineRows(
  statuses: readonly MachineStatus[],
  placement: PlacementStatus | null,
  cloud: CloudStatus | null = null,
): MachineRow[] {
  const probes = placement?.enabled ? placement.machines : [];
  const rows: MachineRow[] = statuses.map((status) => {
    const probe = probes.find((p) => p.id === status.name) ?? null;
    const runners = (status.runners ?? []).map((r) => `${r.lane} ${r.running ? "✓" : "✗"}`).join(", ");
    return {
      id: status.name,
      type: status.type,
      state: probe ? machineState(probe) : status.up ? "online" : "offline",
      badge: probe ? machineBadge(probe) : status.up ? "badge-success" : "badge-error",
      runners: runners || "—",
      load: probe ? machineLoad(probe) : "-",
      lastCheck: probe?.lastProbeAt ?? status.lastCheck ?? null,
      status,
      probe,
      cloud: null,
    };
  });
  for (const probe of probes) {
    if (rows.some((r) => r.id === probe.id)) continue;
    rows.push({
      id: probe.id,
      type: "probed",
      state: machineState(probe),
      badge: machineBadge(probe),
      runners: "—",
      load: machineLoad(probe),
      lastCheck: probe.lastProbeAt,
      status: null,
      probe,
      cloud: null,
    });
  }
  for (const m of cloud?.enabled ? cloud.machines : []) {
    const row = rows.find((r) => r.id === m.id);
    if (row) {
      // The same machine probed or named under machines: too: one row, its provider shown beside its type
      row.cloud = m;
      row.type = `${row.type}, ${m.provider}`;
      continue;
    }
    rows.push({
      id: m.id,
      type: m.provider,
      state: cloudState(m),
      badge: cloudBadge(m),
      runners: "—",
      load: "-",
      lastCheck: m.lastCheckAt,
      status: null,
      probe: null,
      cloud: m,
    });
  }
  return rows;
}

function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The cloud budget in a line: "Cloud spend $12.40 of $100.00 (12.4%) · guard
 * ok", with the badge for the guard. Null when the module is off.
 */
export function cloudBudget(cloud: CloudStatus | null): { text: string; badge: string; reason: string } | null {
  const budget = cloud?.enabled ? cloud.budget : null;
  if (!budget) return null;
  const spend =
    budget.spend === null
      ? `unknown of ${dollars(budget.limit)}`
      : `${dollars(budget.spend)} of ${dollars(budget.limit)}${budget.percent === null ? "" : ` (${budget.percent}%)`}`;
  const { guard } = budget;
  const badge =
    guard.state === "ok" ? "badge-success" : guard.state === "warning" ? "badge-warning" : "badge-error";
  return { text: `Cloud spend ${spend} · guard ${guard.state}`, badge, reason: guard.reason };
}

export interface MachineDetailModel {
  row: MachineRow;
  /** Placement's lanes on this machine, with their slots */
  lanes: { lane: PlacementLane; slots: string }[];
  /** The queued and running jobs of those lanes */
  jobs: PlacementJob[];
}

export function machineDetail(id: string, rows: readonly MachineRow[], placement: PlacementStatus | null): MachineDetailModel | null {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const lanes = placement?.enabled ? placement.lanes.filter((l) => l.machine === id) : [];
  const names = new Set(lanes.map((l) => l.name));
  return {
    row,
    lanes: lanes.map((lane) => ({ lane, slots: laneSlots(lane) })),
    jobs: placement?.enabled ? placement.jobs.filter((j) => names.has(j.lane)) : [],
  };
}

export interface NodeRow {
  id: string;
  name: string;
  status: string;
  badge: string;
  capacity: string;
  used: string;
  jobs: number;
  runtime: string;
  lastHeartbeat: string | null;
  node: Node;
}

function gb(mb: number): string {
  return `${Math.round(mb / 1024)} GB`;
}

export function nodeRows(nodes: readonly Node[]): NodeRow[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    status: node.status,
    badge: node.status === "online" ? "badge-success" : node.status === "draining" ? "badge-warning" : "badge-error",
    capacity: `${node.capacity.cores} cores, ${gb(node.capacity.ramMb)} RAM`,
    used: `${node.usedCapacity.cores} cores, ${gb(node.usedCapacity.ramMb)} RAM`,
    jobs: node.activeJobs,
    runtime: node.capacity.containerRuntime || "none",
    lastHeartbeat: node.lastHeartbeat || null,
    node,
  }));
}

/** Home's machine tile: how many are up. */
export function machineCounts(rows: readonly MachineRow[]): { up: number; total: number } {
  return { up: rows.filter((r) => r.badge === "badge-success").length, total: rows.length };
}
