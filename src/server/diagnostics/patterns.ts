/**
 * Built-in diagnostic patterns for common failures
 * See SPEC-diagnostics.md §1 for the full failure taxonomy
 */

import type { DiagnosticPattern } from './types.js';

/**
 * Infrastructure failure patterns
 */
export const INFRA_PATTERNS: DiagnosticPattern[] = [
  {
    id: 'redis-testcontainer-timeout',
    name: 'Redis/Valkey testcontainer connection timeout',
    description: 'Testcontainer for Redis/Valkey failed to start or accept connections',
    category: 'infra',
    patterns: [
      /RedisConnectionException: Unable to connect to localhost/i,
      /Connection initialization timed out/i,
      /io\.lettuce\.core\.RedisConnectionException/i,
      /Unable to connect to .*:\d+ after \d+ attempts/i,
    ],
    contextChecks: [
      {
        id: 'docker-running',
        type: 'shell',
        command: 'docker ps',
        expectation: 'exit-zero',
      },
      {
        id: 'testcontainers-present',
        type: 'shell',
        command: 'docker ps --filter "label=org.testcontainers" -q',
        expectation: 'exists',
      },
    ],
    severity: 'high',
    autoRecoverable: true,
    recoveryPlaybookId: 'restart-testcontainers',
    escalationTemplate: 'Redis testcontainer failed to start. This affects all backend integration tests.',
  },
  {
    id: 'postgres-testcontainer-timeout',
    name: 'PostgreSQL testcontainer connection timeout',
    description: 'Testcontainer for PostgreSQL failed to start or accept connections',
    category: 'infra',
    patterns: [
      /Connection to .*:\d+ refused/i,
      /FATAL:.*database.*does not exist/i,
      /org\.postgresql\.util\.PSQLException.*Connection refused/i,
      /Timed out waiting for container port to open/i,
    ],
    severity: 'high',
    autoRecoverable: true,
    recoveryPlaybookId: 'restart-testcontainers',
    escalationTemplate: 'PostgreSQL testcontainer failed to start. This affects all database integration tests.',
  },
  {
    id: 'docker-daemon-stopped',
    name: 'Docker daemon not running',
    description: 'The Docker daemon is not responding',
    category: 'infra',
    patterns: [
      /Cannot connect to the Docker daemon/i,
      /docker: command not found/i,
      /Is the docker daemon running\?/i,
      /Error response from daemon/i,
    ],
    contextChecks: [
      {
        id: 'docker-ps-fails',
        type: 'shell',
        command: 'docker ps',
        expectation: 'exit-nonzero',
      },
    ],
    severity: 'critical',
    autoRecoverable: true,
    recoveryPlaybookId: 'restart-docker',
    escalationTemplate: 'Docker daemon is not running. No containers can start until it is restored.',
  },
  {
    id: 'out-of-disk',
    name: 'Out of disk space',
    description: 'The machine has run out of disk space',
    category: 'infra',
    patterns: [
      /ENOSPC: no space left on device/i,
      /No space left on device/i,
      /Disk quota exceeded/i,
      /write.*: No space left on device/i,
    ],
    severity: 'critical',
    autoRecoverable: false,
    escalationTemplate: 'Disk is full. Manual cleanup required. Consider pruning Docker images or expanding disk.',
  },
  {
    id: 'out-of-memory',
    name: 'Out of memory (OOM)',
    description: 'A process was killed due to out of memory',
    category: 'infra',
    patterns: [
      /OOMKilled/i,
      /Out of memory/i,
      /Cannot allocate memory/i,
      /java\.lang\.OutOfMemoryError/i,
      /Killed.*signal 9/i,
    ],
    severity: 'high',
    autoRecoverable: false,
    escalationTemplate: 'Process killed due to out of memory. Consider increasing memory limits or reducing concurrency.',
  },
  {
    id: 'network-unreachable',
    name: 'Network unreachable',
    description: 'Cannot reach external services (model API, git host)',
    category: 'infra',
    patterns: [
      /ETIMEDOUT/i,
      /ECONNREFUSED/i,
      /ENOTFOUND/i,
      /getaddrinfo.*failed/i,
      /Network is unreachable/i,
      /Could not resolve host/i,
    ],
    severity: 'high',
    autoRecoverable: false,
    escalationTemplate: 'Network connectivity issue. Check internet connection and firewall settings.',
  },
];

