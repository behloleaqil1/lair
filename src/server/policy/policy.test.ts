/**
 * Policy engine tests.
 * Tests policy evaluation, merge control, and the acceptance criteria:
 * "A fake or partial gate log can never lead to a merge."
 */
import { describe, it, expect } from "vitest";
import {
  parsePolicyConfig,
  computeRiskTier,
  isWithinMergeWindow,
  checkProtectedTests,
  checkBlockedPatterns,
  createExamplePolicy,
} from "./policy-config.js";
import { evaluatePolicy } from "./policy-evaluator.js";
import {
  attemptMerge,
  createMockGitHost,
} from "./merge-controller.js";
import {
  generateNodeKeyPair,
  signGateResult,
} from "../gates/signature.js";
import type {
  PolicyConfig,
  PullRequest,
  GateResult,
  SignedGateResult,
} from "../../shared/policy-types.js";

// createValidGateResult() below runs pipeline "test-backend" at this version
const PIPELINE_VERSIONS = new Map([["test-backend", "abc12345"]]);

// ============ POLICY CONFIG TESTS ============

describe("Policy Config", () => {
  describe("parsePolicyConfig", () => {
    it("parses a valid policy", () => {
      const policy = parsePolicyConfig({
        projectId: "test",
        riskTiers: [{ patterns: ["**/*.ts"], tier: "green" }],
        reviewRequirements: {},
        requiredGates: ["backend"],
      });

      expect(policy.projectId).toBe("test");
      expect(policy.riskTiers).toHaveLength(1);
    });

    it("rejects invalid tier", () => {
      expect(() =>
        parsePolicyConfig({
          projectId: "test",
          riskTiers: [{ patterns: ["**"], tier: "invalid" }],
          reviewRequirements: {},
          requiredGates: ["backend"],
        })
      ).toThrow();
    });
  });

  describe("computeRiskTier", () => {
    const policy = createExamplePolicy();

    it("returns red for auth files", () => {
      const tier = computeRiskTier(["src/auth/login.ts"], policy.riskTiers);
      expect(tier).toBe("red");
    });

    it("returns amber for API files", () => {
      const tier = computeRiskTier(["src/api/users.ts"], policy.riskTiers);
      expect(tier).toBe("amber");
    });

    it("returns green for regular files", () => {
      const tier = computeRiskTier(["src/utils/helpers.ts"], policy.riskTiers);
      expect(tier).toBe("green");
    });

    it("returns highest tier when multiple match", () => {
      const tier = computeRiskTier(
        ["src/auth/login.ts", "src/utils/helpers.ts"],
        policy.riskTiers
      );
      expect(tier).toBe("red");
    });
  });

  describe("isWithinMergeWindow", () => {
    const windows = [
      { daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
    ];

    it("returns true during business hours", () => {
      // Monday at 10:00 UTC
      const monday10am = new Date("2026-01-05T10:00:00Z");
      expect(isWithinMergeWindow(windows, monday10am)).toBe(true);
    });

    it("returns false on weekends", () => {
      // Saturday at 10:00 UTC
      const saturday10am = new Date("2026-01-03T10:00:00Z");
      expect(isWithinMergeWindow(windows, saturday10am)).toBe(false);
    });

    it("returns false outside hours", () => {
      // Monday at 20:00 UTC
      const monday8pm = new Date("2026-01-05T20:00:00Z");
      expect(isWithinMergeWindow(windows, monday8pm)).toBe(false);
    });

    it("returns true when no windows defined", () => {
      expect(isWithinMergeWindow(undefined)).toBe(true);
      expect(isWithinMergeWindow([])).toBe(true);
    });
  });

  describe("checkProtectedTests", () => {
    const policy = createExamplePolicy();

    it("detects test skip patterns", () => {
      const diff = `
+    it.skip("should test something", () => {
+      expect(true).toBe(true);
+    });
      `;
      const { violations } = checkProtectedTests(
        policy,
        ["src/utils.test.ts"],
        diff
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("skip");
    });

    it("detects eslint-disable", () => {
      const diff = `
+    // eslint-disable-next-line
+    const x = something;
      `;
      const { violations } = checkProtectedTests(
        policy,
        ["src/auth.test.ts"],
        diff
      );
      expect(violations.length).toBeGreaterThan(0);
    });

    it("allows changes without weakening patterns", () => {
      const diff = `
+    it("should work", () => {
+      expect(add(1, 2)).toBe(3);
+    });
      `;
      const { violations } = checkProtectedTests(
        policy,
        ["src/math.test.ts"],
        diff
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("checkBlockedPatterns", () => {
    it("blocks .env files", () => {
      const blocked = checkBlockedPatterns(
        ["**/.env", "**/secrets/**"],
        [".env", "config/production.ts"]
      );
      expect(blocked).toContain(".env");
      expect(blocked).not.toContain("config/production.ts");
    });

    it("returns empty for no matches", () => {
      const blocked = checkBlockedPatterns(
        ["**/.env"],
        ["src/index.ts"]
      );
      expect(blocked).toHaveLength(0);
    });
  });
});

// ============ POLICY EVALUATOR TESTS ============

describe("Policy Evaluator", () => {
  const nodeKeys = generateNodeKeyPair("node-1");

  function createValidSignedGate(commitSha: string): SignedGateResult {
    const result = createValidGateResult(commitSha);
    return signGateResult(result, nodeKeys.privateKey, nodeKeys.publicKey);
  }

  describe("evaluatePolicy", () => {
    it("passes with valid gate and reviews", () => {
      const pr = createValidPR();
      pr.gateResults = [createValidSignedGate(pr.headSha)];
      pr.reviews = [
        {
          reviewerId: "agent-1",
          isAgent: true,
          model: "claude",
          state: "approved",
          commitSha: pr.headSha,
          submittedAt: new Date().toISOString(),
        },
      ];

      const evaluation = evaluatePolicy({
        pr,
        policy: createTestPolicy(),
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(true);
      expect(evaluation.violations).toHaveLength(0);
    });

    it("fails without required gate", () => {
      const pr = createValidPR();
      pr.gateResults = []; // No gates

      const evaluation = evaluatePolicy({
        pr,
        policy: createTestPolicy(),
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.rule === "required-gate")).toBe(true);
    });

    it("fails with gate at wrong commit", () => {
      const pr = createValidPR();
      pr.gateResults = [createValidSignedGate("wrong-commit")];

      const evaluation = evaluatePolicy({
        pr,
        policy: createTestPolicy(),
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.rule === "required-gate")).toBe(true);
    });

    it("fails with invalid signature", () => {
      const pr = createValidPR();
      const signedGate = createValidSignedGate(pr.headSha);
      // Tamper with signature
      signedGate.signature = "invalid-signature";
      pr.gateResults = [signedGate];

      const evaluation = evaluatePolicy({
        pr,
        policy: createTestPolicy(),
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.rule === "gate-signature")).toBe(true);
    });

    it("fails with unknown node", () => {
      const pr = createValidPR();
      pr.gateResults = [createValidSignedGate(pr.headSha)];

      const evaluation = evaluatePolicy({
        pr,
        policy: createTestPolicy(),
        diffContent: "",
        nodePublicKeys: new Map(), // No known nodes
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.message.includes("Unknown node"))).toBe(true);
    });

    it("fails with PR exceeding size limit", () => {
      const pr = createValidPR();
      pr.linesAdded = 1500;
      pr.gateResults = [createValidSignedGate(pr.headSha)];

      const policy = createTestPolicy();
      policy.maxPrSize = 1000;

      const evaluation = evaluatePolicy({
        pr,
        policy,
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.rule === "max-pr-size")).toBe(true);
    });

    it("fails with blocked files", () => {
      const pr = createValidPR();
      pr.changedFiles = [".env", "src/index.ts"];
      pr.gateResults = [createValidSignedGate(pr.headSha)];

      const policy = createTestPolicy();
      policy.blockedPatterns = ["**/.env"];

      const evaluation = evaluatePolicy({
        pr,
        policy,
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.some((v) => v.rule === "blocked-patterns")).toBe(true);
    });

    it("requires reviews for red tier", () => {
      const pr = createValidPR();
      pr.changedFiles = ["src/auth/login.ts"]; // Red tier
      pr.gateResults = [createValidSignedGate(pr.headSha)];
      pr.reviews = []; // No reviews

      const policy = createTestPolicy();
      policy.riskTiers = [{ patterns: ["**/auth/**"], tier: "red" }];
      policy.reviewRequirements = {
        red: { count: 2, distinctAgents: true },
      };

      const evaluation = evaluatePolicy({
        pr,
        policy,
        diffContent: "",
        nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
        expectedPipelineVersions: PIPELINE_VERSIONS,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.tier).toBe("red");
      expect(evaluation.violations.some((v) => v.rule === "review-count")).toBe(true);
    });
  });
});

// ============ MERGE CONTROLLER TESTS ============

describe("Merge Controller", () => {
  const nodeKeys = generateNodeKeyPair("node-1");

  function createValidSignedGate(commitSha: string): SignedGateResult {
    const result = createValidGateResult(commitSha);
    return signGateResult(result, nodeKeys.privateKey, nodeKeys.publicKey);
  }

  it("merges when policy passes", async () => {
    const pr = createValidPR();
    pr.gateResults = [createValidSignedGate(pr.headSha)];

    const mergeRecords: any[] = [];
    const result = await attemptMerge({
      prNumber: 123,
      initiatedBy: "kiro-A",
      policy: createTestPolicy(),
      nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
      expectedPipelineVersions: PIPELINE_VERSIONS,
      gitHost: createMockGitHost(pr, ""),
      storeMergeRecord: async (record) => {
        mergeRecords.push(record);
      },
    });

    expect(result.success).toBe(true);
    expect(result.mergeRecord).toBeDefined();
    expect(mergeRecords).toHaveLength(1);
    expect(mergeRecords[0].reason).toContain("passed and verified");
  });

  it("rejects when policy fails", async () => {
    const pr = createValidPR();
    pr.gateResults = []; // No gates

    const mergeRecords: any[] = [];
    const result = await attemptMerge({
      prNumber: 123,
      initiatedBy: "kiro-A",
      policy: createTestPolicy(),
      nodePublicKeys: new Map([["node-1", nodeKeys.publicKey]]),
      expectedPipelineVersions: PIPELINE_VERSIONS,
      gitHost: createMockGitHost(pr, ""),
      storeMergeRecord: async (record) => {
        mergeRecords.push(record);
      },
    });

    expect(result.success).toBe(false);
    expect(result.mergeRecord).toBeUndefined();
    expect(mergeRecords).toHaveLength(0);
  });
});

// ============ ACCEPTANCE TESTS ============

describe("Acceptance: A fake or partial gate log can never lead to a merge", () => {
  const nodeKeys = generateNodeKeyPair("node-1");
  const nodePublicKeys = new Map([["node-1", nodeKeys.publicKey]]);

  function attemptMergeWith(pr: PullRequest): Promise<{ success: boolean; error?: string }> {
    return attemptMerge({
      prNumber: 123,
      initiatedBy: "test",
      policy: createTestPolicy(),
      nodePublicKeys,
      expectedPipelineVersions: PIPELINE_VERSIONS,
      gitHost: createMockGitHost(pr, ""),
      storeMergeRecord: async () => {},
    });
  }

  it("rejects merge with no gate", async () => {
    const pr = createValidPR();
    pr.gateResults = [];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required gate");
  });

  it("rejects merge with gate at wrong commit", async () => {
    const pr = createValidPR();
    const wrongCommitGate = createValidGateResult("wrong-sha-12345");
    pr.gateResults = [signGateResult(wrongCommitGate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required gate");
  });

  it("rejects merge with tampered gate signature", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    const signed = signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey);
    // Tamper
    signed.result.status = "passed";
    signed.result.steps = [];
    pr.gateResults = [signed];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid signature");
  });

  it("rejects merge with gate from unknown node", async () => {
    const pr = createValidPR();
    const unknownNodeKeys = generateNodeKeyPair("unknown-node");
    const gate = createValidGateResult(pr.headSha);
    gate.nodeId = "unknown-node";
    pr.gateResults = [signGateResult(gate, unknownNodeKeys.privateKey, unknownNodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown node");
  });

  it("rejects merge with shell error gate", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.status = "failed";
    gate.selectedSteps = ["lint"]; // Only lint step selected
    gate.steps = [
      {
        name: "lint",
        status: "failed",
        output: "/bin/bash: -c: line 1: unexpected EOF while looking for matching quote",
        durationMs: 10,
      },
    ];
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("shell error");
  });

  it("rejects merge with gate missing required steps", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    // Gate claims passed but has no step results
    gate.selectedSteps = ["lint", "typecheck", "unit-tests"];
    gate.steps = []; // Missing all steps!
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("tampering");
  });

  it("rejects merge with gate marked passed but steps failed", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.status = "passed"; // Claims passed
    gate.steps[0].status = "failed"; // But has failed step
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("tampering");
  });

  it("rejects merge with failed gate (legitimate failure)", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.status = "failed";
    gate.steps[0].status = "failed";
    gate.steps[0].exitCode = 1;
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("accepts merge with valid, signed, passed gate at correct commit", async () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];

    const result = await attemptMergeWith(pr);
    expect(result.success).toBe(true);
  });
});

// ============ HELPERS ============

function createValidGateResult(commitSha: string): GateResult {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 5000).toISOString();
  const completedAt = now.toISOString();

  return {
    id: "gate-test123",
    pipelineId: "test-backend",
    commitSha,
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
        completedAt,
      },
    ],
    selectedSteps: ["lint", "typecheck"],
    durationMs: 5000,
    startedAt,
    completedAt,
    pipelineVersion: "abc12345",
  };
}

function createValidPR(): PullRequest {
  return {
    id: "pr-123",
    number: 123,
    sourceBranch: "feat/example",
    targetBranch: "main",
    headSha: "abc123def456",
    baseSha: "base123456",
    changedFiles: ["src/index.ts"],
    linesAdded: 50,
    linesDeleted: 10,
    reviews: [],
    gateResults: [],
    projectId: "test-project",
  };
}

function createTestPolicy(): PolicyConfig {
  return {
    projectId: "test-project",
    riskTiers: [
      { patterns: ["**/*.ts"], tier: "green" },
    ],
    reviewRequirements: {
      green: { count: 0, distinctAgents: false },
    },
    requiredGates: ["test-backend"],
    protectedTests: [],
  };
}

// ============ GATE RESULT SELECTION ============

describe("Policy Evaluator: which gate result counts", () => {
  const nodeKeys = generateNodeKeyPair("node-1");
  const nodePublicKeys = new Map([["node-1", nodeKeys.publicKey]]);

  function evaluate(pr: PullRequest, versions = PIPELINE_VERSIONS) {
    return evaluatePolicy({
      pr,
      policy: createTestPolicy(),
      diffContent: "",
      nodePublicKeys,
      expectedPipelineVersions: versions,
    });
  }

  /** A signed gate result for the PR head, shifted `offsetMs` in time. */
  function gateAt(pr: PullRequest, offsetMs: number, status: "passed" | "failed"): SignedGateResult {
    const result = createValidGateResult(pr.headSha);
    const shift = (iso?: string) =>
      iso ? new Date(new Date(iso).getTime() + offsetMs).toISOString() : iso;
    result.id = `gate-${status}-${offsetMs}`;
    result.startedAt = shift(result.startedAt)!;
    result.completedAt = shift(result.completedAt)!;
    result.steps = result.steps.map((s) => ({
      ...s,
      startedAt: shift(s.startedAt),
      completedAt: shift(s.completedAt),
    }));
    if (status === "failed") {
      result.status = "failed";
      result.steps[1] = { ...result.steps[1], status: "failed", exitCode: 1 };
    }
    return signGateResult(result, nodeKeys.privateKey, nodeKeys.publicKey);
  }

  it("a newer failure beats an older pass", () => {
    const pr = createValidPR();
    pr.gateResults = [gateAt(pr, -60000, "passed"), gateAt(pr, 0, "failed")];
    const evaluation = evaluate(pr);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.map((v) => v.rule)).toContain("gate-failed");
  });

  it("a newer pass beats an older failure", () => {
    const pr = createValidPR();
    pr.gateResults = [gateAt(pr, -60000, "failed"), gateAt(pr, 0, "passed")];
    expect(evaluate(pr).passed).toBe(true);
  });

  it("ignores an untrustworthy newer result in favour of a valid older one", () => {
    const pr = createValidPR();
    const forged = gateAt(pr, 0, "failed");
    forged.signature = Buffer.from("not a signature").toString("base64");
    pr.gateResults = [forged, gateAt(pr, -60000, "passed")];
    expect(evaluate(pr).passed).toBe(true);
  });

  it("rejects a result signed for another project", () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.projectId = "other-project";
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];
    const evaluation = evaluate(pr);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.map((v) => v.rule)).toContain("gate-project");
  });

  it("rejects a result from a different pipeline version", () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.pipelineVersion = "00000000";
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];
    const evaluation = evaluate(pr);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.map((v) => v.rule)).toContain("gate-pipeline-version");
  });

  it("rejects when no expected version is configured for the gate", () => {
    const pr = createValidPR();
    pr.gateResults = [gateAt(pr, 0, "passed")];
    expect(evaluate(pr, new Map()).passed).toBe(false);
  });

  it("rejects a passed result whose steps were all skipped", () => {
    const pr = createValidPR();
    const gate = createValidGateResult(pr.headSha);
    gate.steps = gate.steps.map((s) => ({ name: s.name, status: "skipped" as const }));
    pr.gateResults = [signGateResult(gate, nodeKeys.privateKey, nodeKeys.publicKey)];
    expect(evaluate(pr).passed).toBe(false);
  });
});
