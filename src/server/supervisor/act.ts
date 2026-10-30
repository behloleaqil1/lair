/**
 * Supervisor S3: acting fixes by evidence (deterministic-first).
 *
 * The causes are found by code (act-detectors.ts), acting ops re-check the
 * evidence when they act (act-ops.ts), and every action is audited
 * (SupervisorStore).
 *
 * docs/design/supervisor.md "Phases" S3: the allowlist of acting fixes.
 */
import type { Decision } from "../../shared/decision-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { AgentsStore } from "../agents/store.js";
import {
  actEnabled,
  type ActOp,
  type ActSettings,
} from "./act-config.js";
import {
  detectHoldInfra,
  detectEscalationInfra,
  detectDuplicateProposal,
  type ActEvidence,
} from "./act-detectors.js";
import { executeOp, type ActModules, type ActResult } from "./act-ops.js";
import type { SupervisorStore, ActAuditEntry } from "./store.js";

/** Rate limit state for a project */
export interface RateLimitState {
  /** Actions in the last hour */
  actionsThisHour: number;
  /** When the hour resets */
  hourResetAt: number;
  /** Cooldowns by op:target */
  cooldowns: Map<string, number>;
}

export interface ActServiceOptions {
  project: string;
  store: SupervisorStore;
  settings: () => ActSettings;
  modules: () => ActModules;
  decisions: () => DecisionProducer | null;
  agentsStore: () => AgentsStore | null;
  /** Get all planner decisions for duplicate detection */
  plannerDecisions?: () => Decision[];
  /** Get proposals for a planner decision */
  plannerProposals?: (decisionId: string) => Array<{ op: string; agent: string; task: string }>;
  /** Check gate status for escalation detection */
  checkGate?: (gateId: string) => { exists: boolean; running: boolean } | null;
  clock?: () => number;
}

export class SupervisorAct {
  private rateLimit: RateLimitState;
  private readonly clock: () => number;

  constructor(private options: ActServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.rateLimit = {
      actionsThisHour: 0,
      hourResetAt: this.clock() + 3600_000,
      cooldowns: new Map(),
    };
  }

  /** Find all conditions that can be acted on right now */
  async detect(): Promise<ActEvidence[]> {
    const settings = this.options.settings();
    if (!actEnabled(settings)) return [];

    const evidence: ActEvidence[] = [];
    const decisions = this.options.decisions?.();
    if (!decisions) return [];

    const openDecisions = decisions.openOf(this.options.project, "agents");
    const triageDecisions = decisions.openOf(this.options.project, "triage");
    const plannerDecisions = this.options.plannerDecisions?.() ?? [];
    const agentsStore = this.options.agentsStore?.();

    // Detect hold infra causes
    if (agentsStore) {
      for (const decision of openDecisions) {
        const holdEvidence = detectHoldInfra(decision, agentsStore, this.options.project);
        if (holdEvidence) evidence.push(holdEvidence);
      }
    }

    // Detect escalation infra causes
    for (const decision of triageDecisions) {
      const escalationEvidence = detectEscalationInfra(
        decision,
        this.options.checkGate ?? (() => null),
      );
      if (escalationEvidence) evidence.push(escalationEvidence);
    }

    // Detect duplicate proposals
    const getProposals = this.options.plannerProposals ?? (() => []);
    for (const decision of plannerDecisions) {
      const duplicateEvidence = detectDuplicateProposal(
        decision,
        plannerDecisions,
        getProposals,
      );
      if (duplicateEvidence) evidence.push(duplicateEvidence);
    }

    return evidence;
  }

  /** Try to act on detected evidence, respecting rate limits and cooldowns */
  async act(evidence: ActEvidence[]): Promise<ActResult[]> {
    const settings = this.options.settings();
    const now = this.clock();
    const results: ActResult[] = [];

    // Reset hour counter if needed
    if (now >= this.rateLimit.hourResetAt) {
      this.rateLimit.actionsThisHour = 0;
      this.rateLimit.hourResetAt = now + 3600_000;
    }

    for (const ev of evidence) {
      // Check rate limit
      if (this.rateLimit.actionsThisHour >= settings.max_per_hour) {
        results.push({
          op: ev.op,
          target: ev.target,
          success: false,
          detail: `rate limit exceeded (${settings.max_per_hour}/hour)`,
          evidence: ev.evidence,
          mode: settings.mode === "act" ? "act" : "observe",
        });
        continue;
      }

      // Check cooldown
      const cooldownKey = `${ev.op}:${ev.target}`;
      const cooldownUntil = this.rateLimit.cooldowns.get(cooldownKey) ?? 0;
      if (now < cooldownUntil) {
        results.push({
          op: ev.op,
          target: ev.target,
          success: false,
          detail: `in cooldown until ${new Date(cooldownUntil).toISOString()}`,
          evidence: ev.evidence,
          mode: settings.mode === "act" ? "act" : "observe",
        });
        continue;
      }

      // Execute the op
      const result = await executeOp(ev, settings, this.options.modules());
      results.push(result);

      // Record in audit
      this.audit(ev, result, now);

      // Update rate limiting on success
      if (result.success && result.mode === "act") {
        this.rateLimit.actionsThisHour++;
        this.rateLimit.cooldowns.set(cooldownKey, now + settings.cooldown_minutes * 60_000);
      }
    }

    return results;
  }

  /** Run detection and acting in one pass */
  async tick(): Promise<{ detected: ActEvidence[]; results: ActResult[] }> {
    const detected = await this.detect();
    const results = await this.act(detected);
    return { detected, results };
  }

  /** Record an action in the audit trail */
  private audit(evidence: ActEvidence, result: ActResult, now: number): void {
    const entry: ActAuditEntry = {
      id: `act-${now}-${Math.random().toString(36).slice(2, 10)}`,
      at: new Date(now).toISOString(),
      project: this.options.project,
      op: evidence.op,
      target: evidence.target,
      evidence: evidence.evidence,
      clearedCheckOutput: result.detail,
      mode: result.mode,
      result: result.success ? "success" : "failed",
      detail: result.detail,
    };

    // Store in supervisor.db
    this.options.store.recordActAudit(entry);
  }

  /** Get recent acting audit entries */
  getAuditHistory(limit = 20): ActAuditEntry[] {
    return this.options.store.getActAuditHistory(this.options.project, limit);
  }

  /** Get counts for the UI */
  getCounts(): { wouldAct: number; acted: number; failed: number } {
    return this.options.store.getActCounts(this.options.project);
  }

  /** Check if a fix that didn't work comes back (for escalation) */
  checkRepeat(op: ActOp, target: string): boolean {
    const now = this.clock();
    const cooldownKey = `${op}:${target}`;
    const cooldownUntil = this.rateLimit.cooldowns.get(cooldownKey) ?? 0;

    // If we're still in cooldown and the same condition appears, it's a repeat
    if (now < cooldownUntil) {
      // A fix that didn't work escalates as a notice instead of repeating
      return true;
    }
    return false;
  }
}

export { ActEvidence, ActResult };