/**
 * Agent failure patterns
 */
export const AGENT_PATTERNS: DiagnosticPattern[] = [
  {
    id: 'agent-session-error',
    name: 'Agent session authentication error',
    description: 'The agent session failed to authenticate or resume',
    category: 'agent',
    patterns: [
      /session.*expired/i,
      /authentication failed/i,
      /invalid.*session/i,
      /401 Unauthorized/i,
      /ClientNetworkError/i,
    ],
    severity: 'medium',
    autoRecoverable: true,
    recoveryPlaybookId: 'restart-agent-fresh-session',
    escalationTemplate: 'Agent session failed. Will retry with a fresh session.',
  },
  {
    id: 'agent-rate-limited',
    name: 'Model API rate limited',
    description: 'The model provider is rate limiting requests',
    category: 'agent',
    patterns: [
      /429 Too Many Requests/i,
      /rate.*limit.*exceeded/i,
      /quota.*exceeded/i,
      /Please retry after/i,
    ],
    severity: 'medium',
    autoRecoverable: true,
    recoveryPlaybookId: 'backoff-and-retry',
    escalationTemplate: 'Model API rate limited. Reducing concurrency and retrying.',
  },
  {
    id: 'agent-model-error',
    name: 'Model API error',
    description: 'The model provider returned an error',
    category: 'agent',
    patterns: [
      /500 Internal Server Error/i,
      /502 Bad Gateway/i,
      /503 Service Unavailable/i,
      /model.*overloaded/i,
    ],
    severity: 'medium',
    autoRecoverable: true,
    recoveryPlaybookId: 'backoff-and-retry',
    escalationTemplate: 'Model API error. Will retry after backoff.',
  },
];

/**
 * Gate failure patterns (infrastructure, not code bugs)
 */
export const GATE_PATTERNS: DiagnosticPattern[] = [
  {
    id: 'spring-context-failure',
    name: 'Spring ApplicationContext failure',
    description: 'The Spring test context failed to load, preventing all integration tests',
    category: 'gate',
    patterns: [
      /Failed to load ApplicationContext/i,
      /ApplicationContext failure threshold.*exceeded/i,
      /Error creating bean with name/i,
      /BeanCreationException/i,
      /UnsatisfiedDependencyException/i,
    ],
    severity: 'high',
    autoRecoverable: true,
    recoveryPlaybookId: 'restart-testcontainers',
    escalationTemplate: 'Spring context failed to load. Usually caused by testcontainer issues.',
  },
  {
    id: 'junit-ran-nothing',
    name: 'JUnit ran no tests',
    description: 'JUnit reported 0 tests run, indicating the test framework failed to find or execute tests',
    category: 'gate',
    patterns: [
      /junit: 0 classes, 0 tests/i,
      /has NO JUnit result: it ran nothing/i,
      /No tests found/i,
    ],
    severity: 'high',
    autoRecoverable: false,
    escalationTemplate: 'JUnit ran 0 tests. This usually means the test context crashed before tests could run.',
  },
  {
    id: 'precommit-git-error',
    name: 'Pre-commit git configuration error',
    description: 'The known race condition where git config is rewritten during a pre-commit hook',
    category: 'gate',
    patterns: [
      /CalledProcessError.*git.*ls-files/i,
      /unknown error occurred while reading the configuration files/i,
      /FAIL pre-commit.*git failed/i,
      /pre-commit.*CalledProcessError/i,
    ],
    severity: 'low',
    autoRecoverable: true,
    recoveryPlaybookId: 'requeue-gate-infra-retry',
    escalationTemplate: 'Known git config race condition. Automatically retrying.',
  },
  {
    id: 'gate-timeout-high-load',
    name: 'Gate timeout under high load',
    description: 'A gate step timed out while the machine was under high load',
    category: 'gate',
    patterns: [
      /exceeded its configured timeout/i,
      /Requesting stop of task.*timeout/i,
    ],
    contextChecks: [
      {
        id: 'check-load',
        type: 'shell',
        command: 'uptime',
        expectation: 'exists',
        extractPattern: /load average[s]?: ([\d.]+)/i,
      },
    ],
    severity: 'medium',
    autoRecoverable: true,
    recoveryPlaybookId: 'requeue-gate-with-delay',
    escalationTemplate: 'Gate timed out under high load. Will retry when load decreases.',
  },
  {
    id: 'npm-ci-failure',
    name: 'npm ci installation failure',
    description: 'npm ci failed to install dependencies',
    category: 'gate',
    patterns: [
      /npm ERR! code E/i,
      /npm ERR! 404 Not Found/i,
      /npm ERR! ERESOLVE/i,
      /npm ci.*failed/i,
    ],
    severity: 'medium',
    autoRecoverable: false,
    escalationTemplate: 'npm ci failed. Check for network issues or package availability.',
  },
  {
    id: 'gradle-build-failure',
    name: 'Gradle build failure (not test failure)',
    description: 'Gradle failed to compile or build, not a test failure',
    category: 'gate',
    patterns: [
      /FAILURE: Build failed with an exception/i,
      /Compilation failed/i,
      /Could not resolve.*dependencies/i,
    ],
    severity: 'medium',
    autoRecoverable: false,
    escalationTemplate: 'Gradle build failed. This is likely a code issue, not infrastructure.',
  },
];

