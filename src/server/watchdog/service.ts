/**
 * Watchdog Service - coordinates SLO monitoring and playbook execution
 */
import type { EventBus } from "../core/event-bus.js";
import type { Store } from "../store/store.js";
import { WatchdogStore } from "./store.js";
import { runDetector, type DetectorContext } from "./detectors.js";
import { PlaybookEngine } from "./playbook-engine.js";
import { builtInPlaybooks } from "./playbooks.js";
import type {
  SLODefinition,
  SLOState,
  SLOBreach,
  SLOType,
  HealthSummary,
} from "./types.js";

/**
 * Default SLO definitions (SPEC-autonomy §2)
 */
const DEFAULT_SLOS: SLODefinition[] = [
  {
    id: "merge-frequency",
    name: "Merge Frequency",
    description: "A merge to the default branch at least every 6h while tasks are ready",
    projectId: null,
    enabled: true,
    threshold: 6,
    unit: "hours",
    type: "merge-frequency",
    condition: "tasks ready",
  },
  {
    id: "gate-frequency",
    name: "Gate Frequency",
    description: "A passing gate at least every 3h while gates run",
    projectId: null,
    enabled: true,
    threshold: 3,
    unit: "hours",
    type: "gate-frequency",
    condition: "gates running",
  },
  {
    id: "agent-progress",
    name: "Agent Progress",
    description: "Every running agent shows progress (commit, gate, review, WAITING heartbeat) every 45 min",
    projectId: null,
    enabled: true,
    threshold: 45,
    unit: "minutes",
    type: "agent-progress",
  },
  {
    id: "lane-busy",
    name: "Lane Busy Limit",
    description: "No queue lane stays busy for more than 3× its median job time",
    projectId: null,
    enabled: true,
    threshold: 3,
    unit: "count",
    type: "lane-busy",
  },
  {
    id: "idle-capacity",
    name: "Idle Capacity",
    description: "Every idle machine with free capacity is used within 10 min while work is queued",
    projectId: null,
    enabled: true,
    threshold: 10,
    unit: "minutes",
    type: "idle-capacity",
    condition: "work queued",
  },
  {
    id: "branch-green",
    name: "Branch Green",
    description: "The default branch is green",
    projectId: null,
    enabled: true,
    threshold: 1,
    unit: "count",
    type: "branch-green",
  },
];

/**
 * Watchdog Service
 */
export class WatchdogService {
  private watchdogStore: WatchdogStore;
  private playbookEngine: PlaybookEngine;
  private checkInterval: NodeJS.Timeout | null = null;
  private detectorContext: DetectorContext;

  constructor(
    private eventBus: EventBus,
    private store: Store,
    private db: any // Database instance
  ) {
    this.watchdogStore = new WatchdogStore(db);
    this.playbookEngine = new PlaybookEngine(eventBus, store, this.watchdogStore);

    this.detectorContext = {
      eventBus,
      store,
      watchdogStore: this.watchdogStore,
    };
  }

  /**
   * Initialize the watchdog service
   */
  async initialize(): Promise<void> {
    // Initialize schema
    this.watchdogStore.initialize();

    // Register default SLOs
    for (const slo of DEFAULT_SLOS) {
      this.watchdogStore.upsertSLODefinition(slo);
    }

    // Register built-in playbooks
    for (const playbook of builtInPlaybooks) {
      this.playbookEngine.registerPlaybook(playbook);
    }

    // Subscribe to decision answers
    this.eventBus.on("decision.answered", async (event) => {
      if (event.data.breachId && event.data.playbookId) {
        await this.playbookEngine.handleApproval(
          event.data.breachId as string,
          event.data.playbookId as string,
          event.data.answer === "approve"
        );
      }
    });

    console.log("[Watchdog] Initialized with", DEFAULT_SLOS.length, "SLOs and", builtInPlaybooks.length, "playbooks");
  }

  /**
   * Start the watchdog check loop
   */
  start(intervalMs = 60000): void {
    if (this.checkInterval) {
      return;
    }

    // Run immediately
    this.runChecks().catch(err => {
      console.error("[Watchdog] Check error:", err);
    });

    // Then on interval
    this.checkInterval = setInterval(() => {
      this.runChecks().catch(err => {
        console.error("[Watchdog] Check error:", err);
      });
    }, intervalMs);

    console.log("[Watchdog] Started with interval", intervalMs, "ms");
  }

