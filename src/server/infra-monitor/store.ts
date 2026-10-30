/**
 * In-memory store for the infra monitor.
 * Tracks monitored jobs, machine states, and notices.
 */
import type { InfraFinding, InfraNotice, MachineState, MonitoredJob } from "./types.js";

export class InfraMonitorStore {
  private jobs = new Map<string, Map<string, MonitoredJob>>(); // project -> gateId -> job
  private machines = new Map<string, Map<string, MachineState>>(); // project -> machineId -> state
  private notices = new Map<string, Map<string, InfraNotice>>(); // project -> key -> notice
  private notifiedKeys = new Map<string, Set<string>>(); // project -> set of keys already notified

  // ============ JOBS ============

  putJob(project: string, job: MonitoredJob): void {
    let projectJobs = this.jobs.get(project);
    if (!projectJobs) {
      projectJobs = new Map();
      this.jobs.set(project, projectJobs);
    }
    projectJobs.set(job.id, job);
  }

  getJob(project: string, gateId: string): MonitoredJob | null {
    return this.jobs.get(project)?.get(gateId) ?? null;
  }

  deleteJob(project: string, gateId: string): void {
    this.jobs.get(project)?.delete(gateId);
  }

  listJobs(project: string): MonitoredJob[] {
    return [...(this.jobs.get(project)?.values() ?? [])];
  }

  // ============ MACHINES ============

  putMachine(project: string, machine: MachineState): void {
    let projectMachines = this.machines.get(project);
    if (!projectMachines) {
      projectMachines = new Map();
      this.machines.set(project, projectMachines);
    }
    projectMachines.set(machine.id, machine);
  }

  getMachine(project: string, machineId: string): MachineState | null {
    return this.machines.get(project)?.get(machineId) ?? null;
  }

  listMachines(project: string): MachineState[] {
    return [...(this.machines.get(project)?.values() ?? [])];
  }

  // ============ NOTICES ============

  addNotice(project: string, notice: InfraNotice): void {
    let projectNotices = this.notices.get(project);
    if (!projectNotices) {
      projectNotices = new Map();
      this.notices.set(project, projectNotices);
    }
    projectNotices.set(notice.finding.key, notice);
  }

  getNotice(project: string, key: string): InfraNotice | null {
    return this.notices.get(project)?.get(key) ?? null;
  }

  updateNotice(project: string, key: string, updates: Partial<InfraNotice>): void {
    const notice = this.getNotice(project, key);
    if (notice) {
      Object.assign(notice, updates);
    }
  }

  deleteNotice(project: string, key: string): void {
    this.notices.get(project)?.delete(key);
  }

  listNotices(project: string): InfraNotice[] {
    return [...(this.notices.get(project)?.values() ?? [])];
  }

  // ============ NOTIFICATION DEDUP ============

  /**
   * Check if a finding has already been notified in this session.
   * Returns true if already notified, false if this is the first time.
   */
  hasNotified(project: string, key: string): boolean {
    return this.notifiedKeys.get(project)?.has(key) ?? false;
  }

  /**
   * Mark a finding as notified.
   */
  markNotified(project: string, key: string): void {
    let projectKeys = this.notifiedKeys.get(project);
    if (!projectKeys) {
      projectKeys = new Set();
      this.notifiedKeys.set(project, projectKeys);
    }
    projectKeys.add(key);
  }

  /**
   * Clear notification for a finding (when it's resolved).
   */
  clearNotified(project: string, key: string): void {
    this.notifiedKeys.get(project)?.delete(key);
  }

  // ============ CLEANUP ============

  clearProject(project: string): void {
    this.jobs.delete(project);
    this.machines.delete(project);
    this.notices.delete(project);
    this.notifiedKeys.delete(project);
  }
}
