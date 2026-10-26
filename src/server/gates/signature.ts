/**
 * Cryptographic signing and verification for gate results.
 * Nodes sign results with their private key; server verifies with their public key.
 */
import { sign, verify, generateKeyPairSync } from "crypto";
import type { GateResult, SignedGateResult } from "../../shared/policy-types.js";

// ============ KEY GENERATION ============

/** A node's key pair */
export interface NodeKeyPair {
  /** Node identifier */
  nodeId: string;
  /** PEM-encoded public key */
  publicKey: string;
  /** PEM-encoded private key */
  privateKey: string;
  /** When the key was generated */
  generatedAt: string;
}

/**
 * Generate a new Ed25519 key pair for a node.
 */
export function generateNodeKeyPair(nodeId: string): NodeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return {
    nodeId,
    publicKey,
    privateKey,
    generatedAt: new Date().toISOString(),
  };
}

// ============ SIGNING ============

/**
 * Sign a gate result with a node's private key.
 */
export function signGateResult(
  result: GateResult,
  privateKey: string,
  publicKey: string
): SignedGateResult {
  // Serialize the result deterministically
  const payload = serializeForSigning(result);

  // Sign with Ed25519 using crypto.sign (null algorithm for Ed25519)
  const signatureBuffer = sign(null, Buffer.from(payload), privateKey);
  const signature = signatureBuffer.toString("base64");

  return {
    result,
    signature,
    nodePublicKey: publicKey,
  };
}

/**
 * Serialize a gate result for signing.
 * Canonical JSON: every object's keys sorted, at every nesting level.
 */
function serializeForSigning(result: GateResult): string {
  return canonicalJson(result);
}

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Do NOT use `JSON.stringify(value, Object.keys(value).sort())`: a replacer
 * ARRAY is an allow-list applied at every level, so nested keys that aren't
 * also top-level keys (a step's name, exitCode, output, error) are dropped
 * and left unsigned. Follows JSON.stringify for undefined (omitted in
 * objects, null in arrays) and toJSON().
 */
export function canonicalJson(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol"
        ? "null"
        : canonicalJson(item),
    );
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => {
      const v = record[key];
      return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
    })
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

// ============ VERIFICATION ============

/** Result of signature verification */
export interface VerificationResult {
  /** Is the signature valid? */
  valid: boolean;
  /** Errors found during verification */
  errors: string[];
}

/**
 * Verify a signed gate result.
 */