  /**
   * Stop the watchdog check loop
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[Watchdog] Stopped");
  }

  /**
   * Run all SLO checks
   */
  async runChecks(): Promise<void> {
    const slos = this.watchdogStore.getEnabledSLODefinitions();
    const now = new Date().toISOString();

    for (const slo of slos) {
      try {
        const result = await runDetector(slo, this.detectorContext);

        // Get previous state
        const previousState = this.watchdogStore.getSLOState(slo.id);

        // Update state
        const newState: SLOState = {
          sloId: slo.id,
          status: result.status,
          currentValue: result.currentValue,
          threshold: slo.threshold,
          stateChangedAt: previousState?.status !== result.status ? now : (previousState?.stateChangedAt ?? now),
          evidence: result.evidence,
          lastCheckedAt: now,
        };
        this.watchdogStore.updateSLOState(newState);

        // Handle state transitions
        if (result.status === "breached" && previousState?.status !== "breached") {
          await this.handleNewBreach(slo, result.currentValue, result.evidence);
        } else if (result.status !== "breached" && previousState?.status === "breached") {
          await this.handleRecovery(slo);
        }
      } catch (error) {
        console.error(`[Watchdog] Error checking SLO ${slo.id}:`, error);
      }
    }
  }

  /**
   * Handle a new SLO breach
   */
  private async handleNewBreach(
    slo: SLODefinition,
    value: number,
    evidence: string[]
  ): Promise<void> {
    const breachId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create breach record
    const breach = this.watchdogStore.createBreach({
      id: breachId,
      sloId: slo.id,
      detectedAt: now,
      evidence,
      value,
      threshold: slo.threshold,
    });

    // Emit event
    await this.eventBus.emit("slo.breached", {
      sloId: slo.id,
      sloName: slo.name,
      threshold: slo.threshold,
      actual: value,
      evidence,
      breachId,
    });

    console.log(`[Watchdog] SLO breached: ${slo.id} (${value} > ${slo.threshold})`);

    // Trigger playbooks
    await this.playbookEngine.handleBreach(breach, slo.type);
  }

  /**
   * Handle SLO recovery
   */
  private async handleRecovery(slo: SLODefinition): Promise<void> {
    // Find active breaches and resolve them
    const activeBreaches = this.watchdogStore.getActiveBreaches()
      .filter(b => b.sloId === slo.id);

    for (const breach of activeBreaches) {
      this.watchdogStore.resolveBreach(breach.id);

      await this.eventBus.emit("slo.recovered", {
        sloId: slo.id,
        breachId: breach.id,
      });

      console.log(`[Watchdog] SLO recovered: ${slo.id}`);
    }
  }

  /**
   * Get health summary for the UI
   */
  getHealthSummary(): HealthSummary {
    const states = this.watchdogStore.getAllSLOStates();
    const activeBreaches = this.watchdogStore.getActiveBreaches();
    const recentRuns = this.watchdogStore.getRecentRuns(10);

    const slosByStatus = {
      healthy: states.filter(s => s.status === "healthy").length,
      warning: states.filter(s => s.status === "warning").length,
      breached: states.filter(s => s.status === "breached").length,
    };

    let overall: "healthy" | "warning" | "critical";
    if (slosByStatus.breached > 0) {
      overall = "critical";
    } else if (slosByStatus.warning > 0) {
      overall = "warning";
    } else {
      overall = "healthy";
    }

    return {
      overall,
      slosByStatus,
      activeBreaches,
      recentPlaybookRuns: recentRuns,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get SLO definitions
   */
  getSLODefinitions(): SLODefinition[] {
    return this.watchdogStore.getAllSLODefinitions();
  }

  /**
   * Get SLO state by ID
   */
  getSLOState(sloId: string): SLOState | null {
    return this.watchdogStore.getSLOState(sloId);
  }

  /**
   * Get all SLO states
   */
  getAllSLOStates(): SLOState[] {
    return this.watchdogStore.getAllSLOStates();
  }

  /**
   * Update an SLO definition
   */
  updateSLODefinition(slo: SLODefinition): void {
    this.watchdogStore.upsertSLODefinition(slo);
  }

  /**
   * Get breach history for an SLO
   */
  getBreachHistory(sloId: string, limit = 10): SLOBreach[] {
    return this.watchdogStore.getBreachesForSLO(sloId, limit);
  }

  /**
   * Get playbook run details
   */
  getPlaybookRun(runId: string) {
    return this.watchdogStore.getPlaybookRun(runId);
  }
}
