/**
 * Lair Self-Diagnostics Engine
 * 
 * Detects, diagnoses, and recovers from common failures automatically.
 * See SPEC-diagnostics.md for full specification.
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import type {
  Diagnosis,
  DiagnosticsConfig,
  DiagnosticsEvent,
  Escalation,
  Evidence,
  HealthStatus,
  PlaybookCondition,
  RecoveryAttempt,
  RecoveryPlaybook,
  RecoveryStep,
  StepResult,
  SuggestedAction,
} from './types.js';
import { matchPatterns, getMostSevere } from './patterns.js';
import { getPlaybook } from './playbooks.js';

const execAsync = promisify(exec);

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DiagnosticsConfig = {
  enabled: true,
  checkIntervalSeconds: 30,
  silentThresholdMinutes: 45,
  crashLoopThreshold: 3,
  crashLoopWindowMinutes: 10,
  systemicFailureThreshold: 0.5,
  autoRecoveryEnabled: true,
  escalationChannels: ['in-app'],
};

/**
 * The main diagnostics engine
 */
export class DiagnosticsEngine extends EventEmitter {
  private config: DiagnosticsConfig;
  private diagnoses: Map<string, Diagnosis> = new Map();
  private recoveries: Map<string, RecoveryAttempt> = new Map();
  private escalations: Map<string, Escalation> = new Map();
  private healthCache: Map<string, HealthStatus> = new Map();
  private checkInterval?: ReturnType<typeof setInterval>;
  private runningPlaybooks: Set<string> = new Set();
  private projectPath?: string;

