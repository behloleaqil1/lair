/**
 * The Machines section (the old Machines and Nodes views): the project's
 * machines with their runners and placement's probes, and the lair-node
 * machines registered with this server. Kept apart from the components so
 * tests check the same rules.
 */
import type { MachineStatus } from "../shared/types";
import type { PlacementJob, PlacementLane, PlacementMachine, PlacementStatus } from "../shared/placement-types";
import type { Node } from "../shared/server-types";
import { laneSlots, machineBadge, machineLoad, machineState } from "./placement-view";

export interface MachineRow {
  id: string;
  /** local, ssh, or probed only (a placement machine the project's machines: doesn't name) */
  type: string;
  state: string;
  badge: string;
  /** "heavy ✓, light ✗" */
  runners: string;
  load: string;
  lastCheck: string | null;
  status: MachineStatus | null;
  probe: PlacementMachine | null;
}

/** Each machine once: the project's machines, and placement's probes of them (or of others it names). */
export function machineRows(statuses: readonly MachineStatus[], placement: PlacementStatus | null): MachineRow[] {
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
    });
  }
  return rows;
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
