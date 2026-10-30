/**
 * Environment outage detection and probe-based waiting.
 *
 * When triage classifies a result's EVERY failed step as matching an
 * environment pattern (Docker down, disk full, network unreachable, SSH
 * refused), and NO step shows a test, lint or compile failure, the result
 * is an environment outage. Instead of re-checking blindly, triage:
 *
 * 1. Runs the configured probe command (e.g. `docker info`);
 * 2. Polls with backoff until the probe passes or `max_wait_minutes` elapses;
 * 3. While waiting, shows one notice on Home, raises NO decision;
 * 4. After the probe passes, triggers re-checks for all waiting gates;
 * 5. If the probe never passes, raises ONE decision listing all gates.
 *
 * Re-checks after an environment wait don't count against `max_per_result`.
 */

/**
 * Environment pattern for detecting outages (Docker, disk, network, SSH).
 * More specific than the general infra patterns: these are conditions where
 * the entire environment is down, not just one flaky container.
 */
export interface EnvironmentPattern {
  id: string;
  /** A regular expression matched case-insensitively against step output and errors */
  pattern: string;
  /** The probe command that checks if this condition is resolved */
  probe?: string[];
  /** Timeout in seconds for the probe command */
  probeTimeoutSeconds?: number;
}

/**
 * Default environment patterns that indicate the environment itself is down,
 * not just a test failure. Each has a default probe.
 */
export const DEFAULT_ENVIRONMENT_PATTERNS: EnvironmentPattern[] = [
  {
    id: "docker-daemon",
    pattern: "cannot connect to the docker daemon|docker: error response from daemon|error during connect:",
    probe: ["docker", "info"],
    probeTimeoutSeconds: 30,
  },
  {
    id: "docker-exit-125",
    // Exit 125 from a docker step is "container could not start" (daemon issue)
    pattern: "exit code:? 125|exited with code 125",
    probe: ["docker", "info"],
    probeTimeoutSeconds: 30,
  },
  {
    id: "disk-full",
    pattern: "no space left on device|ENOSPC|disk quota exceeded",
    probe: ["df", "-h", "/"],
    probeTimeoutSeconds: 10,
  },
  {
    id: "dns-unreachable",
    pattern: "EAI_AGAIN|ENOTFOUND|temporary failure in name resolution|could not resolve host",
    probe: ["nslookup", "github.com"],
    probeTimeoutSeconds: 10,
  },
  {
    id: "network-unreachable",
    pattern: "network is unreachable|ENETUNREACH|no route to host",
    probe: ["ping", "-c", "1", "8.8.8.8"],
    probeTimeoutSeconds: 10,
  },
  {
    id: "ssh-refused",
    pattern: "ssh:.*connection refused|ssh:.*connection timed out|ssh:.*no route to host",
    // No default probe for SSH (host-specific)
  },
];

export interface CompiledEnvironmentPattern {
  id: string;
  regex: RegExp;
  probe?: string[];
  probeTimeoutSeconds: number;
}

/** Environment settings from triage.environment config */
export interface EnvironmentSettings {
  mode: "off" | "observe" | "act";
  patterns: CompiledEnvironmentPattern[];
  maxWaitMinutes: number;
  /** Initial backoff in seconds before first retry */
  initialBackoffSeconds: number;
  /** Maximum backoff in seconds */
  maxBackoffSeconds: number;
}

/** Result of classifying a gate result for environment outage */
export interface EnvironmentClassification {
  /** True if this is an environment outage (all failed steps match, no code failures) */
  isEnvironment: boolean;
  /** The matching pattern(s), if any */
  matchedPatterns: string[];
  /** Evidence lines that matched */
  evidence: string[];
  /** Why it's not an environment outage, if applicable */
  reason?: string;
}

/** A gate waiting for the environment to recover */
export interface EnvironmentWait {
  /** Unique wait id */
  id: string;
  /** Project name */
  project: string;
  /** Gate ids waiting on this environment issue */
  gateIds: string[];
  /** Record ids of the triaged results */
  recordIds: string[];
  /** The pattern that triggered the wait */
  patternId: string;
  /** Probe command to run */
  probe: string[];
  /** Timeout for the probe in seconds */
  probeTimeoutSeconds: number;
  /** When the wait started */
  startedAt: string;
  /** When to give up (startedAt + maxWaitMinutes) */
  expiresAt: string;
  /** Last probe attempt time */
  lastProbeAt?: string;
  /** Last probe result */
  lastProbeResult?: { ok: boolean; output: string };
  /** Successful probe count */
  probePassCount: number;
  /** Next scheduled probe time */
  nextProbeAt: string;
  /** Current backoff in seconds */
  currentBackoffSeconds: number;
  /** Status: waiting, resolved (probe passed), expired (gave up), cancelled */
  status: "waiting" | "resolved" | "expired" | "cancelled";
}

/**
 * Classify whether a gate result represents an environment outage.
 *
 * A result is `environment` only if:
 * 1. EVERY failed step matches an environment pattern; AND
 * 2. NO step shows a test, lint or compile failure
 */
