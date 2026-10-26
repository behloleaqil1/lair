/**
 * Built-in playbooks: one per detector. Each one diagnoses (re-checks the
 * breach on fresh probe data), acts (runs the project's configured command)
 * and verifies. The steps are data; the executors that run them are in
 * executors.ts.
 */
import type { DetectorId, PlaybookDefinition, PlaybookId } from "./types.js";

const DEFAULTS = { act: false, maxAttempts: 2, cooldownMinutes: 10, verifyDelaySeconds: 0 };

export const BUILTIN_PLAYBOOKS: PlaybookDefinition[] = [
  {
    id: "stale_lock",
    name: "Break a stale lock",
    description:
      "The lock's recorded holder is dead (or it has no holder and is past its lease) while agents wait: break it.",
    detector: "lock_holder_dead",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "break-lock", type: "act", action: "break_lock" },
      { id: "verify", type: "verify", check: "recheck" },
    ],
    defaults: DEFAULTS,
  },
  {
    id: "duplicate_agent",
    name: "Stop a duplicate agent process",
    description:
      "Two or more processes run for one agent id: stop the newer ones and keep the oldest.",
    detector: "duplicate_agent",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "stop-duplicate", type: "act", action: "stop_duplicate" },
      { id: "verify", type: "verify", check: "recheck" },
    ],
    defaults: { ...DEFAULTS, verifyDelaySeconds: 5 },
  },
  {
    id: "agent_stuck",
    name: "Restart a hung agent",
    description:
      "The agent's process is alive but its log has not changed, and it is not WAITING on a gate: restart it in a fresh session. A WAITING agent is never restarted.",
    detector: "agent_hung",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "restart-agent", type: "act", action: "restart_agent" },
      { id: "verify", type: "verify", check: "agent_restarted" },
    ],
    defaults: { ...DEFAULTS, verifyDelaySeconds: 30 },
  },
  {
    id: "orphan_claim",
    name: "Release an orphaned claim",
    description:
      "A claim whose agent has no live process: release it. A live agent's claim is never touched.",
    detector: "orphan_claim",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "release-claim", type: "act", action: "release_claim" },
      { id: "verify", type: "verify", check: "recheck" },
    ],
    defaults: DEFAULTS,
  },
  {
    id: "lane_broken",
    name: "Mark a lane broken",
    description:
      "The same failure in finished gates of different tracks on one lane: the lane or its node is broken, not the code. Mark it so work goes elsewhere.",
    detector: "infra_signature",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "mark-lane-broken", type: "act", action: "mark_lane_broken" },
      { id: "verify", type: "verify", check: "deferred" },
    ],
    defaults: { ...DEFAULTS, maxAttempts: 1, cooldownMinutes: 60 },
  },
  {
    id: "gate_owner_gone",
    name: "Requeue an orphaned gate",
    description:
      "A running gate whose runner process is dead and whose log is silent past its lease: requeue it.",
    detector: "gate_owner_gone",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "requeue-gate", type: "act", action: "requeue_gate" },
      { id: "verify", type: "verify", check: "recheck" },
    ],
    defaults: DEFAULTS,
  },
  {
    id: "idle_capacity",
    name: "Use idle capacity",
    description:
      "Ready work and free capacity, and nothing started for a while: ask the project to start work.",
    detector: "idle_capacity",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "fill-capacity", type: "act", action: "fill_capacity" },
      { id: "verify", type: "verify", check: "deferred" },
    ],
    defaults: DEFAULTS,
  },
  {
    id: "no_merges",
    name: "Triage a progress stall",
    description:
      "No merge for hours while work is queued: run the project's triage command, then escalate with its output if merges don't resume.",
    detector: "progress_stall",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "triage", type: "act", action: "triage_stall" },
      { id: "verify", type: "verify", check: "deferred" },
    ],
    defaults: { ...DEFAULTS, maxAttempts: 1, cooldownMinutes: 60 },
  },
  {
    id: "crash_loop",
    name: "Stop a container crash loop",
    description:
      "A container's restart count keeps rising: stop its automatic restarts so it can be looked at.",
    detector: "crash_loop",
    priority: 10,
    steps: [
      { id: "diagnose", type: "diagnose" },
      { id: "stop-restarts", type: "act", action: "stop_container_restarts" },
      { id: "verify", type: "verify", check: "deferred" },
    ],
    defaults: { ...DEFAULTS, maxAttempts: 1, cooldownMinutes: 30 },
  },
];

/** The playbooks for a detector, in priority order. */
export function playbooksFor(detector: DetectorId): PlaybookDefinition[] {
  return BUILTIN_PLAYBOOKS.filter((p) => p.detector === detector).sort(
    (a, b) => a.priority - b.priority,
  );
}

export function getPlaybook(id: PlaybookId): PlaybookDefinition | undefined {
  return BUILTIN_PLAYBOOKS.find((p) => p.id === id);
}
