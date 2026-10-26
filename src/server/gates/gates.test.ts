/**
 * Gate pipeline and verification tests.
 * Tests gate config, execution, signing, and tampering detection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseGatePipeline,
  matchGlob,
  computeAffectedSteps,
  computePipelineVersion,
  createExamplePipeline,
} from "./pipeline-config.js";
import {
  runGate,
  validateGateResult,
  ExecuteResult,
} from "./gate-executor.js";
import {
  generateNodeKeyPair,
  signGateResult,
  verifySignedGateResult,
  verifyGateResultIntegrity,
  detectTampering,
  isShellError,
  canonicalJson,
} from "./signature.js";
import type { GateResult, GatePipeline } from "../../shared/policy-types.js";

// ============ PIPELINE CONFIG TESTS ============

describe("Pipeline Config", () => {
  describe("parseGatePipeline", () => {
    it("parses a valid pipeline", () => {
      const pipeline = parseGatePipeline({
        id: "test",
        name: "Test Pipeline",
        steps: [
          { name: "lint", command: "npm run lint", timeoutSeconds: 60 },
        ],
        defaultSteps: ["lint"],
        timeoutSeconds: 300,
      });

      expect(pipeline.id).toBe("test");
      expect(pipeline.steps).toHaveLength(1);
    });

    it("rejects pipeline with invalid defaultSteps", () => {
      expect(() =>
        parseGatePipeline({
          id: "test",
          name: "Test",
          steps: [{ name: "lint", command: "npm lint", timeoutSeconds: 60 }],
          defaultSteps: ["nonexistent"],
          timeoutSeconds: 300,
        })
      ).toThrow('Default step "nonexistent" not found');
    });

    it("rejects pipeline with missing required fields", () => {
      expect(() => parseGatePipeline({ id: "test" })).toThrow();
    });
  });

  describe("matchGlob", () => {
    it("matches exact paths", () => {
      expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
      expect(matchGlob("src/index.ts", "src/other.ts")).toBe(false);
    });

    it("matches single wildcard", () => {
      expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
      expect(matchGlob("src/*.ts", "src/deep/index.ts")).toBe(false);
    });

    it("matches double wildcard", () => {
      expect(matchGlob("src/**/*.ts", "src/index.ts")).toBe(true);
      expect(matchGlob("src/**/*.ts", "src/deep/index.ts")).toBe(true);
      expect(matchGlob("src/**/*.ts", "src/very/deep/index.ts")).toBe(true);
      expect(matchGlob("src/**/*.ts", "other/index.ts")).toBe(false);
    });

    it("matches question mark", () => {
      expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
      expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
    });
  });

  describe("computeAffectedSteps", () => {
    const pipeline = createExamplePipeline();

    it("returns scoped steps for matching files", () => {
      const steps = computeAffectedSteps(pipeline, ["src/index.ts"]);
      expect(steps).toContain("lint");
      expect(steps).toContain("typecheck");
      expect(steps).toContain("unit-tests");
    });

    it("returns integration tests for server files", () => {
      const steps = computeAffectedSteps(pipeline, ["src/server/api.ts"]);
      expect(steps).toContain("integration-tests");
    });

    it("returns security scan for package.json", () => {
      const steps = computeAffectedSteps(pipeline, ["package.json"]);
      expect(steps).toContain("security-scan");
    });

    it("returns default steps when no scope matches", () => {
      const steps = computeAffectedSteps(pipeline, ["README.md"]);
      expect(steps).toEqual(["lint", "typecheck", "unit-tests"]);
    });
  });

  describe("computePipelineVersion", () => {
    it("returns consistent hash for same config", () => {
      const pipeline = createExamplePipeline();
      const v1 = computePipelineVersion(pipeline);
      const v2 = computePipelineVersion(pipeline);
      expect(v1).toBe(v2);
    });

    it("returns different hash for different config", () => {
      const p1 = createExamplePipeline();
      const p2 = { ...createExamplePipeline(), id: "different" };
      expect(computePipelineVersion(p1)).not.toBe(computePipelineVersion(p2));
    });
  });
});

// ============ GATE EXECUTOR TESTS ============