/**
 * Systemic failure patterns (multiple components affected)
 */
export const SYSTEMIC_PATTERNS: DiagnosticPattern[] = [
  {
    id: 'all-gates-same-error',
    name: 'All gates failing with the same error',
    description: 'More than 50% of recent gates failed with the same error pattern',
    category: 'systemic',
    patterns: [], // Detected by clustering, not pattern matching
    severity: 'critical',
    autoRecoverable: false,
    escalationTemplate: 'Systemic failure: all gates are failing with the same error. Manual investigation required.',
  },
  {
    id: 'all-agents-silent',
    name: 'All agents went silent',
    description: 'More than 50% of agents became silent in the same time window',
    category: 'systemic',
    patterns: [],
    severity: 'critical',
    autoRecoverable: false,
    escalationTemplate: 'Systemic failure: all agents went silent. Check model API or network.',
  },
  {
    id: 'main-broken',
    name: 'Main branch is broken',
    description: 'Nightly failed and no branch gates are passing either',
    category: 'systemic',
    patterns: [],
    severity: 'critical',
    autoRecoverable: false,
    escalationTemplate: 'Main branch appears broken. Nightly failed and branch gates are also failing.',
  },
];

/**
 * All patterns combined
 */
export const ALL_PATTERNS: DiagnosticPattern[] = [
  ...INFRA_PATTERNS,
  ...AGENT_PATTERNS,
  ...GATE_PATTERNS,
  ...SYSTEMIC_PATTERNS,
];

/**
 * Get a pattern by ID
 */
export function getPattern(id: string): DiagnosticPattern | undefined {
  return ALL_PATTERNS.find(p => p.id === id);
}

/**
 * Match content against all patterns
 */
export function matchPatterns(content: string): DiagnosticPattern[] {
  const matched: DiagnosticPattern[] = [];
  
  for (const pattern of ALL_PATTERNS) {
    // Skip patterns that are detected by clustering, not regex
    if (pattern.patterns.length === 0) continue;
    
    for (const regex of pattern.patterns) {
      if (regex.test(content)) {
        matched.push(pattern);
        break; // Don't match the same pattern multiple times
      }
    }
  }
  
  return matched;
}

/**
 * Extract the most severe pattern from a list
 */
export function getMostSevere(patterns: DiagnosticPattern[]): DiagnosticPattern | undefined {
  const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low'];
  
  for (const severity of severityOrder) {
    const found = patterns.find(p => p.severity === severity);
    if (found) return found;
  }
  
  return patterns[0];
}

type Severity = 'low' | 'medium' | 'high' | 'critical';
