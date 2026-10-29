/**
 * Lair Self-Diagnostics Types
 * See SPEC-diagnostics.md for full specification
 */

export type FailureCategory = 'infra' | 'agent' | 'gate' | 'systemic';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type DiagnosisState = 'investigating' | 'recovering' | 'escalated' | 'resolved';
export type RecoveryState = 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled-back';

/**
 * A diagnostic pattern that matches known failure types
 */
export interface DiagnosticPattern {
  id: string;
  name: string;
  description: string;
  category: FailureCategory;
  patterns: RegExp[];
  contextChecks?: ContextCheck[];
  severity: Severity;
  autoRecoverable: boolean;
  recoveryPlaybookId?: string;
  escalationTemplate?: string;
}

/**
 * Additional check to run when a pattern matches
 */
export interface ContextCheck {
  id: string;
  type: 'shell' | 'docker' | 'file' | 'api';
  command?: string;
  path?: string;
  expectation: 'exists' | 'not-exists' | 'contains' | 'exit-zero' | 'exit-nonzero';
  extractPattern?: RegExp;
}

/**
 * Evidence collected during diagnosis
 */
export interface Evidence {
  id: string;
  type: 'log' | 'command-output' | 'file-content' | 'metric' | 'state';
  source: string;
  content: string;
  timestamp: Date;
  matchedPatterns?: string[];
}

/**
 * A diagnosis result
 */
export interface Diagnosis {
  id: string;
  timestamp: Date;
  state: DiagnosisState;
  patternId?: string;
  patternName?: string;
  category: FailureCategory;
  severity: Severity;
  evidence: Evidence[];
  affected: AffectedEntity[];
  rootCause?: string;
  recommendedAction?: string;
  autoRecoverable: boolean;
  relatedDiagnoses?: string[];
}

/**
 * An entity affected by a failure
 */
export interface AffectedEntity {
  type: 'agent' | 'gate' | 'node' | 'task' | 'pr';
  id: string;
  name?: string;
  state?: string;
}

/**
 * A recovery playbook
 */
export interface RecoveryPlaybook {
  id: string;
  name: string;
  description: string;
  forPatterns: string[];
  preconditions: PlaybookCondition[];
  steps: RecoveryStep[];
  maxAttempts: number;
  cooldownSeconds: number;
  requiresApproval: boolean;
}

/**
 * Condition that must be true for a playbook to run
 */
export interface PlaybookCondition {
  type: 'not-running' | 'node-reachable' | 'docker-running' | 'custom';
  target?: string;
  customCheck?: ContextCheck;
}

/**
 * A step in a recovery playbook
 */
export interface RecoveryStep {
  id: string;
  name: string;
  action: 'shell' | 'api' | 'restart-agent' | 'restart-gate' | 'drain-node' | 'notify' | 'wait';
  command?: string;
  target?: string;
  params?: Record<string, unknown>;
  timeoutSeconds: number;
  rollbackStepId?: string;
  continueOnFail?: boolean;
}

/**
 * Record of a recovery attempt
 */
export interface RecoveryAttempt {
  id: string;
  playbookId: string;
  diagnosisId: string;
  startedAt: Date;
  completedAt?: Date;
  state: RecoveryState;
  stepsCompleted: StepResult[];
  error?: string;
}

/**
 * Result of a single recovery step
 */
export interface StepResult {
  stepId: string;
  startedAt: Date;
  completedAt: Date;
  succeeded: boolean;
  output?: string;
  error?: string;
}

/**
 * An escalation to the owner
 */
export interface Escalation {
  id: string;
  timestamp: Date;
  severity: Severity;
  title: string;
  description: string;
  diagnosisId: string;
  diagnosis: Diagnosis;
  attemptedRecoveries: RecoveryAttempt[];
  suggestedActions: SuggestedAction[];
  affectedWork: AffectedEntity[];
  state: 'pending' | 'acknowledged' | 'resolved' | 'dismissed';
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  resolution?: string;
}

/**
 * An action the owner can take
 */
export interface SuggestedAction {
  id: string;
  label: string;
  description: string;
  type: 'approve-playbook' | 'run-command' | 'dismiss' | 'pause' | 'resume' | 'custom';
  playbookId?: string;
  command?: string;
  destructive?: boolean;
}

/**
 * Health status for a component
 */
export interface HealthStatus {
  component: 'node' | 'agent' | 'docker' | 'network' | 'gate-runner';
  id?: string;
  healthy: boolean;
  lastCheck: Date;
  issues: string[];
  activeDiagnosis?: string;
}

/**
 * Diagnostics engine configuration
 */
export interface DiagnosticsConfig {
  enabled: boolean;
  checkIntervalSeconds: number;
  silentThresholdMinutes: number;
  crashLoopThreshold: number;
  crashLoopWindowMinutes: number;
  systemicFailureThreshold: number;
  autoRecoveryEnabled: boolean;
  escalationChannels: string[];
}

/**
 * Event emitted by the diagnostics engine
 */
export interface DiagnosticsEvent {
  type: 
    | 'diagnosis.started'
    | 'diagnosis.completed'
    | 'diagnosis.failed'
    | 'recovery.started'
    | 'recovery.step.completed'
    | 'recovery.succeeded'
    | 'recovery.failed'
    | 'escalation.created'
    | 'escalation.acknowledged'
    | 'escalation.resolved';
  timestamp: Date;
  data: Record<string, unknown>;
}