describe("Gate Executor", () => {
  const mockExecute = vi.fn<
    [string, { cwd: string; timeoutMs: number; env?: Record<string, string> }],
    Promise<ExecuteResult>
  >();

  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("runs all selected steps in order", async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: "OK",
      stderr: "",
      timedOut: false,
      durationMs: 100,
    });

    const pipeline = createExamplePipeline();
    const result = await runGate({
      pipeline,
      commitSha: "abc123",
      branch: "main",
      projectId: "test",
      nodeId: "node-1",
      changedFiles: ["src/index.ts"],
      workDir: "/tmp/work",
      executeCommand: mockExecute,
    });

    expect(result.status).toBe("passed");
    expect(result.steps.filter((s) => s.status === "passed").length).toBeGreaterThan(0);
    expect(mockExecute).toHaveBeenCalled();
  });

  it("marks result as failed when step fails", async () => {
    mockExecute.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Error",
      timedOut: false,
      durationMs: 100,
    });

    const pipeline: GatePipeline = {
      id: "test",
      name: "Test",
      steps: [{ name: "test", command: "npm test", timeoutSeconds: 60 }],
      scope: [],
      defaultSteps: ["test"],
      timeoutSeconds: 300,
    };

    const result = await runGate({
      pipeline,
      commitSha: "abc123",
      branch: "main",
      projectId: "test",
      nodeId: "node-1",
      changedFiles: [],
      workDir: "/tmp",
      executeCommand: mockExecute,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
  });

  it("handles step timeout", async () => {
    mockExecute.mockResolvedValue({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
      durationMs: 60000,
    });

    const pipeline: GatePipeline = {
      id: "test",
      name: "Test",
      steps: [{ name: "slow", command: "sleep 1000", timeoutSeconds: 60 }],
      scope: [],
      defaultSteps: ["slow"],
      timeoutSeconds: 300,
    };

    const result = await runGate({
      pipeline,
      commitSha: "abc123",
      branch: "main",
      projectId: "test",
      nodeId: "node-1",
      changedFiles: [],
      workDir: "/tmp",
      executeCommand: mockExecute,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("timed_out");
  });

  it("continues on failure when configured", async () => {
    let callCount = 0;
    mockExecute.mockImplementation(async () => {
      callCount++;
      return {
        exitCode: callCount === 1 ? 1 : 0, // First call fails
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 100,
      };
    });

    const pipeline: GatePipeline = {
      id: "test",
      name: "Test",
      steps: [
        { name: "optional", command: "lint", timeoutSeconds: 60, continueOnFailure: true },
        { name: "required", command: "test", timeoutSeconds: 60 },
      ],
      scope: [],
      defaultSteps: ["optional", "required"],
      timeoutSeconds: 300,
    };

    const result = await runGate({
      pipeline,
      commitSha: "abc123",
      branch: "main",
      projectId: "test",
      nodeId: "node-1",
      changedFiles: [],
      workDir: "/tmp",
      executeCommand: mockExecute,
    });

    // Overall failed because optional step failed
    expect(result.status).toBe("failed");
    // But both steps ran
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[1].status).toBe("passed");
  });
});

// ============ SIGNATURE TESTS ============

describe("Signature", () => {
  describe("generateNodeKeyPair", () => {
    it("generates valid key pair", () => {
      const keys = generateNodeKeyPair("node-1");
      expect(keys.nodeId).toBe("node-1");
      expect(keys.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
    });
  });

  describe("signGateResult", () => {
    it("creates a valid signed result", () => {
      const keys = generateNodeKeyPair("node-1");
      const result: GateResult = createValidGateResult();

      const signed = signGateResult(result, keys.privateKey, keys.publicKey);

      expect(signed.result).toEqual(result);
      expect(signed.signature).toBeTruthy();
      expect(signed.nodePublicKey).toBe(keys.publicKey);
    });
  });

  describe("verifySignedGateResult", () => {
    it("verifies a valid signature", () => {
      const keys = generateNodeKeyPair("node-1");
      const result = createValidGateResult();
      const signed = signGateResult(result, keys.privateKey, keys.publicKey);

      const verification = verifySignedGateResult(signed, keys.publicKey);

      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });

    it("rejects tampered result", () => {
      const keys = generateNodeKeyPair("node-1");
      const result = createValidGateResult();
      const signed = signGateResult(result, keys.privateKey, keys.publicKey);

      // Tamper with the result
      signed.result.status = "passed";
      (signed.result as GateResult).commitSha = "tampered";

      const verification = verifySignedGateResult(signed, keys.publicKey);

      expect(verification.valid).toBe(false);
      expect(verification.errors).toContain("Signature verification failed");
    });

    it("rejects wrong public key", () => {
      const keys1 = generateNodeKeyPair("node-1");
      const keys2 = generateNodeKeyPair("node-2");
      const result = createValidGateResult();
      const signed = signGateResult(result, keys1.privateKey, keys1.publicKey);

      const verification = verifySignedGateResult(signed, keys2.publicKey);

      expect(verification.valid).toBe(false);
    });
  });

  describe("verifyGateResultIntegrity", () => {
    it("passes with matching parameters", () => {
      const keys = generateNodeKeyPair("node-1");
      const result = createValidGateResult();
      const signed = signGateResult(result, keys.privateKey, keys.publicKey);

      const verification = verifyGateResultIntegrity(signed, {
        commitSha: result.commitSha,
        branch: result.branch,
        pipelineId: result.pipelineId,
        nodeId: result.nodeId,
        nodePublicKey: keys.publicKey,
      });

      expect(verification.valid).toBe(true);
    });

    it("fails with wrong commit SHA", () => {
      const keys = generateNodeKeyPair("node-1");
      const result = createValidGateResult();
      const signed = signGateResult(result, keys.privateKey, keys.publicKey);

      const verification = verifyGateResultIntegrity(signed, {
        commitSha: "wrong-sha",
        branch: result.branch,
        pipelineId: result.pipelineId,
        nodeId: result.nodeId,
        nodePublicKey: keys.publicKey,
      });

      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("Commit SHA mismatch"))).toBe(true);
    });
  });
});

