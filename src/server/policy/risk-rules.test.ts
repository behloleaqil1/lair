/**
 * Risk tiers as configuration: path globs, file kinds, change size and
 * labels decide the tier, and the result names every rule that matched.
 */
import { describe, expect, it } from "vitest";
import { parseReviewConfig } from "../review/config.js";
import { assessRisk, DEFAULT_FILE_KINDS, DEFAULT_RISK_RULES, matchPath, type ChangedFile } from "./risk-rules.js";

function files(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, additions: 5, deletions: 1 }));
}

describe("matchPath", () => {
  it("matches globs against the path, and slash-free globs against the file name", () => {
    expect(matchPath("**/auth/**", "src/auth/session.ts")).toBe(true);
    expect(matchPath("**/auth/**", "auth/session.ts")).toBe(true);
    expect(matchPath("**/auth/**", "src/author.ts")).toBe(false);
    expect(matchPath("docs/**", "docs/guide/intro.md")).toBe(true);
    expect(matchPath("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchPath("package.json", "apps/web/package.json")).toBe(true);
    expect(matchPath("requirements*.txt", "requirements-dev.txt")).toBe(true);
    expect(matchPath("*.{yml,yaml}", "deploy/app.yaml")).toBe(true);
    expect(matchPath("a+b/(x).ts", "a+b/(x).ts")).toBe(true);
  });
});

describe("assessRisk with the default rules", () => {
  const assess = (paths: string[], labels: string[] = [], additions = 5) =>
    assessRisk(
      { files: paths.map((path) => ({ path, additions, deletions: 0 })), labels },
      DEFAULT_RISK_RULES,
      DEFAULT_FILE_KINDS,
      "amber",
    );

  it("puts migrations, auth, billing and CI workflows in red, naming the rule and the file", () => {
    for (const [path, rule] of [
      ["db/migrations/0003_users.sql", "migrations"],
      ["src/auth/token.ts", "auth"],
      ["services/billing/charge.py", "billing"],
      [".github/workflows/ci.yml", "ci-workflows"],
    ]) {
      const risk = assess([path]);
      expect(risk.tier).toBe("red");
      expect(risk.rules).toEqual([expect.objectContaining({ id: rule, tier: "red", files: [path] })]);
      expect(risk.rules[0].reasons[0]).toContain(path);
    }
  });

  it("puts dependency files in amber, and docs and tests alone in green", () => {
    expect(assess(["web/package-lock.json"]).tier).toBe("amber");
    expect(assess(["web/package-lock.json"]).rules[0].reasons).toEqual(["kind dependency: web/package-lock.json"]);
    expect(assess(["docs/setup.md", "src/util.test.ts"]).tier).toBe("green");
  });

  it("gives an unmatched file the default tier, so docs plus code is not green", () => {
    const risk = assess(["docs/setup.md", "src/util.ts"]);
    expect(risk.tier).toBe("amber");
    expect(risk.files).toEqual([
      { path: "docs/setup.md", tier: "green", rules: ["docs"] },
      { path: "src/util.ts", tier: "amber", rules: [] },
    ]);
  });

  it("takes the highest tier, and size and label rules apply to the whole change", () => {
    expect(assess(["src/auth/login.test.ts"]).tier).toBe("red");
    const big = assess(["docs/a.md", "docs/b.md"], [], 300);
    expect(big.tier).toBe("amber");
    expect(big.rules.find((r) => r.id === "large-change")?.reasons).toEqual(["600 changed lines (at least 500)"]);
    const labelled = assess(["docs/a.md"], ["Security"]);
    expect(labelled.tier).toBe("red");
    expect(labelled.rules.find((r) => r.id === "security-label")?.reasons).toEqual(["label security"]);
  });

  it("counts a file renamed out of a red area as red", () => {
    const risk = assessRisk(
      { files: [{ path: "src/legacy/token.ts", previousPath: "src/auth/token.ts", additions: 0, deletions: 0 }], labels: [] },
      DEFAULT_RISK_RULES,
      DEFAULT_FILE_KINDS,
      "amber",
    );
    expect(risk.tier).toBe("red");
    expect(risk.rules[0].reasons).toEqual(["kind auth: src/auth/token.ts"]);
  });
});

describe("tiers from a project's review: block", () => {
  it("uses the configured rules, kinds, default tier and reviewers", () => {
    const parsed = parseReviewConfig(
      {
        enabled: true,
        tiers: {
          default: "green",
          file_kinds: { infra: ["terraform/**", "*.tf"] },
          rules: [
            { id: "infra", tier: "red", kinds: ["infra"] },
            { id: "api", tier: "amber", paths: ["src/api/**"], description: "Business logic" },
            { id: "hotfix", tier: "red", labels: ["hotfix"] },
            { id: "wide", tier: "amber", min_files: 3 },
          ],
        },
        reviewers: { red: [{ any_of: ["human", "agent:lead-reviewer"] }], amber: ["peer"], green: ["self"] },
        merge: { gate: { source: "checks", required: ["ci"] } },
      },
      { github: "example-org/demo" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { rules, fileKinds, default: defaultTier } = parsed.settings.tiers;
    const assess = (paths: string[], labels: string[] = []) =>
      assessRisk({ files: files(...paths), labels }, rules, fileKinds, defaultTier);

    expect(assess(["README.md"]).tier).toBe("green");
    expect(assess(["src/api/orders.ts"])).toMatchObject({
      tier: "amber",
      rules: [{ id: "api", description: "Business logic", reasons: ["path src/api/**: src/api/orders.ts"] }],
    });
    expect(assess(["main.tf"]).rules.map((r) => r.id)).toEqual(["infra"]);
    expect(assess(["README.md"], ["hotfix"]).tier).toBe("red");
    expect(assess(["a.md", "b.md", "c.md"]).rules.map((r) => r.id)).toEqual(["wide"]);
    expect(parsed.settings.reviewers.red).toEqual([
      { anyOf: [{ kind: "human" }, { kind: "agent", agent: "lead-reviewer" }], differentModel: false },
    ]);
  });

  it("explains a bad rule", () => {
    const parsed = parseReviewConfig(
      {
        enabled: true,
        tiers: { rules: [{ id: "x", tier: "red" }, { id: "y", tier: "amber", kinds: ["nope"] }] },
        merge: { gate: { source: "checks", required: ["ci"] } },
      },
      { github: "example-org/demo" },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      "review.tiers.rules.x: needs paths, kinds, labels, min_lines or min_files",
      expect.stringContaining("review.tiers.rules.y: unknown file kind nope"),
    ]);
  });
});
