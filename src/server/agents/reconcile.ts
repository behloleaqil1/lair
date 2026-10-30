/**
 * Run reconciliation: on startup, reconcile runs the store says were active
 * with what's actually running, so a restart never leaves two runs of one
 * task.
 *
 * A run the previous server started is:
 * - ADOPTED when its pid and pgid are alive and its start time matches
 *   (within tolerance): the new server re-attaches to it as if it had started
 *   it. Its claim stays, fill counts it as active.
 * - LOST when its pid is alive but the start time doesn't match (pid reused
 *   by another process): the run is marked lost, NOT killed. The other
 *   process is somebody else's.
 * - ENDED when its pid is gone: judge it by its queue line (fill's exit
 *   classification).
 *
 * Fill does not start ANY run until reconciliation has finished.
 */
import { createHash } from "crypto";
import type { AgentsStore } from "./store.js";
import type { AgentRun } from "./types.js";
import type { AgentProbes, ProcessOwner } from "./probes.js";
import { ProcessSnapshot } from "./probes.js";

/** A command fingerprint: sha256 of the argv joined by NUL, truncated to 16 chars. */
export function commandFingerprint(argv: string[]): string {
  return createHash("sha256").update(argv.join("\0")).digest("hex").slice(0, 16);
}

/**
 * Why a run was not adopted. Callers record this as the run's end state.
 */
export type ReconcileOutcome =
  | { kind: "adopted"; owner: ProcessOwner }
  | { kind: "lost"; reason: string }
  | { kind: "ended"; reason: string };

/**
 * Reconcile one run: is its process still alive and provably the same one?
 * Returns the outcome: adopted (the caller re-attaches), lost (the pid was
 * reused), or ended (the process is gone).
 *
 * A run is provably the same process when:
 * - its pid is alive
 * - its pidStartedAt matches the process's start time (within tolerance)
 * - if we have a pgid, that pgid is also alive
 *
 * A run whose pid is alive but doesn't match is NOT killed: that process
 * belongs to someone else. The run is marked lost.
 */
export function reconcileRun(
  run: AgentRun,
  snap: ProcessSnapshot,
  toleranceMs: number,
): ReconcileOutcome {
  const { pid, pidStartedAt, pgid } = run;
  if (pid === undefined || pidStartedAt === undefined) {
    // The run never started (queued state with no pid yet)
    return { kind: "ended", reason: "no pid recorded; run never started" };
  }

  const actual = snap.startedAt(pid);
  if (actual === null) {
    // The process is gone
    return { kind: "ended", reason: `pid ${pid} is not running` };
  }

  // Check start time matches within tolerance
  if (Math.abs(actual - pidStartedAt) > toleranceMs) {
    // The pid was reused by another process; do NOT kill it
    return {
      kind: "lost",
      reason: `pid ${pid} is a different process now: it started at ${new Date(actual).toISOString()}, ` +
        `expected ${new Date(pidStartedAt).toISOString()}`,
    };
  }

  // If we have a pgid and it differs from pid, verify the pgid is also alive
  // (detached processes have pgid = pid, so this is usually a no-op)
  if (pgid !== undefined && pgid !== pid) {
    const pgidStarted = snap.startedAt(pgid);
    if (pgidStarted === null) {
      // The process group leader is gone; the process may be orphaned
      return {
        kind: "lost",
        reason: `process group ${pgid} is gone, but pid ${pid} is alive (orphaned)`,
      };
    }
  }

  return {
    kind: "adopted",
    owner: { pid, startedAt: pidStartedAt, pgid },
  };
}

/**
 * The result of reconciling all active runs on startup.
 */
export interface ReconcileResult {
  adopted: { runId: string; task: string; agent: string; pid: number }[];
  lost: { runId: string; task: string; agent: string; reason: string }[];
  ended: { runId: string; task: string; agent: string; reason: string }[];
}

/**
 * Reconcile all active runs in the store. Called ONCE on startup, BEFORE
 * fill's first tick.
 */