// ============ TAMPERING DETECTION TESTS ============

describe("Tampering Detection", () => {
  describe("detectTampering", () => {
    it("passes a valid result", () => {
      const result = createValidGateResult();
      const issues = detectTampering(result);
      expect(issues).toHaveLength(0);
    });

    it("detects invalid timestamps", () => {
      const result = createValidGateResult();
      result.completedAt = result.startedAt; // Same time
      result.durationMs = 10000; // But claims 10 seconds

      const issues = detectTampering(result);
      expect(issues.some((i) => i.includes("Duration does not match"))).toBe(true);
    });

    it("detects passed result with failed steps", () => {
      const result = createValidGateResult();
      result.status = "passed";
      result.steps[0].status = "failed";

      const issues = detectTampering(result);
      expect(issues.some((i) => i.includes("marked passed but has"))).toBe(true);
    });

    it("detects suspiciously fast execution", () => {
      const result = createValidGateResult();
      result.steps[0].durationMs = 1; // 1ms is suspicious

      const issues = detectTampering(result);
      expect(issues.some((i) => i.includes("suspiciously fast"))).toBe(true);
    });

    it("detects missing step results", () => {
      const result = createValidGateResult();
      result.selectedSteps.push("missing-step");

      const issues = detectTampering(result);
      expect(issues.some((i) => i.includes("Missing result for selected step"))).toBe(true);
    });
  });

  describe("isShellError", () => {
    it("returns false for valid result", () => {
      const result = createValidGateResult();
      expect(isShellError(result)).toBe(false);
    });

    it("returns true for empty steps", () => {
      const result = createValidGateResult();
      result.steps = [];
      expect(isShellError(result)).toBe(true);
    });

    it("returns true for shell error patterns", () => {
      const result = createValidGateResult();
      result.steps[0].status = "failed";
      result.steps[0].output = "bash: unexpected EOF while looking for matching quote";
      expect(isShellError(result)).toBe(true);
    });

    it("returns true for command not found", () => {
      const result = createValidGateResult();
      result.steps[0].status = "failed";
      result.steps[0].output = "zsh: command not found: somecmd";
      expect(isShellError(result)).toBe(true);
    });
  });
});

// ============ ACCEPTANCE TEST: FAKE GATE CANNOT MERGE ============

describe("Acceptance: Fake/Partial gate cannot lead to merge", () => {
  it("rejects a gate with tampered signature", () => {
    const keys = generateNodeKeyPair("node-1");
    const result = createValidGateResult();
    const signed = signGateResult(result, keys.privateKey, keys.publicKey);

    // Tamper: change status from "passed" to "failed" after signing
    signed.result.status = "failed";

    const verification = verifySignedGateResult(signed);
    expect(verification.valid).toBe(false);
  });

  it("rejects a gate with wrong commit SHA", () => {
    const keys = generateNodeKeyPair("node-1");
    const result = createValidGateResult();
    const signed = signGateResult(result, keys.privateKey, keys.publicKey);

    const verification = verifyGateResultIntegrity(signed, {
      commitSha: "different-sha",
      branch: result.branch,
      pipelineId: result.pipelineId,
      nodeId: result.nodeId,
      nodePublicKey: keys.publicKey,
    });

    expect(verification.valid).toBe(false);
  });

  it("rejects a gate that is a shell error", () => {
    const result = createValidGateResult();
    result.steps[0].status = "failed";
    result.steps[0].output = "/bin/bash: -c: line 1: unexpected EOF while looking for matching quote";
    result.status = "failed";

    expect(isShellError(result)).toBe(true);
  });

  it("rejects a gate with missing steps", () => {
    const result = createValidGateResult();
    result.selectedSteps = ["lint", "typecheck", "unit-tests"];
    result.steps = [{ name: "lint", status: "passed", durationMs: 100 }];
    // Missing typecheck and unit-tests

    const issues = detectTampering(result);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a gate marked passed with failed steps", () => {
    const result = createValidGateResult();
    result.status = "passed";
    result.steps.push({
      name: "unit-tests",
      status: "failed",
      exitCode: 1,
      durationMs: 5000,
    });

    const issues = detectTampering(result);
    expect(issues.some((i) => i.includes("failed"))).toBe(true);
  });

  it("rejects a gate from unknown node", () => {
    const keys = generateNodeKeyPair("node-1");
    const result = createValidGateResult();
    const signed = signGateResult(result, keys.privateKey, keys.publicKey);

    // Try to verify with a different node's key
    const otherKeys = generateNodeKeyPair("node-2");
    const verification = verifySignedGateResult(signed, otherKeys.publicKey);

    expect(verification.valid).toBe(false);
  });
});

