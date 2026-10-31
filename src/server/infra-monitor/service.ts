/**
 * The infrastructure monitor service: one InfraMonitor per project with
 * `infra_monitor.enabled`.
 *
 * Each tick:
 * 1. Probe every machine the project's lanes use
 * 2. Read the gate queue to find running and queued jobs
 * 3. Detect infrastructure problems:
 *    - Jobs running on machines that went down
 *    - Duplicate runner slots
 *    - Dead runners while jobs are queued
 * 4. For each finding, raise one notice and, in act mode, re-queue the job
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { DecisionProducer } from "../decisions/types.js";
import { parseInfraMonitorConfig, actBlockedReason, buildArgv } from "./config.js";
import type { InfraMonitorSettings } from "./types.js";
import { detectJobMachineDown, detectDuplicateSlot, detectDeadRunner, type DetectorContext } from "./detectors.js";
import type { InfraFinding, InfraMonitorStatus, InfraMonitorTick, InfraNotice, MachineState, MonitoredJob } from "./types.js";
import { readGateQueue, findDuplicateSlots, getRunnerPid, type InfraMonitorProbes, systemInfraProbes } from "./probes.js";
import { InfraMonitorStore } from "./store.js";

const DECISION_MODULE = "infra_monitor";
const MAX_EVIDENCE_LINES = 20;

export interface InfraMonitorOptions {
  project: string;
  config: ProjectConfig;
  settings: InfraMonitorSettings;
  store: InfraMonitorStore;
  probes: InfraMonitorProbes;
  events?: EventBus;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class InfraMonitor {
  readonly project: string;
  private config: ProjectConfig;
  private settings: InfraMonitorSettings;
  private store: InfraMonitorStore;
  private probes: InfraMonitorProbes;
  private events?: EventBus;
  private decisions?: DecisionProducer;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<InfraMonitorTick> | null = null;
  private stopped = true;
  private abort = new AbortController();
  lastTick?: InfraMonitorTick;
  lastError?: string;

  constructor(options: InfraMonitorOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.probes = options.probes;
    this.events = options.events;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Why act mode is off for this project, or null when it is on. */
  get actBlocked(): string | null {
    return actBlockedReason(this.config, this.settings);
  }

  private get gatesDir(): string {
    return this.config.gates_dir;
  }

  /** The machines used by the project's lanes. */
  private get machines(): Map<string, string> {
    const result = new Map<string, string>();
    const machines = this.config.machines ?? {};
    for (const [id, machine] of Object.entries(machines)) {
      if (machine && typeof machine === "object" && "runners" in machine) {
        const runners = machine.runners as string[] | undefined;
        if (runners) {
          for (const lane of runners) {
            result.set(lane, id);
          }
        }
      }
    }
    // Local machine handles lanes not assigned elsewhere
    return result;
  }

  /** Unique machine ids from the project. */
  private get machineIds(): string[] {
    return [...new Set(this.machines.values())];
  }

  /** Lanes from the config. */
  private get lanes(): string[] {
    return [...this.machines.keys()];
  }

  // ============ DECISION INBOX ============

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
  }

  // ============ MACHINE PROBING ============

  private async probeMachine(machineId: string, now: number): Promise<MachineState> {
    const existing = this.store.getMachine(this.project, machineId);
    const state: MachineState = {
      id: machineId,
      reachable: existing?.reachable ?? true,
      lastProbeAt: now,
      lastError: existing?.lastError ?? null,
      downSince: existing?.downSince ?? null,
    };

    if (!this.settings.probeCmd) {
      // No probe command: assume reachable
      state.reachable = true;
      state.downSince = null;
      this.store.putMachine(this.project, state);
      return state;
    }

    const built = buildArgv(this.settings.probeCmd, { machine: machineId });
    if ("error" in built) {
      state.lastError = `probe_cmd error: ${built.error}`;
      // Don't change reachability on config error
      this.store.putMachine(this.project, state);
      return state;
    }

    try {
      const result = await this.probes.runner.run(built.argv, {
        timeoutMs: this.settings.probeTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });

      if (this.abort.signal.aborted) {
        // Aborted: don't update state
        return state;
      }

      if (result.code === 0) {
        state.reachable = true;
        state.lastError = null;
        state.downSince = null;
      } else {
        const wasUp = state.reachable;
        state.reachable = false;
        state.lastError = result.stderr.trim().slice(0, 500) || `exit code ${result.code}`;
        if (wasUp || state.downSince === null) {
          state.downSince = now;
        }
      }
    } catch (e) {
      const wasUp = state.reachable;
      state.reachable = false;
      state.lastError = e instanceof Error ? e.message : String(e);
      if (wasUp || state.downSince === null) {
        state.downSince = now;
      }
    }

    this.store.putMachine(this.project, state);
    return state;
  }

  private async probeMachines(now: number): Promise<Map<string, MachineState>> {
    const states = new Map<string, MachineState>();
    await Promise.all(
      this.machineIds.map(async (id) => {
        const state = await this.probeMachine(id, now);
        states.set(id, state);
      })
    );
    return states;
  }

  // ============ JOB TRACKING ============

  private updateRunningJobs(now: number): MonitoredJob[] {
    const queue = readGateQueue(this.probes.fs, this.gatesDir);
    const running = queue.filter((g) => g.status === "running");
    const runningIds = new Set(running.map((g) => g.gateId));

    // Remove jobs that are no longer running
    for (const job of this.store.listJobs(this.project)) {
      if (!runningIds.has(job.id)) {
        this.store.deleteJob(this.project, job.id);
        // Clear any notifications for this job
        this.store.clearNotified(this.project, `job_machine_down:${job.id}`);
      }
    }

    // Add or update running jobs
    for (const gate of running) {
      const machine = this.machines.get(gate.lane);
      if (!machine) continue; // Lane not assigned to a machine

      const existing = this.store.getJob(this.project, gate.gateId);
      const runnerPid = gate.pid ?? getRunnerPid(this.probes.fs, this.gatesDir, gate.lane);

      if (existing) {
        existing.lastSeenAt = now;
        existing.runnerPid = runnerPid;
        this.store.putJob(this.project, existing);
      } else {
        this.store.putJob(this.project, {
          id: gate.gateId,
          lane: gate.lane,
          machine,
          startedAt: iso(gate.ctimeMs ?? now),
          lastSeenAt: now,
          runnerPid,
        });
      }
    }

    return this.store.listJobs(this.project);
  }

  // ============ NOTICE HANDLING ============

  private async raiseNotice(finding: InfraFinding, now: number): Promise<boolean> {
    if (this.store.hasNotified(this.project, finding.key)) {
      return false; // Already notified this session
    }

    const notice: InfraNotice = {
      id: crypto.randomUUID(),
      finding,
      raisedAt: iso(now),
      decisionId: null,
      requeued: false,
      requeueResult: null,
    };

    this.store.addNotice(this.project, notice);
    this.store.markNotified(this.project, finding.key);

    // Emit event
    await this.events?.emit("decision.needed", {
      project: this.project,
      module: DECISION_MODULE,
      kind: "notice",
      summary: finding.summary,
      evidence: finding.evidence.slice(0, MAX_EVIDENCE_LINES),
    });

    // Raise to Decision Inbox if available (as a notice, not blocking)
    if (this.decisions) {
      try {
        const result = await this.decisions.raise({
          project: this.project,
          kind: "escalation",
          attention: "notice",
          title: finding.summary.slice(0, 200),
          context: [
            `**${finding.type}**`,
            "",
            ...finding.evidence.map((e) => `- ${e}`),
          ].join("\n"),
          options: [{ id: "acknowledged", label: "Acknowledged", consequences: "The notice is acknowledged but no automated action is taken.", effect: "frees_task" }],
          recommended: { optionId: "acknowledged", reasoning: "This is an informational notice." },
          source: { module: DECISION_MODULE, ref: finding.key },
          key: finding.key,
          class: "infra_monitor.notice",
          evidence: {
            code: finding.type,
            facts: {
              machine: finding.vars.machine || null,
              lane: finding.vars.from_lane || finding.vars.lane || null,
              gate: finding.vars.gate || null,
            },
            cause_cleared: false,
            linked_issue: null,
          },
        });
        notice.decisionId = result.decision.id;
        this.store.addNotice(this.project, notice);
      } catch (e) {
        console.warn(`[infra-monitor] ${this.project}: failed to raise notice: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return true;
  }

  // ============ ACT MODE: RE-QUEUE ============

  private async requeue(finding: InfraFinding, _now: number): Promise<"moved" | "failed" | "skipped"> {
    if (this.actBlocked !== null) return "skipped";
    if (!this.settings.requeueCmd) return "skipped";
    if (finding.type !== "job_machine_down") return "skipped";

    // Find an alternative lane (same track, different machine if possible)
    const fromLane = finding.vars.from_lane;
    const fromMachine = finding.vars.machine;
    const gate = finding.vars.gate;

    // For now, we don't auto-select a target lane; the requeue_cmd handles that
    // Just pass the from_lane and let the command figure out the best target
    const toLane = fromLane; // Placeholder - the command may override

    const built = buildArgv(this.settings.requeueCmd, {
      gate,
      from_lane: fromLane,
      to_lane: toLane,
    });

    if ("error" in built) {
      console.warn(`[infra-monitor] ${this.project}: requeue_cmd error: ${built.error}`);
      return "failed";
    }

    try {
      const result = await this.probes.runner.run(built.argv, {
        timeoutMs: this.settings.requeueTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });

      if (this.abort.signal.aborted) return "skipped";

      if (result.code === 0) {
        await this.events?.emit("placement.moved", {
          project: this.project,
          gateId: gate,
          from: fromLane,
          to: toLane,
          reason: `machine ${fromMachine} down`,
        });
        return "moved";
      } else {
        console.warn(`[infra-monitor] ${this.project}: requeue failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`);
        return "failed";
      }
    } catch (e) {
      console.warn(`[infra-monitor] ${this.project}: requeue error: ${e instanceof Error ? e.message : String(e)}`);
      return "failed";
    }
  }

  // ============ THE TICK ============

  tick(): Promise<InfraMonitorTick> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<InfraMonitorTick> {
    const now = this.probes.clock.now();
    const summary: InfraMonitorTick = {
      at: iso(now),
      jobsMonitored: 0,
      machinesProbed: 0,
      findingsDetected: 0,
      noticesRaised: 0,
      requeuesAttempted: 0,
    };

    try {
      // 1. Probe machines
      const machineStates = await this.probeMachines(now);
      if (this.abort.signal.aborted) return summary;
      summary.machinesProbed = machineStates.size;

      // 2. Update running jobs
      const runningJobs = this.updateRunningJobs(now);
      summary.jobsMonitored = runningJobs.length;

      // 3. Read queue for additional context
      const queuedGates = readGateQueue(this.probes.fs, this.gatesDir);

      // 4. Detect problems
      const ctx: DetectorContext = {
        project: this.project,
        now,
        runningJobs,
        queuedGates,
        machineStates,
        lanes: this.machines,
        downThresholdSeconds: this.settings.downThresholdSeconds,
      };

      const duplicates = findDuplicateSlots(this.probes.fs, this.gatesDir, this.lanes);
      const findings: InfraFinding[] = [
        ...detectJobMachineDown(ctx),
        ...detectDuplicateSlot(ctx, duplicates),
        ...detectDeadRunner(ctx),
      ];
      summary.findingsDetected = findings.length;

      // 5. Handle findings
      for (const finding of findings) {
        if (this.abort.signal.aborted) break;

        const raised = await this.raiseNotice(finding, now);
        if (raised) summary.noticesRaised++;

        // In act mode, try to re-queue jobs on down machines
        if (finding.type === "job_machine_down" && this.actBlocked === null) {
          summary.requeuesAttempted++;
          const result = await this.requeue(finding, now);
          const notice = this.store.getNotice(this.project, finding.key);
          if (notice) {
            notice.requeued = true;
            notice.requeueResult = result;
            this.store.addNotice(this.project, notice);
          }
          // If successfully moved, clear the notification so it can be raised again if needed
          if (result === "moved") {
            this.store.clearNotified(this.project, finding.key);
          }
        }
      }

      // Clear notifications for findings that are no longer present
      const currentKeys = new Set(findings.map((f) => f.key));
      for (const notice of this.store.listNotices(this.project)) {
        if (!currentKeys.has(notice.finding.key)) {
          this.store.deleteNotice(this.project, notice.finding.key);
          this.store.clearNotified(this.project, notice.finding.key);
        }
      }

      this.lastTick = summary;
      this.lastError = undefined;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error(`[infra-monitor] ${this.project}: tick failed:`, e);
    }

    return summary;
  }

  // ============ LIFECYCLE ============

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.abort.signal.aborted) {
      this.abort = new AbortController();
    }

    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };

    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
  }

  status(): InfraMonitorStatus {
    return {
      project: this.project,
      enabled: true,
      running: this.running,
      mode: this.settings.mode,
      intervalSeconds: this.settings.intervalSeconds,
      lastTick: this.lastTick ?? null,
      lastError: this.lastError ?? null,
      monitoredJobs: this.store.listJobs(this.project),
      machineStates: this.store.listMachines(this.project),
      activeNotices: this.store.listNotices(this.project),
    };
  }
}

// ============ MANAGER ============

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

/**
 * All projects' infra monitors.
 */
export class InfraMonitorManager {
  private monitors = new Map<string, InfraMonitor>();
  private problems = new Map<string, string[]>();
  private store: InfraMonitorStore;
  private decisions?: DecisionProducer;
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private options: { probes?: InfraMonitorProbes; events?: EventBus }) {
    this.store = new InfraMonitorStore();
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }

      const parsed = parseInfraMonitorConfig(entry.config.infra_monitor);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[infra-monitor] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }

      if (!parsed.settings.enabled) continue;

      this.monitors.set(
        entry.name,
        new InfraMonitor({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.store,
          probes: this.options.probes ?? systemInfraProbes(parsed.settings.probeTimeoutSeconds * 1000),
          events: this.options.events,
        })
      );
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const monitor of this.monitors.values()) {
      if (this.decisions) monitor.useDecisions(this.decisions);
      monitor.start();
    }
    return [...this.monitors.keys()];
  }

  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.phase === "stopped") return;

    const old = this.monitors.get(entry.name);
    if (old) await old.stop();

    this.monitors.delete(entry.name);
    this.problems.delete(entry.name);
    this.store.clearProject(entry.name);
    this.load([entry]);

    const next = this.monitors.get(entry.name);
    if (next && this.phase === "started") {
      if (this.decisions) next.useDecisions(this.decisions);
      next.start();
    }
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.monitors.values()].map((m) => m.stop()));
    this.monitors.clear();
  }

  get(project: string): InfraMonitor | undefined {
    return this.monitors.get(project);
  }

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    for (const monitor of this.monitors.values()) {
      monitor.useDecisions(decisions);
    }
  }

  status(project: string): InfraMonitorStatus {
    const monitor = this.monitors.get(project);
    if (monitor) return monitor.status();
    return {
      project,
      enabled: false,
      running: false,
      mode: null,
      intervalSeconds: null,
      lastTick: null,
      lastError: this.problems.get(project)?.join("; ") ?? null,
      monitoredJobs: [],
      machineStates: [],
      activeNotices: [],
    };
  }

  allStatus(): InfraMonitorStatus[] {
    return [...this.monitors.keys()].map((p) => this.status(p));
  }
}