  constructor(config: Partial<DiagnosticsConfig> = {}, projectPath?: string) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.projectPath = projectPath;
  }

  /**
   * Start the diagnostics engine
   */
  start(): void {
    if (!this.config.enabled) return;
    
    console.log('[diagnostics] Starting diagnostics engine');
    
    // Run initial check
    this.runHealthChecks();
    
    // Schedule periodic checks
    this.checkInterval = setInterval(
      () => this.runHealthChecks(),
      this.config.checkIntervalSeconds * 1000
    );
  }

  /**
   * Stop the diagnostics engine
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    console.log('[diagnostics] Stopped diagnostics engine');
  }

  /**
   * Run all health checks
   */
  async runHealthChecks(): Promise<HealthStatus[]> {
    const statuses: HealthStatus[] = [];
    
    // Check Docker
    statuses.push(await this.checkDocker());
    
    // Check network
    statuses.push(await this.checkNetwork());
    
    return statuses;
  }

  /**
   * Check Docker health
   */
  async checkDocker(): Promise<HealthStatus> {
    const status: HealthStatus = {
      component: 'docker',
      healthy: true,
      lastCheck: new Date(),
      issues: [],
    };

    try {
      await execAsync('docker ps', { timeout: 10000 });
    } catch (error) {
      status.healthy = false;
      status.issues.push('Docker daemon not responding');
      
      // Create diagnosis
      const diagnosis = await this.diagnose({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'log',
        source: 'docker-health-check',
        content: String(error),
        timestamp: new Date(),
      });
      
      if (diagnosis) {
        status.activeDiagnosis = diagnosis.id;
      }
    }

    this.healthCache.set('docker', status);
    return status;
  }

  /**
   * Check network health
   */
  async checkNetwork(): Promise<HealthStatus> {
    const status: HealthStatus = {
      component: 'network',
      healthy: true,
      lastCheck: new Date(),
      issues: [],
    };

    try {
      await execAsync('curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://api.anthropic.com', { timeout: 15000 });
    } catch (error) {
      status.healthy = false;
      status.issues.push('Cannot reach model API');
    }

    this.healthCache.set('network', status);
    return status;
  }

  /**
   * Diagnose a failure from evidence
   */
  async diagnose(evidence: Evidence): Promise<Diagnosis | null> {
    const id = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    this.emitEvent('diagnosis.started', { id, evidence });
    
    // Match against known patterns
    const matchedPatterns = matchPatterns(evidence.content);
    const bestMatch = getMostSevere(matchedPatterns);
    
    if (!bestMatch) {
      // No pattern matched - could escalate to AI diagnosis
      console.log(`[diagnostics] No pattern matched for evidence from ${evidence.source}`);
      return null;
    }
    
    evidence.matchedPatterns = matchedPatterns.map(p => p.id);
    
    const diagnosis: Diagnosis = {
      id,
      timestamp: new Date(),
      state: 'investigating',
      patternId: bestMatch.id,
      patternName: bestMatch.name,
      category: bestMatch.category,
      severity: bestMatch.severity,
      evidence: [evidence],
      affected: [],
      rootCause: bestMatch.description,
      recommendedAction: bestMatch.escalationTemplate,
      autoRecoverable: bestMatch.autoRecoverable,
    };
    
    this.diagnoses.set(id, diagnosis);
    
    console.log(`[diagnostics] Diagnosed: ${bestMatch.name} (${bestMatch.severity})`);
    
    // Attempt auto-recovery if enabled and pattern allows it
    if (this.config.autoRecoveryEnabled && bestMatch.autoRecoverable && bestMatch.recoveryPlaybookId) {
      const playbook = getPlaybook(bestMatch.recoveryPlaybookId);
      if (playbook) {
        await this.attemptRecovery(diagnosis, playbook);
      }
    } else if (!bestMatch.autoRecoverable) {
      // Escalate immediately
      await this.escalate(diagnosis);
    }
    
    this.emitEvent('diagnosis.completed', { diagnosis });
    
    return diagnosis;
  }

  /**
   * Diagnose a gate failure
   */
  async diagnoseGateFailure(gateId: string, logPath: string): Promise<Diagnosis | null> {
    try {
      const content = await readFile(logPath, 'utf-8');
      const evidence: Evidence = {
        id: `ev-${Date.now()}`,
        type: 'log',
        source: `gate:${gateId}`,
        content: content.slice(-50000), // Last 50KB
        timestamp: new Date(),
      };
      
      const diagnosis = await this.diagnose(evidence);
      
      if (diagnosis) {
        diagnosis.affected.push({
          type: 'gate',
          id: gateId,
        });
      }
      
      return diagnosis;
    } catch (error) {
      console.error(`[diagnostics] Failed to read gate log: ${error}`);
      return null;
    }
  }

  /**
   * Diagnose an agent failure
   */
  async diagnoseAgentFailure(agentId: string, logPath?: string, exitCode?: number): Promise<Diagnosis | null> {
    let content = `Agent ${agentId} failed`;
    
    if (logPath) {
      try {
        const logContent = await readFile(logPath, 'utf-8');
        content = logContent.slice(-20000); // Last 20KB
      } catch (error) {
        // Log file not available
      }
    }
    
    if (exitCode !== undefined) {
      content += `\nExit code: ${exitCode}`;
    }
    
    const evidence: Evidence = {
      id: `ev-${Date.now()}`,
      type: 'log',
      source: `agent:${agentId}`,
      content,
      timestamp: new Date(),
    };
    
    const diagnosis = await this.diagnose(evidence);
    
    if (diagnosis) {
      diagnosis.affected.push({
        type: 'agent',
        id: agentId,
      });
    }
    
    return diagnosis;
  }

  /**
   * Attempt recovery using a playbook
   */
  async attemptRecovery(diagnosis: Diagnosis, playbook: RecoveryPlaybook): Promise<RecoveryAttempt> {
    const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // Check if this playbook is already running
    if (this.runningPlaybooks.has(playbook.id)) {
      console.log(`[diagnostics] Playbook ${playbook.id} already running, skipping`);
      return {
        id,
        playbookId: playbook.id,
        diagnosisId: diagnosis.id,
        startedAt: new Date(),
        state: 'failed',
        stepsCompleted: [],
        error: 'Playbook already running',
      };
    }
    
    // Check preconditions
    for (const cond of playbook.preconditions) {
      const met = await this.checkPrecondition(cond);
      if (!met) {
        console.log(`[diagnostics] Precondition ${cond.type} not met for ${playbook.id}`);
        return {
          id,
          playbookId: playbook.id,
          diagnosisId: diagnosis.id,
          startedAt: new Date(),
          state: 'failed',
          stepsCompleted: [],
          error: `Precondition not met: ${cond.type}`,
        };
      }
    }
    
    // Check if approval is required
    if (playbook.requiresApproval) {
      diagnosis.state = 'escalated';
      await this.escalate(diagnosis, playbook);
      return {
        id,
        playbookId: playbook.id,
        diagnosisId: diagnosis.id,
        startedAt: new Date(),
        state: 'pending',
        stepsCompleted: [],
      };
    }
    
    this.runningPlaybooks.add(playbook.id);
    diagnosis.state = 'recovering';
    
    const attempt: RecoveryAttempt = {
      id,
      playbookId: playbook.id,
      diagnosisId: diagnosis.id,
      startedAt: new Date(),
      state: 'running',
      stepsCompleted: [],
    };
    
    this.recoveries.set(id, attempt);
    this.emitEvent('recovery.started', { attempt, playbook });
    
    console.log(`[diagnostics] Starting recovery: ${playbook.name}`);
    
    try {
      // Execute steps
      for (const step of playbook.steps) {
        const result = await this.executeStep(step, diagnosis);
        attempt.stepsCompleted.push(result);
        
        this.emitEvent('recovery.step.completed', { attempt, step, result });
        
        if (!result.succeeded && !step.continueOnFail) {
          throw new Error(`Step ${step.id} failed: ${result.error}`);
        }
      }
      
      attempt.state = 'succeeded';
      attempt.completedAt = new Date();
      diagnosis.state = 'resolved';
      
      console.log(`[diagnostics] Recovery succeeded: ${playbook.name}`);
      this.emitEvent('recovery.succeeded', { attempt });
      
    } catch (error) {
      attempt.state = 'failed';
      attempt.completedAt = new Date();
      attempt.error = String(error);
      
      console.error(`[diagnostics] Recovery failed: ${playbook.name} - ${error}`);
      this.emitEvent('recovery.failed', { attempt, error: String(error) });
      
      // Escalate on failure
      await this.escalate(diagnosis, playbook, [attempt]);
      
    } finally {
      this.runningPlaybooks.delete(playbook.id);
    }
    
    return attempt;
  }

  /**
   * Execute a single recovery step
   */
  private async executeStep(step: RecoveryStep, diagnosis: Diagnosis): Promise<StepResult> {
    const startedAt = new Date();
    
    try {
      switch (step.action) {
        case 'shell': {
          if (!step.command) throw new Error('Shell step missing command');
          const { stdout, stderr } = await execAsync(step.command, {
            timeout: step.timeoutSeconds * 1000,
            cwd: this.projectPath,
          });
          return {
            stepId: step.id,
            startedAt,
            completedAt: new Date(),
            succeeded: true,
            output: stdout || stderr,
          };
        }
          
        case 'wait': {
          const seconds = Number(step.params?.seconds) || 5;
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          return {
            stepId: step.id,
            startedAt,
            completedAt: new Date(),
            succeeded: true,
          };
        }
          
        case 'notify':
          console.log(`[diagnostics] NOTIFY: ${step.params?.message || diagnosis.rootCause}`);
          return {
            stepId: step.id,
            startedAt,
            completedAt: new Date(),
            succeeded: true,
          };
          
        case 'restart-agent':
        case 'restart-gate':
        case 'drain-node':
        case 'api':
          // These would integrate with the broader Lair system
          console.log(`[diagnostics] Would execute: ${step.action} ${JSON.stringify(step.params)}`);
          return {
            stepId: step.id,
            startedAt,
            completedAt: new Date(),
            succeeded: true,
            output: `Simulated: ${step.action}`,
          };
          
        default:
          throw new Error(`Unknown step action: ${step.action}`);
      }
    } catch (error) {
      return {
        stepId: step.id,
        startedAt,
        completedAt: new Date(),
        succeeded: false,
        error: String(error),
      };
    }
  }

  /**
   * Check a playbook precondition
   */
  private async checkPrecondition(cond: PlaybookCondition): Promise<boolean> {
    switch (cond.type) {
      case 'not-running':
        return !this.runningPlaybooks.has(cond.target || '');
        
      case 'docker-running':
        try {
          await execAsync('docker ps', { timeout: 5000 });
          return true;
        } catch {
          return false;
        }
        
      case 'node-reachable':
        // Would check SSH connectivity
        return true;
        
      default:
        return true;
    }
  }

  /**
   * Escalate a diagnosis to the owner
   */
  async escalate(
    diagnosis: Diagnosis,
    attemptedPlaybook?: RecoveryPlaybook,
    attemptedRecoveries: RecoveryAttempt[] = []
  ): Promise<Escalation> {
    const id = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    diagnosis.state = 'escalated';
    
    const suggestedActions: SuggestedAction[] = [];
    
    // If there's a playbook that requires approval, suggest it
    if (attemptedPlaybook?.requiresApproval) {
      suggestedActions.push({
        id: 'approve-playbook',
        label: `Run: ${attemptedPlaybook.name}`,
        description: attemptedPlaybook.description,
        type: 'approve-playbook',
        playbookId: attemptedPlaybook.id,
        destructive: true,
      });
    }
    
    // Suggest dismissing if it might be a false positive
    suggestedActions.push({
      id: 'dismiss',
      label: 'Dismiss',
      description: 'Mark as not-a-problem (will not alert again for this instance)',
      type: 'dismiss',
    });
    
    // Suggest pausing work
    suggestedActions.push({
      id: 'pause',
      label: 'Pause all work',
      description: 'Stop submitting new gates and starting new agent runs',
      type: 'pause',
    });
    
    const escalation: Escalation = {
      id,
      timestamp: new Date(),
      severity: diagnosis.severity,
      title: diagnosis.patternName || 'Unknown failure',
      description: diagnosis.recommendedAction || diagnosis.rootCause || 'No description available',
      diagnosisId: diagnosis.id,
      diagnosis,
      attemptedRecoveries,
      suggestedActions,
      affectedWork: diagnosis.affected,
      state: 'pending',
    };
    
    this.escalations.set(id, escalation);
    
    console.log(`[diagnostics] ESCALATION: ${escalation.title} (${escalation.severity})`);
    
    this.emitEvent('escalation.created', { escalation });
    
    return escalation;
  }

  /**
   * Acknowledge an escalation
   */
  acknowledgeEscalation(id: string): Escalation | undefined {
    const escalation = this.escalations.get(id);
    if (escalation && escalation.state === 'pending') {
      escalation.state = 'acknowledged';
      escalation.acknowledgedAt = new Date();
      this.emitEvent('escalation.acknowledged', { escalation });
    }
    return escalation;
  }

  /**
   * Resolve an escalation
   */
  resolveEscalation(id: string, resolution: string): Escalation | undefined {
    const escalation = this.escalations.get(id);
    if (escalation) {
      escalation.state = 'resolved';
      escalation.resolvedAt = new Date();
      escalation.resolution = resolution;
      
      // Also resolve the diagnosis
      const diagnosis = this.diagnoses.get(escalation.diagnosisId);
      if (diagnosis) {
        diagnosis.state = 'resolved';
      }
      
      this.emitEvent('escalation.resolved', { escalation });
    }
    return escalation;
  }

  /**
   * Dismiss an escalation
   */
  dismissEscalation(id: string): Escalation | undefined {
    const escalation = this.escalations.get(id);
    if (escalation) {
      escalation.state = 'dismissed';
      escalation.resolvedAt = new Date();
      escalation.resolution = 'Dismissed by owner';
      this.emitEvent('escalation.resolved', { escalation });
    }
    return escalation;
  }

  /**
   * Run a playbook that was awaiting approval
   */
  async approvePlaybook(escalationId: string, playbookId: string): Promise<RecoveryAttempt | null> {
    const escalation = this.escalations.get(escalationId);
    if (!escalation) return null;
    
    const playbook = getPlaybook(playbookId);
    if (!playbook) return null;
    
    const diagnosis = this.diagnoses.get(escalation.diagnosisId);
    if (!diagnosis) return null;
    
    // Create a non-approval-required copy for this execution
    const playbookCopy = { ...playbook, requiresApproval: false };
    
    return this.attemptRecovery(diagnosis, playbookCopy);
  }

  /**
   * Get all active diagnoses
   */
  getActiveDiagnoses(): Diagnosis[] {
    return Array.from(this.diagnoses.values()).filter(
      d => d.state === 'investigating' || d.state === 'recovering'
    );
  }

  /**
   * Get all pending escalations
   */
  getPendingEscalations(): Escalation[] {
    return Array.from(this.escalations.values()).filter(
      e => e.state === 'pending'
    );
  }

  /**
   * Get health status for all components
   */
  getHealthStatuses(): HealthStatus[] {
    return Array.from(this.healthCache.values());
  }

  /**
   * Check if a component is healthy
   */
  isHealthy(component: string, id?: string): boolean {
    const key = id ? `${component}:${id}` : component;
    const status = this.healthCache.get(key);
    return status?.healthy ?? true; // Default to healthy if unknown
  }

  /**
   * Get a diagnosis by ID
   */
  getDiagnosis(id: string): Diagnosis | undefined {
    return this.diagnoses.get(id);
  }

  /**
   * Get an escalation by ID
   */
  getEscalation(id: string): Escalation | undefined {
    return this.escalations.get(id);
  }

  /**
   * Emit a typed event
   */
  private emitEvent(type: DiagnosticsEvent['type'], data: Record<string, unknown>): void {
    const event: DiagnosticsEvent = {
      type,
      timestamp: new Date(),
      data,
    };
    this.emit(type, event);
    this.emit('diagnostics', event);
  }
}

// Export singleton for use by the server
let instance: DiagnosticsEngine | null = null;

export function getDiagnosticsEngine(config?: Partial<DiagnosticsConfig>, projectPath?: string): DiagnosticsEngine {
  if (!instance) {
    instance = new DiagnosticsEngine(config, projectPath);
  }
  return instance;
}

export function resetDiagnosticsEngine(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}

// Re-export types
export * from './types.js';
export { ALL_PATTERNS, matchPatterns, getPattern } from './patterns.js';
export { ALL_PLAYBOOKS, getPlaybook, getPlaybooksForPattern } from './playbooks.js';
