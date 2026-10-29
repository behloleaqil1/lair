/**
 * Built-in recovery playbooks
 * See SPEC-diagnostics.md §3 for the full specification
 */

import type { RecoveryPlaybook } from './types.js';

/**
 * P1: Restart Docker daemon
 */
export const RESTART_DOCKER: RecoveryPlaybook = {
  id: 'restart-docker',
  name: 'Restart Docker Daemon',
  description: 'Restart the Docker daemon when it stops responding',
  forPatterns: ['docker-daemon-stopped'],
  preconditions: [
    { type: 'not-running', target: 'restart-docker' },
  ],
  steps: [
    {
      id: 'start-docker-macos',
      name: 'Start Docker (macOS)',
      action: 'shell',
      command: 'open -a Docker',
      timeoutSeconds: 10,
      continueOnFail: true, // Linux won't have this
    },
    {
      id: 'start-docker-linux',
      name: 'Start Docker (Linux)',
      action: 'shell',
      command: 'systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true',
      timeoutSeconds: 30,
      continueOnFail: true,
    },
    {
      id: 'wait-docker',
      name: 'Wait for Docker',
      action: 'shell',
      command: 'for i in {1..30}; do docker ps >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1',
      timeoutSeconds: 70,
    },
  ],
  maxAttempts: 2,
  cooldownSeconds: 60,
  requiresApproval: false,
};

/**
 * P2: Clear Docker resources
 */
export const CLEAR_DOCKER_RESOURCES: RecoveryPlaybook = {
  id: 'clear-docker-resources',
  name: 'Clear Docker Resources',
  description: 'Prune stopped containers and dangling images to free disk space',
  forPatterns: ['out-of-disk'],
  preconditions: [
    { type: 'docker-running' },
    { type: 'not-running', target: 'clear-docker-resources' },
  ],
  steps: [
    {
      id: 'prune-containers',
      name: 'Prune stopped containers',
      action: 'shell',
      command: 'docker container prune -f',
      timeoutSeconds: 60,
    },
    {
      id: 'prune-images',
      name: 'Prune dangling images',
      action: 'shell',
      command: 'docker image prune -f',
      timeoutSeconds: 120,
    },
    {
      id: 'prune-build-cache',
      name: 'Prune build cache',
      action: 'shell',
      command: 'docker builder prune -f --keep-storage=10GB',
      timeoutSeconds: 120,
    },
    {
      id: 'check-disk',
      name: 'Check disk space improved',
      action: 'shell',
      command: 'df -h / | tail -1',
      timeoutSeconds: 10,
    },
  ],
  maxAttempts: 1,
  cooldownSeconds: 300,
  requiresApproval: true, // Destructive
};

/**
 * P3: Restart agent with fresh session
 */
export const RESTART_AGENT_FRESH_SESSION: RecoveryPlaybook = {
  id: 'restart-agent-fresh-session',
  name: 'Restart Agent with Fresh Session',
  description: 'Clear the session file and restart the agent',
  forPatterns: ['agent-session-error'],
  preconditions: [],
  steps: [
    {
      id: 'kill-agent',
      name: 'Kill existing agent process',
      action: 'restart-agent',
      params: { action: 'kill' },
      timeoutSeconds: 10,
      continueOnFail: true,
    },
    {
      id: 'clear-session',
      name: 'Clear session file',
      action: 'shell',
      command: 'rm -f ${AGENT_SESSION_FILE}',
      timeoutSeconds: 5,
    },
    {
      id: 'restart-agent',
      name: 'Restart agent',
      action: 'restart-agent',
      params: { action: 'start', freshSession: true },
      timeoutSeconds: 30,
    },
  ],
  maxAttempts: 2,
  cooldownSeconds: 60,
  requiresApproval: false,
};

/**
 * P4: Requeue gate on infrastructure retry
 */
export const REQUEUE_GATE_INFRA_RETRY: RecoveryPlaybook = {
  id: 'requeue-gate-infra-retry',
  name: 'Requeue Gate (Infrastructure Retry)',
  description: 'Mark as infra failure and requeue the gate for another attempt',
  forPatterns: ['precommit-git-error', 'gate-timeout-high-load'],
  preconditions: [],
  steps: [
    {
      id: 'mark-infra',
      name: 'Mark as infrastructure failure',
      action: 'api',
      params: { endpoint: '/api/gates/${GATE_ID}/mark-infra' },
      timeoutSeconds: 5,
    },
    {
      id: 'requeue',
      name: 'Requeue gate',
      action: 'restart-gate',
      params: { attempt: 'infra-retry-${ATTEMPT}' },
      timeoutSeconds: 10,
    },
  ],
  maxAttempts: 2,
  cooldownSeconds: 30,
  requiresApproval: false,
};

/**
 * P5: Restart testcontainers environment
 */
