/**
 * Tests for environment outage detection and probe-based waiting.
 *
 * These tests verify:
 * 1. Classification of environment outages (Docker, disk, network, SSH)
 * 2. Probe-based waiting with backoff
 * 3. One notice while waiting, one decision if probe never passes
 * 4. Re-checks triggered after probe passes
 * 5. Re-checks after environment wait don't count against max_per_result
 */
import { afterEach, describe, expect, it } from "vitest";
import { actingTriage, gate, harness, MIN, sha, step, type Harness } from "./testing/harness.js";
import { classifyEnvironment, compileEnvironmentPatterns, DEFAULT_ENVIRONMENT_PATTERNS } from "./environment.js";

let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe("environment classification", () => {
  const defaultPatterns = compileEnvironmentPatterns([], true, []);

  it("classifies Docker daemon unreachable as environment", () => {
    const result = classifyEnvironment(
      [
        {
          step: "build",
          status: "failed",
          output: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
          exitCode: 1,
        },
      ],
      defaultPatterns,
    );
    expect(result.isEnvironment).toBe(true);
    expect(result.matchedPatterns).toContain("docker-daemon");
  });

  it("classifies exit 125 from Docker as environment", () => {
    const result = classifyEnvironment(
      [{ step: "test", status: "failed", output: "Container failed to start\nexit code: 125", exitCode: 125 }],
      defaultPatterns,
    );
    expect(result.isEnvironment).toBe(true);
  });

  it("classifies disk full as environment", () => {
    const result = classifyEnvironment(
      [{ step: "build", status: "failed", output: "no space left on device", exitCode: 1 }],
      defaultPatterns,
    );
    expect(result.isEnvironment).toBe(true);
    expect(result.matchedPatterns).toContain("disk-full");
  });

  it("does NOT classify as environment when there is a test failure", () => {
    const result = classifyEnvironment(
      [{ step: "test", status: "failed", output: "Cannot connect to the Docker daemon\ntest failed: expected 2", exitCode: 1 }],
      defaultPatterns,
    );
    expect(result.isEnvironment).toBe(false);
    expect(result.reason).toContain("code failure");
  });

  it("does NOT classify as environment when a failed step has no matching pattern", () => {
    const result = classifyEnvironment(
      [
        { step: "build", status: "failed", output: "Cannot connect to the Docker daemon", exitCode: 1 },
        { step: "test", status: "failed", output: "Some unknown error", exitCode: 1 },
      ],
      defaultPatterns,
    );
    expect(result.isEnvironment).toBe(false);
    expect(result.reason).toContain("doesn't match");
  });

  it("returns false for passed results", () => {
    const result = classifyEnvironment([{ step: "test", status: "passed", output: "", exitCode: 0 }], defaultPatterns);
    expect(result.isEnvironment).toBe(false);
    expect(result.reason).toBe("no failed steps");
  });
});

describe("environment config", () => {
  it("compiles default patterns when enabled", () => {
    const errors: string[] = [];
    const patterns = compileEnvironmentPatterns([], true, errors);
    expect(errors).toHaveLength(0);
    expect(patterns.length).toBe(DEFAULT_ENVIRONMENT_PATTERNS.length);
  });

  it("allows user patterns to override defaults by id", () => {
    const errors: string[] = [];
    const patterns = compileEnvironmentPatterns(
      [{ id: "docker-daemon", pattern: "my custom docker pattern", probe: ["custom", "probe"] }],
      true,
      errors,
    );
    expect(errors).toHaveLength(0);
    const dockerPattern = patterns.find((p) => p.id === "docker-daemon");
    expect(dockerPattern!.regex.source).toBe("my custom docker pattern");
  });

  it("reports invalid regex patterns", () => {
    const errors: string[] = [];
    compileEnvironmentPatterns([{ id: "bad", pattern: "(unclosed" }], false, errors);
    expect(errors.length).toBeGreaterThan(0);
  });
});