export async function reconcileActiveRuns(
  project: string,
  store: AgentsStore,
  probes: AgentProbes,
  toleranceSeconds: number,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { adopted: [], lost: [], ended: [] };
  const list = await probes.processes.list();
  const now = probes.clock.now();
  const snap = new ProcessSnapshot(list, now, probes.self, toleranceSeconds);
  const toleranceMs = toleranceSeconds * 1000 + 1000;

  for (const run of store.activeRuns(project)) {
    if (run.state !== "running" && run.state !== "stopping") {
      // Runs in queued/waiting_lock state were never spawned by the old server
      // They stay queued and will be started by this server
      continue;
    }

    const outcome = reconcileRun(run, snap, toleranceMs);
    const entry = { runId: run.id, task: run.task, agent: run.agent };

    switch (outcome.kind) {
      case "adopted":
        result.adopted.push({ ...entry, pid: outcome.owner.pid });
        // The run stays active; the service will supervise it
        break;

      case "lost":
        result.lost.push({ ...entry, reason: outcome.reason });
        // Mark the run as failed: its exit status is unknown, and we can't
        // signal it (it's not our process)
        run.state = "failed";
        run.endedAt = now;
        run.detail = `lost in restart: ${outcome.reason}`;
        store.saveRun(run);
        // Release its claim so fill can start a new run
        store.releaseClaim(project, run.task, run.id);
        break;

      case "ended":
        result.ended.push({ ...entry, reason: outcome.reason });
        // The run ended while Lair was restarting; classify it by queue line
        // (this is done by the service's exit_unknown handling, not here)
        run.state = "exit_unknown";
        run.endedAt = now;
        run.detail = `exit unknown (ended while Lair was restarting): ${outcome.reason}`;
        store.saveRun(run);
        // Don't release the claim yet; the service's tick will classify the
        // exit and release it
        break;
    }
  }

  return result;
}

/**
 * On a planned shutdown with on_restart: stop, signal each active run's
 * process group.
 */
export async function signalActiveRuns(
  project: string,
  store: AgentsStore,
  probes: AgentProbes,
  graceSeconds: number,
): Promise<{ signalled: string[]; timedOut: string[] }> {
  const signalled: string[] = [];
  const timedOut: string[] = [];
  const graceMs = graceSeconds * 1000;

  // Collect active runs with running state
  const runs = store.activeRuns(project).filter((r) => r.state === "running");
  if (runs.length === 0) return { signalled, timedOut };

  // Send SIGTERM to each run's process group
  for (const run of runs) {
    if (run.pid === undefined) continue;
    const pgid = run.pgid ?? run.pid;
    try {
      process.kill(-pgid, "SIGTERM");
      signalled.push(run.id);
      run.state = "stopping";
      run.stopReason = "server_shutdown";
      run.stopRequestedAt = probes.clock.now();
      run.detail = "stopping for server shutdown";
      store.saveRun(run);
    } catch {
      // Already gone or can't signal
    }
  }

  // Wait up to graceSeconds for them to exit
  const deadline = probes.clock.now() + graceMs;
  const checkInterval = 500;

  while (probes.clock.now() < deadline) {
    // Build a snapshot of running processes
    const processList = await probes.processes.list();
    const pidSet = new Set(processList.map((p) => p.pid));

    const stillRunning = runs.filter((r) => {
      if (r.pid === undefined) return false;
      return pidSet.has(r.pid);
    });

    if (stillRunning.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  // SIGKILL any that are still running
  for (const run of runs) {
    if (run.pid === undefined) continue;
    const list = await probes.processes.list();
    const pidSet = new Set(list.map((p) => p.pid));
    if (!pidSet.has(run.pid)) continue;

    const pgid = run.pgid ?? run.pid;
    try {
      process.kill(-pgid, "SIGKILL");
      timedOut.push(run.id);
      run.killed = true;
      store.saveRun(run);
    } catch {
      // Already gone
    }
  }

  return { signalled, timedOut };
}

/**
 * Belt-and-braces check: before fill starts a run of task T, check for any
 * live process whose command line holds T's prompt-file prefix or the
 * agent's run marker. If one is found, don't start; raise one notice.
 *
 * This is a last-resort guard against two runs of one task, in case
 * reconciliation missed something (e.g., a run started by an older server
 * version that didn't record pgid/fingerprint).
 */
export interface ConflictCheck {
  hasConflict: boolean;
  conflictingPid?: number;
  reason?: string;
}

export function checkForConflictingProcess(
  task: string,
  agent: string,
  promptFilePrefix: string,
  processes: { pid: number; command?: string }[],
  selfPid: number,
): ConflictCheck {
  // Markers we look for in process command lines
  const taskMarker = `LAIR_TASK=${task}`;
  const runMarker = `LAIR_AGENT=${agent}`;
  const promptMarker = promptFilePrefix;

  for (const proc of processes) {
    if (proc.pid === selfPid) continue;
    if (!proc.command) continue;

    const cmd = proc.command;
    // Check if the command contains our task markers
    if (
      (cmd.includes(taskMarker) && cmd.includes(runMarker)) ||
      (promptMarker && cmd.includes(promptMarker))
    ) {
      return {
        hasConflict: true,
        conflictingPid: proc.pid,
        reason: `pid ${proc.pid} appears to be running task ${task} (agent ${agent})`,
      };
    }
  }

  return { hasConflict: false };
}
