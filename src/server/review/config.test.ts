import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEWERS, parseReviewConfig } from "./config.js";

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
        gate: { source: "checks", required: ["build"] },
        method: "auto",
        localStrategy: "ff-only",
        hostMethod: "squash",
        requireUpToDate: true,
        hostEmailPrivate: null,
        allowedEmails: ["*@users.noreply.github.com"],
        holdWhenDefaultRed: true,
        holdExemptLabels: ["revert"],
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
    expect(errorsOf({ enabled: true, merge: gate, authors: { branch_pattern: "^agent/" } })).toEqual([
      "review.authors.branch_pattern: needs a named group (?<agent>...)",
    ]);
    expect(errorsOf({ enabled: true, merge: gate, authors: { branch_pattern: "(" } })[0]).toContain(
      "not a valid regular expression",
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
    });
    expect(parsed.settings.merge.allowedEmails).toEqual([
      "12345+release@users.noreply.github.com",
      "*@users.noreply.github.com",
    ]);
  });
});