export const RESTART_TESTCONTAINERS: RecoveryPlaybook = {
  id: 'restart-testcontainers',
  name: 'Restart Testcontainers Environment',
  description: 'Stop all testcontainers, prune networks, and requeue failed gates',
  forPatterns: ['redis-testcontainer-timeout', 'postgres-testcontainer-timeout', 'spring-context-failure'],
  preconditions: [
    { type: 'docker-running' },
    { type: 'not-running', target: 'restart-testcontainers' },
  ],
  steps: [
    {
      id: 'stop-testcontainers',
      name: 'Stop all testcontainers',
      action: 'shell',
      command: 'docker rm -f $(docker ps -q --filter "label=org.testcontainers") 2>/dev/null || true',
      timeoutSeconds: 60,
    },
    {
      id: 'prune-networks',
      name: 'Prune testcontainer networks',
      action: 'shell',
      command: 'docker network prune -f --filter "label=org.testcontainers" 2>/dev/null || true',
      timeoutSeconds: 30,
    },
    {
      id: 'wait',
      name: 'Wait for cleanup',
      action: 'wait',
      params: { seconds: 5 },
      timeoutSeconds: 10,
    },
    {
      id: 'requeue-failed',
      name: 'Requeue failed gates',
      action: 'api',
      params: { endpoint: '/api/diagnostics/requeue-affected-gates', diagnosisId: '${DIAGNOSIS_ID}' },
      timeoutSeconds: 30,
    },
  ],
  maxAttempts: 2,
  cooldownSeconds: 120,
  requiresApproval: false,
};

/**
 * P6: Wake remote machine
 */
export const WAKE_REMOTE_MACHINE: RecoveryPlaybook = {
  id: 'wake-remote-machine',
  name: 'Wake Remote Machine',
  description: 'Send Wake-on-LAN packet to a sleeping remote machine',
  forPatterns: [],
  preconditions: [],
  steps: [
    {
      id: 'send-wol',
      name: 'Send Wake-on-LAN packet',
      action: 'shell',
      command: 'wakeonlan ${NODE_MAC_ADDRESS} 2>/dev/null || echo "WoL not available"',
      timeoutSeconds: 5,
      continueOnFail: true,
    },
    {
      id: 'wait-ssh',
      name: 'Wait for SSH',
      action: 'shell',
      command: 'for i in {1..60}; do ssh -o ConnectTimeout=5 ${NODE_SSH} "echo ok" 2>/dev/null && exit 0; sleep 5; done; exit 1',
      timeoutSeconds: 310,
    },
  ],
  maxAttempts: 1,
  cooldownSeconds: 600,
  requiresApproval: false,
};

/**
 * P7: Backoff and retry
 */
export const BACKOFF_AND_RETRY: RecoveryPlaybook = {
  id: 'backoff-and-retry',
  name: 'Backoff and Retry',
  description: 'Wait with exponential backoff, then retry the operation',
  forPatterns: ['agent-rate-limited', 'agent-model-error'],
  preconditions: [],
  steps: [
    {
      id: 'calculate-backoff',
      name: 'Calculate backoff duration',
      action: 'api',
      params: { endpoint: '/api/diagnostics/calculate-backoff', attempt: '${ATTEMPT}' },
      timeoutSeconds: 5,
    },
    {
      id: 'wait-backoff',
      name: 'Wait for backoff period',
      action: 'wait',
      params: { seconds: '${BACKOFF_SECONDS}' },
      timeoutSeconds: 3600, // Up to 1 hour
    },
    {
      id: 'retry',
      name: 'Retry the operation',
      action: 'restart-agent',
      params: { action: 'resume' },
      timeoutSeconds: 30,
    },
  ],
  maxAttempts: 5,
  cooldownSeconds: 0, // Backoff is built into the playbook
  requiresApproval: false,
};

/**
 * P8: Requeue gate with delay
 */
export const REQUEUE_GATE_WITH_DELAY: RecoveryPlaybook = {
  id: 'requeue-gate-with-delay',
  name: 'Requeue Gate with Delay',
  description: 'Wait for load to decrease, then requeue the gate',
  forPatterns: ['gate-timeout-high-load'],
  preconditions: [],
  steps: [
    {
      id: 'check-load',
      name: 'Check current load',
      action: 'shell',
      command: 'uptime | grep -oE "load average[s]?: [0-9.]+" | grep -oE "[0-9.]+" | head -1',
      timeoutSeconds: 5,
    },
    {
      id: 'wait-load',
      name: 'Wait for load to decrease',
      action: 'shell',
      command: 'while [ $(uptime | grep -oE "[0-9.]+" | head -4 | tail -1 | cut -d. -f1) -gt ${MAX_LOAD:-8} ]; do sleep 30; done',
      timeoutSeconds: 1800, // Up to 30 minutes
    },
    {
      id: 'requeue',
      name: 'Requeue gate',
      action: 'restart-gate',
      params: { attempt: 'load-retry-${ATTEMPT}' },
      timeoutSeconds: 10,
    },
  ],
  maxAttempts: 2,
  cooldownSeconds: 300,
  requiresApproval: false,
};

/**
 * All playbooks
 */
export const ALL_PLAYBOOKS: RecoveryPlaybook[] = [
  RESTART_DOCKER,
  CLEAR_DOCKER_RESOURCES,
  RESTART_AGENT_FRESH_SESSION,
  REQUEUE_GATE_INFRA_RETRY,
  RESTART_TESTCONTAINERS,
  WAKE_REMOTE_MACHINE,
  BACKOFF_AND_RETRY,
  REQUEUE_GATE_WITH_DELAY,
];

/**
 * Get a playbook by ID
 */
export function getPlaybook(id: string): RecoveryPlaybook | undefined {
  return ALL_PLAYBOOKS.find(p => p.id === id);
}

/**
 * Get playbooks that can recover a pattern
 */
export function getPlaybooksForPattern(patternId: string): RecoveryPlaybook[] {
  return ALL_PLAYBOOKS.filter(p => p.forPatterns.includes(patternId));
}
