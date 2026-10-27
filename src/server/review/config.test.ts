import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { DEFAULT_REVIEWERS, agentFromBranch, compileBranchTemplate, parseReviewConfig } from "./config.js";
import { parseTriageConfig } from "../triage/config.js";

const project = { github: "example-org/demo" };
const gate = { gate: { source: "checks", required: ["build"] } };

describe("parseReviewConfig", () => {
  it("is off without a review: block, and on with defaults when enabled", () => {
    const off = parseReviewConfig(undefined, project);
    expect(off.ok && off.settings.enabled).toBe(false);

    const on = parseReviewConfig({ enabled: true, merge: gate }, project);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.settings).toMatchObject({
      repo: "example-org/demo",
      apiUrl: "https://api.github.com",
      tokenEnv: "GITHUB_TOKEN",
      defaultBranch: null,
      reviewers: DEFAULT_REVIEWERS,
      integrity: { enabled: true, blockingTiers: ["red"] },
      merge: {
        gate: { source: "checks", required: [{ name: "build", app: "github-actions" }], statusCreators: [] },
        method: "auto",
        localStrategy: "ff-only",
        hostMethod: "squash",
        requireUpToDate: true,
        hostEmailPrivate: null,
        allowedEmails: ["*@users.noreply.github.com"],
        holdWhenDefaultRed: true,
        holdExemptLabels: [],
      },
    });
    expect(on.settings.tiers.default).toBe("amber");
  });

  it("requires a gate, and refuses unknown keys, reviewer names and branch patterns it can't use", () => {
    const errorsOf = (raw: unknown) => {
      const parsed = parseReviewConfig(raw, project);
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errorsOf({ enabled: true })).toEqual([
      "review.merge.gate: required (a merge needs a passing gate at the head)",
    ]);
    expect(errorsOf({ enabled: true, merge: { gate: { source: "checks", required: [] } } })[0]).toContain(
      "review.merge.gate.required",
    );
    expect(errorsOf({ enabled: true, merge: gate, reviewers: { red: ["anyone"] } })[0]).toContain(
      "use human, peer, self or agent:<id>",
    );
    expect(errorsOf({ enabled: true, merge: gate, colour: "red" })[0]).toContain("Unrecognized key");
    expect(errorsOf({ enabled: true, merge: gate, authors: { branch_pattern: "agent/**" } })).toEqual([
      "review.authors.branch_pattern: needs {agent} exactly once (e.g. agent/{agent}/**)",
    ]);
    expect(errorsOf({ enabled: true, merge: gate, authors: { branch_pattern: "^(a+)+$" } })[0]).toContain(
      "use letters, digits",
    );
    expect(parseReviewConfig({ enabled: true, merge: gate }, { github: "" }).ok).toBe(false);
  });

  it("reads a signed gate with its node keys and pipeline versions", () => {
    const parsed = parseReviewConfig(
      {
        enabled: true,
        merge: {
          gate: { source: "signed", required: ["backend"], node_keys: { "node-1": "PUBLIC KEY" }, pipeline_versions: { backend: "v1" } },
          method: "local",
          local_strategy: "squash",
          identity: { name: "Release Bot", email: "12345+release@users.noreply.github.com" },
        },
      },
      project,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.merge.gate).toEqual({
      source: "signed",
      required: ["backend"],
      nodeKeys: { "node-1": "PUBLIC KEY" },
      pipelineVersions: { backend: "v1" },
      fromTriage: false,
    });
    expect(parsed.settings.merge.allowedEmails).toEqual([
      "12345+release@users.noreply.github.com",
      "*@users.noreply.github.com",
    ]);
    // No pre-merge check and no automatic merge unless asked for
    expect(parsed.settings.merge).toMatchObject({ checkCmd: null, checkTimeoutSeconds: 300, auto: false, autoMinIntervalSeconds: 120 });
  });

  it("parses the documented gates-from-an-external-queue example: from triage, any of, check_cmd, auto off", () => {
    const doc = readFileSync(new URL("../../../docs/configuration.md", import.meta.url), "utf-8");
    const section = doc.slice(doc.indexOf("### Gates from an external queue through triage"));
    const start = section.indexOf("```yaml") + "```yaml".length;
    const example = parseYaml(section.slice(start, section.indexOf("```", start))) as { review: unknown; triage: unknown };
    const parsed = parseReviewConfig(example.review, project);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    if (!parsed.ok) return;
    expect(parsed.settings.merge).toMatchObject({
      gate: {
        source: "signed",
        fromTriage: true,
        required: [{ anyOf: ["backend", "docs"] }],
        pipelineVersions: { backend: "1", docs: "1" },
      },
      method: "local",
      localStrategy: "ff-only",
      checkCmd: ["/opt/checks/migration-order", "--pr", "{pr}", "--head={head}"],
      checkTimeoutSeconds: 300,
      auto: false,
    });
    const gate = parsed.settings.merge.gate;
    expect(gate.source === "signed" && gate.nodeKeys["ci-gates"]).toContain("-----BEGIN PUBLIC KEY-----\n");
    expect(parseTriageConfig(example.triage).ok).toBe(true);
  });
});

describe("required checks", () => {
  it("names the app that must have made each check run, GitHub Actions by default", () => {
    const parsed = parseReviewConfig(
      {
        enabled: true,
        merge: {
          gate: {
            source: "checks",
            required: ["build", { name: "deploy-preview", app: "example-ci" }, { name: "scan", app: 42 }],
            status_creators: ["release-bot"],
          },
        },
      },
      project,
    );
    expect(parsed.ok && parsed.settings.merge.gate).toEqual({
      source: "checks",
      required: [
        { name: "build", app: "github-actions" },
        { name: "deploy-preview", app: "example-ci" },
        { name: "scan", app: "42" },
      ],
      statusCreators: ["release-bot"],
    });
  });
});

describe("branch templates", () => {
  it("captures the agent id with a matcher that can't backtrack badly, and ignores overlong branch names", () => {
    const pattern = compileBranchTemplate("agent/{agent}/**");
    if (typeof pattern === "string") throw new Error(pattern);
    expect(agentFromBranch(pattern, "agent/worker-a/feature/x")).toBe("worker-a");
    expect(agentFromBranch(pattern, "feature/worker-a")).toBeNull();
    expect(agentFromBranch(pattern, `agent/worker-a/${"a".repeat(300)}`)).toBeNull();
    const started = Date.now();
    expect(agentFromBranch(pattern, `agent/${"a".repeat(240)}!`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    expect(compileBranchTemplate("{agent}/**/x/**")).toBe("** may appear at most once");
    expect(compileBranchTemplate("{agent}-{agent}")).toBe("needs {agent} exactly once");
  });
});
