/**
 * The generated workflow file (structure, least privilege, input
 * validation, no self-hosted option for public repositories) and the
 * parsing and redaction of the logs it writes.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parsePipelineConfig, type ProjectPipelineSettings } from "../project-pipelines.js";
import {
  generateWorkflow,
  laneJobName,
  parseStepLogs,
  readWorkflowVersion,
  redactSecrets,
  workflowVersion,
} from "./github-workflow.js";

function settings(pipelines: unknown, executors?: unknown): ProjectPipelineSettings {
  const parsed = parsePipelineConfig(pipelines, executors, "example-org/example-app");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.settings;
}

const PIPELINES = {
  gate: {
    steps: [
      { name: "lint", run: ["npm", "run", "lint"], timeout_minutes: 5 },
      { name: "test", run: ["npm", "test", "--", "--grep=it's fine"], continue_on_failure: true, env: { CI: "1" } },
      { name: "e2e", run: ["npm", "run", "e2e"], lane: "heavy" },
    ],
  },
};

interface Workflow {
  name: string;
  "run-name": string;
  on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[] }> } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      name: string;
      if: string;
      "runs-on": string;
      "timeout-minutes": number;
      steps: { name: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean; "timeout-minutes"?: number }[];
    }
  >;
}

function workflowFor(s: ProjectPipelineSettings, allowSelfHosted: boolean) {
  const options = { project: "demo", pipelines: s.pipelines, github: s.executors.github, allowSelfHosted };
  const content = generateWorkflow(options);
  return { content, doc: parseYaml(content) as Workflow, version: workflowVersion(options) };
}

describe("generateWorkflow", () => {
  it("writes one least-privilege job per lane that validates its inputs and marks every step", () => {
    const s = settings(PIPELINES);
    const { content, doc, version } = workflowFor(s, true);

    expect(readWorkflowVersion(content)).toBe(version);
    expect(doc["run-name"]).toBe("lair ${{ inputs.lair_run }}");
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["lair_run", "sha", "job", "runner"]);
    expect(doc.on.workflow_dispatch.inputs.job.options).toEqual(["gate.default", "gate.heavy"]);
    expect(doc.on.workflow_dispatch.inputs.runner.options).toEqual(["hosted", "self-hosted"]);
    expect(doc.permissions).toEqual({ contents: "read" });

    const jobs = Object.values(doc.jobs);
    expect(jobs.map((j) => j.name)).toEqual(s.pipelines[0].lanes.map((l) => laneJobName("gate", l)));
    const job = jobs[0];
    expect(job.if).toBe("inputs.job == 'gate.default'");
    expect(job["runs-on"]).toBe(
      `\${{ inputs.runner == 'self-hosted' && fromJSON('["self-hosted"]') || 'ubuntu-latest' }}`,
    );
    expect(job.steps.map((st) => st.name)).toEqual(["lair-inputs", "lair-checkout", "lint", "test"]);
    // Inputs reach the script only as environment variables, validated before the checkout
    expect(job.steps[0].env).toEqual({ LAIR_RUN: "${{ inputs.lair_run }}", LAIR_SHA: "${{ inputs.sha }}" });
    expect(job.steps[0].run).toContain('[[ "$LAIR_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(job.steps[1]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { ref: "${{ inputs.sha }}", "persist-credentials": false },
    });
    for (const step of job.steps.slice(2)) expect(step.run ?? "").not.toContain("${{");
    expect(job.steps[2]["timeout-minutes"]).toBe(5);
    expect(job.steps[2].run).toBe(
      [
        'echo "lair-step-start lint"',
        "set +e",
        "'npm' 'run' 'lint'",
        "rc=$?",
        'echo "lair-step-exit lint $rc"',
        "exit $rc",
        "",
      ].join("\n"),
    );
    expect(job.steps[3]).toMatchObject({ "continue-on-error": true, env: { CI: "1" } });
    expect(job.steps[3].run).toContain(`'npm' 'test' '--' '--grep=it'\\''s fine'`);
  });

  it("has no self-hosted option at all for a public repository", () => {
    const { content, doc } = workflowFor(settings(PIPELINES), false);
    expect(content).not.toContain("self-hosted");
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["lair_run", "sha", "job"]);
    expect(Object.values(doc.jobs).every((j) => j["runs-on"] === "ubuntu-latest")).toBe(true);
  });

  it("changes version when the pipelines or the runner options change", () => {
    const base = workflowFor(settings(PIPELINES), true).version;
    expect(workflowFor(settings(PIPELINES), false).version).not.toBe(base);
    const changed = {
      gate: { steps: [{ ...PIPELINES.gate.steps[0], run: ["npm", "run", "lint:fix"] }, ...PIPELINES.gate.steps.slice(1)] },
    };
    expect(workflowFor(settings(changed), true).version).not.toBe(base);
    expect(workflowFor(settings(PIPELINES, { github: { self_hosted_labels: ["self-hosted", "lair"] } }), true).version).not.toBe(base);
    expect(workflowFor(settings(PIPELINES), true).version).toBe(base);
    expect(readWorkflowVersion("name: something else\n")).toBeNull();
  });
});

describe("parseStepLogs", () => {
  it("reads each step's exit code and output from its markers, ignoring the echoed script", () => {
    const ts = "2026-03-02T12:00:00.1234567Z";
    const log = [
      `\uFEFF${ts} ##[group]Run echo "lair-step-start lint"`,
      `${ts} echo "lair-step-start lint"`,
      `${ts} echo "lair-step-exit lint $rc"`,
      `${ts} ##[endgroup]`,
      `${ts} lair-step-start lint`,
      `${ts} checked 12 files`,
      `${ts} lair-step-exit lint 0`,
      `${ts} ##[group]Run echo "lair-step-start test"`,
      `${ts} ##[endgroup]`,
      `${ts} lair-step-start test`,
      `${ts} lair-step-exit lint 0`,
      `${ts} 2 failed`,
      `${ts} lair-step-exit test 2`,
      `${ts} ##[error]Process completed with exit code 2.`,
      `${ts} ##[group]Run echo "lair-step-start e2e"`,
      `${ts} lair-step-start e2e`,
      `${ts} ##[error]The action has timed out.`,
    ].join("\r\n");
    const steps = parseStepLogs(log);
    expect(steps.get("lint")).toEqual({ exitCode: 0, output: "checked 12 files", timedOut: false });
    // A marker for another step inside a step's output is just output
    expect(steps.get("test")).toEqual({ exitCode: 2, output: "lair-step-exit lint 0\n2 failed", timedOut: false });
    expect(steps.get("e2e")).toMatchObject({ exitCode: undefined, timedOut: true });
  });
});

describe("redactSecrets", () => {
  it("removes tokens, authorization values and URL credentials", () => {
    // Built at runtime so the source holds no token-shaped strings
    const classic = "gh" + "p_" + "a".repeat(36);
    const fine = "github" + "_pat_" + "b".repeat(40);
    const text = [
      `token ${classic} here`,
      `fine-grained ${fine}`,
      "Authorization: Bearer abc.def",
      "https://x-access-token:" + "c".repeat(20) + "@github.com/example-org/example-app",
      "plain secret-value-123 stays unless named",
    ].join("\n");
    const out = redactSecrets(text, ["secret-value-123"]);
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fine);
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("c".repeat(20));
    expect(out).not.toContain("secret-value-123");
    expect(out).toContain("Authorization: Bearer ***");
    expect(out).toContain("https://***@github.com/example-org/example-app");
  });
});