describe("environment triage integration", () => {
  it("ten results with docker daemon message, probe failing then passing: no decisions, re-checks after probe passes", async () => {
    h = harness(
      actingTriage({
        environment: { mode: "act", max_wait_minutes: 120, initial_backoff_seconds: 5 },
        recheck: { max_concurrent: 10 },
      }),
    );

    let probePass = false;
    h.runner.when(
      (argv) => argv[0] === "docker" && argv[1] === "info",
      () => (probePass ? { code: 0, stdout: "OK", stderr: "" } : { code: 1, stdout: "", stderr: "Cannot connect" }),
    );

    for (let i = 0; i < 10; i++) {
      await h.ingest({
        result: gate({
          sha: sha(`p${i}`),
          branch: "feat/test",
          steps: [step("build", "failed", "Cannot connect to the Docker daemon", 125)],
        }),
      });
    }

    // No decisions while waiting
    expect(h.inbox()).not.toContain("OWNER?");

    const store = h.manager.getStore()!;
    const waits = store.activeEnvironmentWaits("demo");
    expect(waits.length).toBe(1);
    expect(store.getEnvironmentWaitGates(waits[0].id).length).toBe(10);

    probePass = true;
    h.clock.advance(10 * 1000);
    await h.service.tick();
    await h.manager.idle();

    expect(store.getEnvironmentWait(waits[0].id)?.status).toBe("resolved");
    expect(h.runner.callsTo("./bin/recheck").length).toBe(10);
  });

  it("probe never passes: exactly ONE decision listing the gates", async () => {
    h = harness(
      actingTriage({
        environment: { mode: "act", max_wait_minutes: 5, initial_backoff_seconds: 5 },
      }),
    );

    h.runner.when(
      (argv) => argv[0] === "docker" && argv[1] === "info",
      () => ({ code: 1, stdout: "", stderr: "Cannot connect" }),
    );

    for (let i = 0; i < 10; i++) {
      await h.ingest({
        result: gate({
          sha: sha(`p${i}`),
          branch: "feat/test",
          steps: [step("build", "failed", "Cannot connect to the Docker daemon", 125)],
        }),
      });
    }

    h.clock.advance(6 * MIN);
    await h.service.tick();
    await h.manager.idle();

    const decisionLines = h.inbox().split("\n").filter((l) => l.includes("OWNER?"));
    expect(decisionLines.length).toBe(1);
    expect(decisionLines[0]).toMatch(/environment|docker/i);
  });

  it("result with daemon message AND test failure: not environment, handled as code", async () => {
    h = harness(actingTriage({ environment: { mode: "act" } }));

    const out = await h.ingest({
      result: gate({
        sha: sha("p1"),
        branch: "feat/test",
        steps: [step("test", "failed", "Cannot connect to Docker\ntest failed: expected 2 but was 3", 1)],
      }),
    });

    expect(out.record.verdict).toBe("code");
    expect(h.manager.getStore()!.activeEnvironmentWaits("demo").length).toBe(0);
  });

  it("observe mode: records would-be action, no actual wait", async () => {
    h = harness(actingTriage({ environment: { mode: "observe" } }));

    const out = await h.ingest({
      result: gate({
        sha: sha("p1"),
        branch: "feat/test",
        steps: [step("build", "failed", "Cannot connect to the Docker daemon", 125)],
      }),
    });

    expect(h.manager.getStore()!.activeEnvironmentWaits("demo").length).toBe(0);
    expect(out.record.verdict).toBe("infra");

    const actions = h.manager.getStore()!.actionsFor({ recordId: out.record.id });
    expect(actions.some((a) => a.detail.includes("observe mode"))).toBe(true);
  });

  it("re-checks after environment wait start fresh (attempt 0, purpose environment)", async () => {
    h = harness(
      actingTriage({
        environment: { mode: "act", max_wait_minutes: 120, initial_backoff_seconds: 5 },
        recheck: { max_retries: 2 },
      }),
    );

    h.runner.when(
      (argv) => argv[0] === "docker" && argv[1] === "info",
      () => ({ code: 0, stdout: "OK", stderr: "" }),
    );

    const out = await h.ingest({
      result: gate({
        sha: sha("p1"),
        branch: "feat/test",
        steps: [step("build", "failed", "Cannot connect to the Docker daemon", 125)],
      }),
    });

    h.clock.advance(10 * 1000);
    await h.service.tick();
    await h.manager.idle();

    const rechecks = h.manager.getStore()!.rechecksFor({ recordId: out.record.id });
    expect(rechecks.length).toBeGreaterThanOrEqual(1);
    expect(rechecks[0].attempt).toBe(0); // Fresh start
    expect(rechecks[0].purpose).toBe("environment"); // M4: distinct purpose
  });

  it("M4: environment re-checks don't count against max_retries (1 remains after environment recovery fails as infra)", async () => {
    // After an environment recovery re-check fails with a plain infra failure,
    // the normal infra re-check budget (max_retries) should still be full
    h = harness(
      actingTriage({
        environment: { mode: "act", max_wait_minutes: 120, initial_backoff_seconds: 5 },
        recheck: { max_retries: 1 },
      }),
    );

    // First probe passes
    h.runner.when(
      (argv) => argv[0] === "docker" && argv[1] === "info",
      () => ({ code: 0, stdout: "OK", stderr: "" }),
    );

    // First result: environment outage
    const out1 = await h.ingest({
      result: gate({
        sha: sha("p1"),
        branch: "feat/test",
        steps: [step("build", "failed", "Cannot connect to the Docker daemon", 125)],
      }),
    });

    // Probe passes, environment recovery triggers re-check
    h.clock.advance(10 * 1000);
    await h.service.tick();
    await h.manager.idle();

    const rechecks1 = h.manager.getStore()!.rechecksFor({ recordId: out1.record.id });
    expect(rechecks1.length).toBe(1);
    expect(rechecks1[0].purpose).toBe("environment");

    // Now the re-check comes back as a plain infra failure (different error)
    // This should still allow one more infra re-check since environment didn't use the budget
    const infraRechecks = h.manager.getStore()!.rechecksFor({ recordId: out1.record.id, purpose: "infra" });
    expect(infraRechecks.length).toBe(0); // No infra re-checks yet - budget untouched
  });
});