// ============ HELPERS ============

function createValidGateResult(): GateResult {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 5000).toISOString();
  const completedAt = now.toISOString();

  return {
    id: "gate-test123",
    pipelineId: "example-backend",
    commitSha: "abc123def456",
    branch: "feat/example",
    projectId: "test-project",
    nodeId: "node-1",
    status: "passed",
    steps: [
      {
        name: "lint",
        status: "passed",
        exitCode: 0,
        durationMs: 2000,
        startedAt: new Date(now.getTime() - 4500).toISOString(),
        completedAt: new Date(now.getTime() - 2500).toISOString(),
      },
      {
        name: "typecheck",
        status: "passed",
        exitCode: 0,
        durationMs: 2500,
        startedAt: new Date(now.getTime() - 2500).toISOString(),
        completedAt: completedAt,
      },
    ],
    selectedSteps: ["lint", "typecheck"],
    durationMs: 5000,
    startedAt,
    completedAt,
    pipelineVersion: "abc12345",
  };
}

// ============ SIGNATURE COVERAGE AND SKIPPED-STEP PASSES ============

describe("Signature covers nested step fields", () => {
  const keys = generateNodeKeyPair("node-1");

  it.each([
    ["output", (r: GateResult) => { r.steps[0].output = "all tests passed (edited)"; }],
    ["name", (r: GateResult) => { r.steps[0].name = "renamed"; }],
    ["exitCode", (r: GateResult) => { r.steps[0].exitCode = 1; }],
    ["error", (r: GateResult) => { r.steps[0].error = "added later"; }],
  ] as const)("fails verification when a step's %s changes after signing", (_field, mutate) => {
    const result = createValidGateResult();
    result.steps[0].output = "ok";
    const signed = signGateResult(result, keys.privateKey, keys.publicKey);
    mutate(signed.result);
    expect(verifySignedGateResult(signed, keys.publicKey).valid).toBe(false);
  });

  it("does not depend on key order", () => {
    const result = createValidGateResult();
    const signed = signGateResult(result, keys.privateKey, keys.publicKey);
    // Same data, keys in reverse order at both levels
    const shuffled = Object.fromEntries(Object.entries(result).reverse()) as GateResult;
    shuffled.steps = shuffled.steps.map(
      (s) => Object.fromEntries(Object.entries(s).reverse()) as typeof s,
    );
    expect(verifySignedGateResult({ ...signed, result: shuffled }, keys.publicKey).valid).toBe(true);
  });

  it("canonicalJson sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined, e: null }] })).toBe(
      '{"a":[{"d":1,"e":null}],"b":1}',
    );
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });
});

describe("All-skipped results never count as passed", () => {
  function allSkipped(): GateResult {
    const result = createValidGateResult();
    result.steps = result.steps.map((s) => ({
      name: s.name,
      status: "skipped" as const,
      error: "Step not executed",
    }));
    return result;
  }

  it("detectTampering flags a passed result with only skipped steps", () => {
    const issues = detectTampering(allSkipped());
    expect(issues).toContain("Result marked passed but no step passed");
  });

  it("validateGateResult rejects a passed result with only skipped steps", () => {
    const pipeline = createExamplePipeline();
    const result = allSkipped();
    result.pipelineId = pipeline.id;
    result.pipelineVersion = computePipelineVersion(pipeline);
    result.selectedSteps = pipeline.steps.map((s) => s.name);
    result.steps = pipeline.steps.map((s) => ({ name: s.name, status: "skipped" as const }));
    const errors = validateGateResult(result, pipeline);
    expect(errors).toContain("Result marked as passed but no step passed");
  });

  it("validateGateResult rejects a passed result with a skipped step", () => {
    const pipeline = createExamplePipeline();
    const result = createValidGateResult();
    result.pipelineId = pipeline.id;
    result.pipelineVersion = computePipelineVersion(pipeline);
    result.selectedSteps = pipeline.steps.map((s) => s.name);
    result.steps = pipeline.steps.map((s, i) => ({
      name: s.name,
      status: i === 0 ? ("passed" as const) : ("skipped" as const),
    }));
    expect(validateGateResult(result, pipeline).length).toBeGreaterThan(0);
  });
});
