/**
 * Detectors for the infra monitor.
 *
 * Each detector checks for one class of infrastructure problem and returns
 * findings. Detectors never act; the service handles that.
 */
import type { InfraFinding, MachineState, MonitoredJob } from "./types.js";
import type { QueuedGate } from "./probes.js";

export interface DetectorContext {
  project: string;
  now: number;
  runningJobs: MonitoredJob[];
  queuedGates: QueuedGate[];
  machineStates: Map<string, MachineState>;
  lanes: Map<string, string>; // lane -> machine
  downThresholdSeconds: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m === 1 ? "1 min" : `${m} min`;
}

/**
 * Detect jobs whose machine has gone down.
 *
 * A finding is raised when:
 * - A job is running on a machine
 * - The machine is unreachable
 * - The machine has been down longer than the threshold
 */
export function detectJobMachineDown(ctx: DetectorContext): InfraFinding[] {
  const findings: InfraFinding[] = [];

  for (const job of ctx.runningJobs) {
    const machineState = ctx.machineStates.get(job.machine);
    if (!machineState) continue;
    if (machineState.reachable) continue;
    if (machineState.downSince === null) continue;

    const downSeconds = (ctx.now - machineState.downSince) / 1000;
    if (downSeconds < ctx.downThresholdSeconds) continue;

    findings.push({
      key: `job_machine_down:${job.id}`,
      type: "job_machine_down",
      summary: `Job ${job.id} is running on ${job.machine}, which has been down for ${minutes(downSeconds)}`,
      evidence: [
        `job ${job.id} on lane ${job.lane}`,
        `machine ${job.machine} unreachable since ${iso(machineState.downSince)}`,
        machineState.lastError ? `last probe error: ${machineState.lastError}` : "no probe error recorded",
        `job started at ${job.startedAt}`,
      ],
      vars: {
        gate: job.id,
        from_lane: job.lane,
        machine: job.machine,
        down_seconds: String(Math.round(downSeconds)),
      },
    });
  }

  return findings;
}

/**
 * Detect duplicate runner slots.
 *
 * A finding is raised when two or more runners claim the same slot
 * (multiple runner-<lane>.pid files with different pids).
 */
export function detectDuplicateSlot(ctx: DetectorContext, duplicates: { lane: string; count: number; pids: number[] }[]): InfraFinding[] {
  const findings: InfraFinding[] = [];

  for (const dup of duplicates) {
    findings.push({
      key: `duplicate_slot:${dup.lane}`,
      type: "duplicate_slot",
      summary: `Lane ${dup.lane} has ${dup.count} runners claiming the slot (pids: ${dup.pids.join(", ")})`,
      evidence: [
        `lane ${dup.lane}: ${dup.count} runner pid files found`,
        `pids: ${dup.pids.join(", ")}`,
        "only one runner should hold each lane's slot at a time",
      ],
      vars: {
        lane: dup.lane,
        count: String(dup.count),
        pids: dup.pids.join(","),
      },
    });
  }

  return findings;
}

/**
 * Detect dead runners while jobs are queued.
 *
 * A finding is raised when:
 * - A lane has queued jobs (not just running ones)
 * - The lane's machine is unreachable
 * - The machine has been down longer than the threshold
 */
export function detectDeadRunner(ctx: DetectorContext): InfraFinding[] {
  const findings: InfraFinding[] = [];

  // Group queued gates by lane
  const queuedByLane = new Map<string, QueuedGate[]>();
  for (const gate of ctx.queuedGates) {
    if (gate.status !== "queued") continue;
    const list = queuedByLane.get(gate.lane) ?? [];
    list.push(gate);
    queuedByLane.set(gate.lane, list);
  }

  for (const [lane, queued] of queuedByLane) {
    if (queued.length === 0) continue;

    const machine = ctx.lanes.get(lane);
    if (!machine) continue;

    const machineState = ctx.machineStates.get(machine);
    if (!machineState) continue;
    if (machineState.reachable) continue;
    if (machineState.downSince === null) continue;

    const downSeconds = (ctx.now - machineState.downSince) / 1000;
    if (downSeconds < ctx.downThresholdSeconds) continue;

    findings.push({
      key: `dead_runner:${lane}`,
      type: "dead_runner",
      summary: `Lane ${lane} has ${queued.length} queued job(s) but its machine ${machine} has been down for ${minutes(downSeconds)}`,
      evidence: [
        `lane ${lane}: ${queued.length} queued job(s)`,
        `machine ${machine} unreachable since ${iso(machineState.downSince)}`,
        machineState.lastError ? `last probe error: ${machineState.lastError}` : "no probe error recorded",
        ...queued.slice(0, 5).map((g) => `queued: ${g.gateId} (priority ${g.priority})`),
        ...(queued.length > 5 ? [`... and ${queued.length - 5} more`] : []),
      ],
      vars: {
        lane,
        machine,
        queued_count: String(queued.length),
        down_seconds: String(Math.round(downSeconds)),
      },
    });
  }

  return findings;
}