export function classifyEnvironment(
  stepOutputs: { step: string; status: "passed" | "failed" | "timed_out" | "skipped"; output: string; exitCode?: number }[],
  patterns: CompiledEnvironmentPattern[],
): EnvironmentClassification {
  const failedSteps = stepOutputs.filter((s) => s.status === "failed" || s.status === "timed_out");

  if (failedSteps.length === 0) {
    return { isEnvironment: false, matchedPatterns: [], evidence: [], reason: "no failed steps" };
  }

  // Check if any step shows a code failure (test, lint, compile)
  const codeFailurePatterns = [
    /\btest(s)?\s+(failed|failure)/i,
    /\bfailing test/i,
    /\bassertion(error|failed)/i,
    /\bexpected\b.*\bbut (was|got)\b/i,
    /\blint(er)?\s+(error|failed|failure)/i,
    /\bcompil(e|ation)\s+(error|failed|failure)/i,
    /\bsyntax error/i,
    /\btype\s*error/i,
    /\bTypeError:/i,
  ];

  for (const step of failedSteps) {
    for (const codePattern of codeFailurePatterns) {
      if (codePattern.test(step.output)) {
        return {
          isEnvironment: false,
          matchedPatterns: [],
          evidence: [],
          reason: `step "${step.step}" shows a code failure`,
        };
      }
    }
  }

  // Check if every failed step matches an environment pattern
  const matchedPatterns: string[] = [];
  const evidence: string[] = [];

  for (const step of failedSteps) {
    let stepMatched = false;

    // Check for exit 125 (Docker container start failure)
    if (step.exitCode === 125) {
      const pattern = patterns.find((p) => p.id === "docker-exit-125" || p.id === "docker-daemon");
      if (pattern) {
        stepMatched = true;
        if (!matchedPatterns.includes(pattern.id)) {
          matchedPatterns.push(pattern.id);
        }
        evidence.push(`step "${step.step}" exited with code 125 (matches ${pattern.id})`);
      }
    }

    // Check output against patterns
    for (const pattern of patterns) {
      if (pattern.regex.test(step.output)) {
        stepMatched = true;
        if (!matchedPatterns.includes(pattern.id)) {
          matchedPatterns.push(pattern.id);
        }
        // Extract the matching line(s) for evidence
        const lines = step.output.split("\n");
        for (const line of lines.slice(0, 20)) {
          // Check first 20 lines
          if (pattern.regex.test(line)) {
            evidence.push(`step "${step.step}": ${line.slice(0, 200).trim()} (matches ${pattern.id})`);
            break;
          }
        }
        break; // One pattern match per step is enough
      }
    }

    if (!stepMatched) {
      return {
        isEnvironment: false,
        matchedPatterns: [],
        evidence: [],
        reason: `step "${step.step}" failed but doesn't match any environment pattern`,
      };
    }
  }

  return {
    isEnvironment: true,
    matchedPatterns,
    evidence: evidence.slice(0, 5), // Keep evidence manageable
  };
}

/**
 * Get the probe command for a given pattern id.
 * Returns the pattern's specific probe if set, otherwise the default.
 */
export function getProbeForPattern(patternId: string, patterns: CompiledEnvironmentPattern[]): string[] | undefined {
  const pattern = patterns.find((p) => p.id === patternId);
  return pattern?.probe;
}

/**
 * Calculate next backoff duration with exponential backoff and jitter.
 */
export function nextBackoff(currentSeconds: number, maxSeconds: number): number {
  // Double the backoff, capped at max
  const next = Math.min(currentSeconds * 2, maxSeconds);
  // Add 10% jitter
  const jitter = next * 0.1 * Math.random();
  return Math.round(next + jitter);
}

/**
 * Compile environment patterns from config.
 */
export function compileEnvironmentPatterns(
  configPatterns: EnvironmentPattern[],
  useDefaults: boolean,
  errors: string[],
): CompiledEnvironmentPattern[] {
  const result: CompiledEnvironmentPattern[] = [];
  const ids = new Set<string>();

  // User patterns first
  for (let i = 0; i < configPatterns.length; i++) {
    const p = configPatterns[i];
    if (ids.has(p.id)) {
      errors.push(`triage.environment.patterns: duplicate pattern id ${p.id}`);
      continue;
    }
    ids.add(p.id);
    try {
      result.push({
        id: p.id,
        regex: new RegExp(p.pattern, "i"),
        probe: p.probe,
        probeTimeoutSeconds: p.probeTimeoutSeconds ?? 30,
      });
    } catch (e) {
      errors.push(
        `triage.environment.patterns.${i}.pattern: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // Then defaults (unless user replaced them by id)
  if (useDefaults) {
    for (const d of DEFAULT_ENVIRONMENT_PATTERNS) {
      if (ids.has(d.id)) continue;
      ids.add(d.id);
      try {
        result.push({
          id: d.id,
          regex: new RegExp(d.pattern, "i"),
          probe: d.probe,
          probeTimeoutSeconds: d.probeTimeoutSeconds ?? 30,
        });
      } catch {
        // Built-in patterns should always be valid
      }
    }
  }

  return result;
}
