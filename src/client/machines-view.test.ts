/**
 * The Machines section (machines-view.ts), from the shapes GET
 * /api/machines, /api/placement/status and /api/nodes return.
 */
import { describe, expect, it } from "vitest";
import type { MachineStatus } from "../shared/types";
import type { PlacementStatus } from "../shared/placement-types";
import type { Node } from "../shared/server-types";
import { machineCounts, machineDetail, machineRows, nodeRows } from "./machines-view";

const statuses: MachineStatus[] = [
  { name: "mac", type: "local", up: true, lastCheck: "2026-10-27T11:59:00Z", runners: [{ lane: "heavy", running: true }, { lane: "light", running: false }] },
  { name: "dell", type: "ssh", up: false, lastCheck: "2026-10-27T11:59:00Z", runners: [] },
];

const placement = {
  enabled: true,
  mode: "observe",
  machines: [
    { id: "mac", state: "up", passingSince: null, upSince: "2026-10-27T08:00:00Z", downSince: null, lastProbeAt: "2026-10-27T12:00:00Z", lastError: null, load: 3.1, cpus: 10, utilization: 0.31, factor: 1 },
    { id: "remote", state: "down", passingSince: null, upSince: null, downSince: "2026-10-27T11:00:00Z", lastProbeAt: "2026-10-27T12:00:00Z", lastError: "ssh: timeout", load: null, cpus: null, utilization: null, factor: 1 },
  ],
  lanes: [
    { name: "heavy", machine: "mac", slots: 2, inUse: 1, queued: 3, limits: [], serves: [] },
    { name: "remote", machine: "remote", slots: 1, inUse: 0, queued: 0, limits: [], serves: ["heavy"] },
  ],
  jobs: [
    { id: "g1", lane: "heavy", priority: 1, status: "running", class: null, expectedStart: null, expectedFinish: null, held: null, advice: null },
    { id: "g2", lane: "remote", priority: 1, status: "queued", class: null, expectedStart: null, expectedFinish: null, held: null, advice: null },
  ],
} as unknown as PlacementStatus;

describe("machines", () => {
  it("lists each machine once, with its runners and placement's probe of it", () => {
    const rows = machineRows(statuses, placement);
    expect(rows.map((r) => [r.id, r.type, r.badge, r.runners, r.load])).toEqual([
      ["mac", "local", "badge-success", "heavy ✓, light ✗", "3.10 on 10 cpus"],
      ["dell", "ssh", "badge-error", "—", "-"],
      ["remote", "probed", "badge-error", "—", "-"],
    ]);
    expect(rows[2].state).toMatch(/^down since /);
    expect(machineCounts(rows)).toEqual({ up: 1, total: 3 });
    // Without placement, only what the machines say
    expect(machineRows(statuses, null).map((r) => r.state)).toEqual(["online", "offline"]);
  });

  it("opens a machine with its lanes and the jobs on them", () => {
    const rows = machineRows(statuses, placement);
    const mac = machineDetail("mac", rows, placement)!;
    expect(mac.lanes.map((l) => [l.lane.name, l.slots])).toEqual([["heavy", "1/2 in use, 3 queued"]]);
    expect(mac.jobs.map((j) => j.id)).toEqual(["g1"]);
    expect(machineDetail("remote", rows, placement)!.jobs.map((j) => j.id)).toEqual(["g2"]);
    expect(machineDetail("nowhere", rows, placement)).toBeNull();
  });

  it("lists lair-node machines with their capacity", () => {
    const node: Node = {
      id: "n1",
      name: "builder",
      status: "draining",
      capacity: { cores: 8, ramMb: 16384, diskGb: 200, gpuCount: 0, containerRuntime: "docker" },
      usedCapacity: { cores: 2, ramMb: 4096 },
      activeJobs: 1,
      lastHeartbeat: "2026-10-27T12:00:00Z",
      registeredAt: "2026-10-01T00:00:00Z",
    };
    expect(nodeRows([node])[0]).toMatchObject({
      name: "builder",
      badge: "badge-warning",
      capacity: "8 cores, 16 GB RAM",
      used: "2 cores, 4 GB RAM",
      jobs: 1,
      runtime: "docker",
    });
  });
});