export function verifySignedGateResult(
  signed: SignedGateResult,
  expectedNodePublicKey?: string
): VerificationResult {
  const errors: string[] = [];

  // Check public key matches expected (if provided)
  if (expectedNodePublicKey && signed.nodePublicKey !== expectedNodePublicKey) {
    errors.push("Public key does not match expected node key");
  }

  // Verify signature using crypto.verify (null algorithm for Ed25519)
  try {
    const payload = serializeForSigning(signed.result);
    const signatureBuffer = Buffer.from(signed.signature, "base64");

    const isValid = verify(null, Buffer.from(payload), signed.nodePublicKey, signatureBuffer);

    if (!isValid) {
      errors.push("Signature verification failed");
    }
  } catch (error) {
    errors.push(`Signature verification error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Verify a signed gate result matches expected parameters.
 */
export function verifyGateResultIntegrity(
  signed: SignedGateResult,
  expected: {
    commitSha: string;
    branch: string;
    pipelineId: string;
    nodeId: string;
    nodePublicKey: string;
  }
): VerificationResult {
  const errors: string[] = [];
  const result = signed.result;

  // First verify signature
  const sigResult = verifySignedGateResult(signed, expected.nodePublicKey);
  errors.push(...sigResult.errors);

  // Verify commit SHA matches
  if (result.commitSha !== expected.commitSha) {
    errors.push(`Commit SHA mismatch: expected ${expected.commitSha}, got ${result.commitSha}`);
  }

  // Verify branch matches
  if (result.branch !== expected.branch) {
    errors.push(`Branch mismatch: expected ${expected.branch}, got ${result.branch}`);
  }

  // Verify pipeline ID matches
  if (result.pipelineId !== expected.pipelineId) {
    errors.push(`Pipeline ID mismatch: expected ${expected.pipelineId}, got ${result.pipelineId}`);
  }

  // Verify node ID matches
  if (result.nodeId !== expected.nodeId) {
    errors.push(`Node ID mismatch: expected ${expected.nodeId}, got ${result.nodeId}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============ TAMPERING DETECTION ============

/**
 * Check if a gate result shows signs of tampering or being fake.
 */
export function detectTampering(result: GateResult): string[] {
  const issues: string[] = [];

  // Check timestamps are valid
  try {
    const startTime = new Date(result.startedAt).getTime();
    const endTime = new Date(result.completedAt).getTime();

    if (isNaN(startTime)) issues.push("Invalid startedAt timestamp");
    if (isNaN(endTime)) issues.push("Invalid completedAt timestamp");
    if (endTime < startTime) issues.push("completedAt is before startedAt");

    // Duration should roughly match timestamps
    const expectedDuration = endTime - startTime;
    if (Math.abs(result.durationMs - expectedDuration) > 1000) {
      issues.push("Duration does not match timestamps");
    }
  } catch {
    issues.push("Invalid timestamp format");
  }

  // Check step timestamps are within gate bounds
  for (const step of result.steps) {
    if (step.startedAt && step.completedAt) {
      const stepStart = new Date(step.startedAt).getTime();
      const stepEnd = new Date(step.completedAt).getTime();
      const gateStart = new Date(result.startedAt).getTime();
      const gateEnd = new Date(result.completedAt).getTime();

      if (stepStart < gateStart) {
        issues.push(`Step "${step.name}" started before gate`);
      }
      if (stepEnd > gateEnd) {
        issues.push(`Step "${step.name}" ended after gate`);
      }
    }
  }

  // Check that passed results don't have failed steps
  if (result.status === "passed") {
    const failedSteps = result.steps.filter(s =>
      s.status === "failed" || s.status === "timed_out"
    );
    if (failedSteps.length > 0) {
      issues.push(`Result marked passed but has ${failedSteps.length} failed/timed_out steps`);
    }
    // A pass needs steps that actually ran: skipped (or no) steps are not a pass
    const skippedSteps = result.steps.filter(s => s.status === "skipped");
    if (skippedSteps.length > 0) {
      issues.push(`Result marked passed but has ${skippedSteps.length} skipped steps`);
    }
    if (!result.steps.some(s => s.status === "passed")) {
      issues.push("Result marked passed but no step passed");
    }
  }

  // Check for suspiciously fast execution
  for (const step of result.steps) {
    if (step.status === "passed" && step.durationMs !== undefined && step.durationMs < 10) {
      issues.push(`Step "${step.name}" completed suspiciously fast (${step.durationMs}ms)`);
    }
  }

  // Check all selected steps have results
  const resultStepNames = new Set(result.steps.map(s => s.name));
  for (const stepName of result.selectedSteps) {
    if (!resultStepNames.has(stepName)) {
      issues.push(`Missing result for selected step: ${stepName}`);
    }
  }

  return issues;
}

/**
 * Check if a gate result is a shell error (not a real run).
 */
export function isShellError(result: GateResult): boolean {
  // If there are no step results, it's suspicious
  if (result.steps.length === 0) {
    return true;
  }

  // Check for common shell error patterns in output
  const shellErrorPatterns = [
    /unexpected EOF/i,
    /syntax error/i,
    /command not found/i,
    /No such file or directory/i,
    /permission denied/i,
    /bash: .* error/i,
    /zsh: .* error/i,
  ];

  // If the first step failed immediately with a shell error, it's not a real run
  const firstStep = result.steps[0];
  if (firstStep && firstStep.status === "failed" && firstStep.output) {
    for (const pattern of shellErrorPatterns) {
      if (pattern.test(firstStep.output)) {
        return true;
      }
    }
  }

  return false;
}
