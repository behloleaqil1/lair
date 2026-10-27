/**
 * Root-cause signatures (docs/configuration.md, "Triage"). A failure is
 * classified by its root cause, not its top exception: when its message, its
 * "Caused by" chain (from the report, or from the step's console output for
 * the same tests) or its log lines hold one of these, it is infrastructure. A
 * timeout signature makes it a timeout under load (infra, kind load). A
 * context failure ("Failed to load ApplicationContext") whose chain holds one
 * is infra too, and so are the tests that only report that context failing
 * again (they join it: parsers/index.ts).
 *
 * An assertion's failure (AssertionError, "expected ... but was") is the test's
 * own verdict and a build or compile error is the code's: neither is read this
 * way. Projects add their own (triage.infra_signatures,
 * triage.timeout_signatures); default_infra_patterns: false drops these with
 * the built-in infra patterns.
 */
import type { FailureCause } from "../../shared/triage-types.js";
import type { InfraKind } from "./config.js";
import { clip } from "./text.js";

export interface SignatureDef {
  id: string;
  /** infra signatures only: what failed (a timeout signature is always kind load) */
  kind?: InfraKind;
  /** A regular expression, matched case-insensitively against each line (each clipped first) */
  pattern: string;
}

export interface CompiledSignature {
  id: string;
  kind?: InfraKind;
  regex: RegExp;
}

export const DEFAULT_INFRA_SIGNATURES: SignatureDef[] = [
  { id: "connection-refused", kind: "network", pattern: "connection refused|connection to \\S{1,200} refused" },
  { id: "connection-reset", kind: "network", pattern: "connection reset" },
  { id: "unable-to-connect", kind: "network", pattern: "unable to connect to" },
  { id: "redis-connection", kind: "network", pattern: "RedisConnectionException|RedisConnectionFailureException" },
  { id: "jdbc-connection", kind: "network", pattern: "could not open JDBC Connection" },
  {
    id: "docker-environment",
    kind: "container",
    pattern: "could not find a valid docker environment|cannot connect to the docker daemon|ContainerLaunchException|ContainerFetchException",
  },
  { id: "disk-full", kind: "disk", pattern: "no space left on device" },
  { id: "out-of-memory", kind: "oom", pattern: "OutOfMemoryError: (GC overhead limit exceeded|Java heap space)" },
];

export const DEFAULT_TIMEOUT_SIGNATURES: SignatureDef[] = [
  { id: "connection-init-timeout", pattern: "connection initialization timed out" },
  { id: "timeout-exception", pattern: "TimeoutException.{0,300}timed out after" },
];

const ASSERTION_TYPE = /(?:^|[.$])(?:AssertionError|AssertionFailedError|ComparisonFailure|MultipleFailuresError)$/;
const EXPECTED_BUT_WAS = /\bexpected:? .{0,200}\bbut (?:was|got)\b/i;

/** An assertion's failure: the test checked something and it was wrong. */
export function isAssertion(cause: FailureCause): boolean {
  if (cause.type && ASSERTION_TYPE.test(clip(cause.type, 200))) return true;
  return EXPECTED_BUT_WAS.test(clip(cause.message, 500));
}

/** The lines a signature is matched against, with where each came from. */
export function signatureLines(cause: FailureCause): { where: string; text: string }[] {
  const head = cause.type ? `${cause.type}: ${cause.message}` : cause.message;
  return [
    { where: "error", text: head },
    ...cause.causedBy.map((text) => ({ where: "Caused by", text })),
    ...cause.evidence.map((text) => ({ where: "log", text })),
  ].map((l) => ({ where: l.where, text: clip(l.text, 1000) }));
}

/** The first signature a line matches: infra signatures first, then timeout ones. */
export function findSignature(
  cause: FailureCause,
  infra: CompiledSignature[],
  timeout: CompiledSignature[],
): { signature: CompiledSignature; timeout: boolean; where: string; text: string } | null {
  if (isAssertion(cause)) return null;
  const lines = signatureLines(cause);
  for (const [list, isTimeout] of [
    [infra, false],
    [timeout, true],
  ] as const) {
    for (const signature of list) {
      const hit = lines.find((l) => signature.regex.test(l.text));
      if (hit) return { signature, timeout: isTimeout, where: hit.where, text: hit.text };
    }
  }
  return null;
}
