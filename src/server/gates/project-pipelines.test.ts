/**
 * The `pipelines:` and `executors:` config blocks: defaults, lanes as gate
 * pipelines, and the values refused because they would reach a workflow or
 * a shell.
 */
import { describe, expect, it } from "vitest";
import { displayCommand, parsePipelineConfig, shellQuote } from "./project-pipelines.js";

const ONE_STEP = { gate: { steps: [{ name: "test", run: ["npm", "test"] }] } };

function errorsOf(pipelines: unknown, executors?: unknown): string[] {
  const parsed = parsePipelineConfig(pipelines, executors, "example-org/example-app");
  return parsed.ok ? [] : parsed.errors;
}

describe("parsePipelineConfig", () => {
  it("applies the defaults a newcomer gets", () => {
    const parsed = parsePipelineConfig(ONE_STEP, undefined, "example-org/example-app");
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const { pipelines, executors } = parsed.settings;
    expect(executors.order).toEqual(["github", "nodes", "local"]);
    expect(executors.github).toMatchObject({
      repo: "example-org/example-app",
      tokenEnv: "LAIR_GITHUB_TOKEN",
      workflow: "lair-gates.yml",
      hosted: true,
      selfHosted: true,
      selfHostedLabels: ["self-hosted"],
      monthlyMinutes: 0,
      pickupTimeoutMinutes: 10,
      unavailableMinutes: 30,
    });
    expect(executors.local).toMatchObject({ maxParallel: 1, minFreeRamMb: 1024, workdir: "worktree" });
    expect(pipelines[0]).toMatchObject({ name: "gate", timeoutSeconds: 7200 });
    expect(pipelines[0].lanes).toHaveLength(1);
    expect(pipelines[0].lanes[0]).toMatchObject({ name: "default", order: ["github", "nodes", "local"] });
    expect(pipelines[0].lanes[0].gate).toMatchObject({
      id: "gate.default",
      defaultSteps: ["test"],
      steps: [{ name: "test", command: "npm test", argv: ["npm", "test"], timeoutSeconds: 1800 }],
    });
  });

  it("splits steps into lanes, each with its own executor order", () => {
    const parsed = parsePipelineConfig(
      {
        gate: {
          steps: [
            { name: "lint", run: ["npm", "run", "lint"], lane: "quick", timeout_minutes: 2 },
            { name: "test", run: ["npm", "test"], continue_on_failure: true, env: { CI: "1" } },
            { name: "e2e", run: ["npm", "run", "e2e"], lane: "quick" },
          ],
          lanes: { quick: { executors: ["local"] } },
        },
      },
      { order: ["github", "local"] },
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const lanes = parsed.settings.pipelines[0].lanes;
    expect(lanes.map((l) => [l.name, l.order, l.steps.map((s) => s.name)])).toEqual([
      ["quick", ["local"], ["lint", "e2e"]],
      ["default", ["github", "local"], ["test"]],
    ]);
    expect(lanes[1].gate.steps[0]).toMatchObject({ continueOnFailure: true, env: { CI: "1" } });
    expect(lanes[0].gate.steps[0].timeoutSeconds).toBe(120);
  });

  it("refuses text GitHub would evaluate or a shell would split", () => {
    expect(errorsOf({ gate: { steps: [{ name: "x", run: ["echo", "${{ secrets.TOKEN }}"] }] } })[0]).toContain(
      "must not contain ${{",
    );
    expect(errorsOf({ gate: { steps: [{ name: "x", run: ["echo", "a\nb"] }] } })[0]).toContain(
      "must not contain newlines or control characters",
    );
    expect(
      errorsOf({ gate: { steps: [{ name: "x", run: ["npm"], env: { A: "${{ github.token }}" } }] } })[0],
    ).toContain("must not contain ${{");
    expect(errorsOf({ gate: { steps: [{ name: "x", run: [""] }] } })[0]).toContain("the program (first item) is empty");
    expect(errorsOf({ gate: { steps: [{ name: "x", run: "npm test" }] } })[0]).toContain("pipelines.gate.steps.0.run");
  });

  it("refuses reserved, duplicate and unsafe names", () => {
    expect(errorsOf({ gate: { steps: [{ name: "lair-checkout", run: ["true"] }] } })[0]).toContain("reserved");
    expect(errorsOf({ gate: { steps: [{ name: "bad name", run: ["true"] }] } })[0]).toContain("step names use");
    expect(
      errorsOf({
        gate: {
          steps: [
            { name: "a", run: ["true"] },
            { name: "a", run: ["true"] },
          ],
        },
      }),
    ).toEqual(["pipelines.gate.steps: duplicate step name a"]);
    expect(errorsOf({ "bad pipeline": ONE_STEP.gate })[0]).toContain("pipeline names use");
    expect(errorsOf({ gate: { steps: [{ name: "a", run: ["true"], env: { GITHUB_TOKEN: "x" } }] } })[0]).toContain(
      "reserved",
    );
  });

  it("refuses lanes no step uses, unknown keys and bad executor settings", () => {
    expect(errorsOf({ gate: { ...ONE_STEP.gate, lanes: { heavy: { executors: ["local"] } } } })).toEqual([
      "pipelines.gate.lanes.heavy: no step uses this lane",
    ]);
    expect(errorsOf({ gate: { ...ONE_STEP.gate, cache: true } })[0]).toContain("Unrecognized key");
    expect(errorsOf(ONE_STEP, { order: ["local", "local"] })[0]).toContain("an executor is listed twice");
    expect(errorsOf(ONE_STEP, { order: ["cloud"] })[0]).toContain("executors.order.0");
    expect(errorsOf(ONE_STEP, { github: { repo: "not a repo" } })[0]).toContain("use owner/name");
    expect(errorsOf(ONE_STEP, { github: { token: "abc" } })[0]).toContain("Unrecognized key");
    expect(errorsOf(ONE_STEP, { github: { monthly_minutes: -1 } })[0]).toContain("executors.github.monthly_minutes");
    expect(errorsOf(ONE_STEP, { local: { workdir: "tmp" } })[0]).toContain("executors.local.workdir");
  });

  it("has no repository when neither executors.github.repo nor the project's github is owner/name", () => {
    const parsed = parsePipelineConfig(ONE_STEP, undefined, "not-a-repo");
    expect(parsed.ok && parsed.settings.executors.github.repo).toBeNull();
  });
});

describe("command display and quoting", () => {
  it("quotes only the arguments that need it, and always safely", () => {
    expect(displayCommand(["npm", "run", "lint"])).toBe("npm run lint");
    expect(displayCommand(["echo", "a b", "it's", "$HOME"])).toBe(`echo 'a b' 'it'\\''s' '$HOME'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});
