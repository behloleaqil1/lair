/**
 * The Machines section (machines-view.ts), from the shapes GET
 * /api/machines, /api/placement/status and /api/nodes return.
 */
import { describe, expect, it } from "vitest";
import type { MachineStatus } from "../shared/types";
import type { PlacementStatus } from "../shared/placement-types";
import type { Node } from "../shared/server-types";
import type { CloudMachineStatus, CloudStatus } from "../shared/cloud-types";
import { cloudBudget, machineCounts, machineDetail, machineRows, nodeRows } from "./machines-view";

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

  it("lists cloud machines with their power state, once, and the money guard in a line", () => {
    const machine = (id: string, state: CloudMachineStatus["state"], lastError: string | null = null): CloudMachineStatus => ({
      id,
      provider: "aws-ec2",
      region: "us-east-1",
      instanceId: "i-0123456789abcdef0",
      tag: "role=gate-server",
      state,
      launchedAt: null,
      stoppedAt: null,
      lastCheckAt: "2026-10-27T12:00:00Z",
      lastError,
      pricePerHour: 0.5,
      storagePerMonth: 6,
    });
    const cloud = {
      project: "shop",
      enabled: true,
      errors: [],
      checkSeconds: 300,
      lastCheck: "2026-10-27T12:00:00Z",
      lastError: null,
      // "remote" is placement's machine too: one row
      machines: [machine("remote", "running"), machine("cloud-2", "stopped"), machine("cloud-3", "unknown", "describe: timeout")],
      budget: {
        limit: 100,
        currency: "USD",
        period: { start: "2026-01-01", end: "2026-12-31" },
        warnPercent: 80,
        spend: 84.5,
        percent: 84.5,
        meter: null,
        meterError: null,
        provider: [],
        guard: { state: "warning", allowed: true, reason: "spend $84.50 of $100.00 (provider $80.00, meter $84.50)", trip: null, checkedAt: null },
      },
    } satisfies CloudStatus;
    const before = machineRows(statuses, placement);
    const rows = machineRows(statuses, placement, cloud);
    expect(rows.map((r) => [r.id, r.type, r.badge])).toEqual([
      ["mac", "local", "badge-success"],
      ["dell", "ssh", "badge-error"],
      ["remote", "probed, aws-ec2", "badge-error"],
      ["cloud-2", "aws-ec2", "badge-neutral"],
      ["cloud-3", "aws-ec2", "badge-error"],
    ]);
    // A machine placement probes keeps its probe state; the provider's is in its detail
    expect(rows.slice(0, 3).map((r) => r.state)).toEqual(before.map((r) => r.state));
    expect(rows[2].cloud?.state).toBe("running");
    expect(rows.slice(3).map((r) => r.state)).toEqual(["stopped", "unknown: describe: timeout"]);
    expect(cloudBudget(cloud)).toEqual({
      text: "Cloud spend $84.50 of $100.00 (84.5%) · guard warning",
      badge: "badge-warning",
      reason: "spend $84.50 of $100.00 (provider $80.00, meter $84.50)",
    });
    const tripped = { ...cloud, budget: { ...cloud.budget, spend: null, percent: null, guard: { ...cloud.budget.guard, state: "refused" as const } } };
    expect(cloudBudget(tripped)?.text).toBe("Cloud spend unknown of $100.00 · guard refused");
    expect(cloudBudget(tripped)?.badge).toBe("badge-error");
    // Off: no rows, no line
    expect(machineRows(statuses, null, { ...cloud, enabled: false }).map((r) => r.id)).toEqual(["mac", "dell"]);
    expect(cloudBudget({ ...cloud, enabled: false })).toBeNull();
  });
});
