/**
 * Event types for the Lair event bus.
 *
 * This file is append-only: new events are added at the end.
 * Each module adds its own events here.
 *
 * Naming: <module>.<action> or <entity>.<action>
 */

// ============ Core events (from server-types.ts, moved here for consistency) ============
export type CoreEventType =
  | "node.registered"
  | "node.heartbeat"
  | "node.offline"
  | "node.online"
  | "task.created"
  | "task.assigned"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "job.created"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "scheduler.tick";

// ============ Watchdog events (SPEC-autonomy §2) ============
export type WatchdogEventType =
  | "slo.breached"           // An SLO threshold was exceeded
  | "slo.recovered"          // An SLO that was breached is now healthy
  | "playbook.started"       // A recovery playbook started running
  | "playbook.step.completed" // A playbook step completed
  | "playbook.succeeded"     // A recovery playbook completed successfully
  | "playbook.failed"        // A recovery playbook failed
  | "health.check.completed" // A health check was completed
  | "agent.hung"             // An agent is detected as hung (no CPU, no output)
  | "agent.waiting"          // An agent is waiting (children busy, or explicit WAITING)
  | "agent.recovered"        // A hung agent was recovered
  | "lane.jammed"            // A gate lane has been blocked too long
  | "lane.cleared"           // A jammed lane was cleared
  | "escalation.created"     // Escalation sent to decisions module
  | "escalation.acknowledged" // Escalation was acknowledged
  | "escalation.resolved";   // Escalation was resolved

// ============ Decisions events (SPEC-autonomy §1) ============
export type DecisionsEventType =
  | "decision.requested"     // A module or agent raised a decision
  | "decision.answered"      // The owner answered a decision
  | "decision.timeout";      // A decision timed out

// ============ All event types ============
export type EventType = CoreEventType | WatchdogEventType | DecisionsEventType;

/**
 * Event payload types for type-safe event handling
 */
export interface SLOBreachedEvent {
  sloId: string;
  sloName: string;
  threshold: number;
  actual: number;
  evidence: string[];
}

export interface PlaybookStartedEvent {
  playbookId: string;
  diagnosisId?: string;
  triggeredBy: string;
}

export interface PlaybookStepCompletedEvent {
  playbookId: string;
  stepId: string;
  succeeded: boolean;
  output?: string;
  error?: string;
}

export interface PlaybookCompletedEvent {
  playbookId: string;
  succeeded: boolean;
  stepsCompleted: number;
  duration: number;
  error?: string;
}

export interface AgentStateEvent {
  agentId: string;
  nodeId: string;
  state: "hung" | "waiting" | "active";
  idleSeconds?: number;
  reason?: string;
}

export interface EscalationEvent {
  escalationId: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  diagnosisId?: string;
}
