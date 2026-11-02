/**
 * Tests for PR ownership checks (issue #290): when a finish proposal names a
 * PR, verify it belongs to the task.
 */
import { describe, expect, it } from "vitest";
import {
  branchContainsTask,
  branchMatchesAgent,
  checkPrOwnership,
  extractPrNumbers,
  titleBodyNamesTask,
  type PrMetadata,
} from "./pr-ownership.js";
import type { AuthorMapping } from "../review/authors.js";
import { compileBranchGlob, type BranchGlob } from "../review/authors.js";

describe("extractPrNumbers", () => {
  it("extracts PR from 'merged as #N'", () => {
    expect(extractPrNumbers("merged as #123")).toEqual([{ number: 123, context: "merged as #123" }]);
    expect(extractPrNumbers("merged as PR #456")).toEqual([{ number: 456, context: "merged as PR #456" }]);
  });

  it("extracts PR from '#N merged'", () => {
    expect(extractPrNumbers("#789 merged")).toEqual([{ number: 789, context: "#789 merged" }]);
    expect(extractPrNumbers("PR #42 is merged")).toEqual([{ number: 42, context: "PR #42 is merged" }]);
  });

  it("extracts PR from 'merged in #N'", () => {
    expect(extractPrNumbers("merged in #100")).toEqual([{ number: 100, context: "merged in #100" }]);
  });

  it("extracts PR from 'merged (PR #N)'", () => {
    expect(extractPrNumbers("merged (PR #200)")).toEqual([{ number: 200, context: "merged (PR #200)" }]);
    expect(extractPrNumbers("merged (#300)")).toEqual([{ number: 300, context: "merged (#300)" }]);
  });

  it("extracts PR from '(merged as #N)'", () => {
    expect(extractPrNumbers("(merged as #400)")).toEqual([{ number: 400, context: "(merged as #400)" }]);
  });

  it("extracts bare #N when reason contains merge keyword", () => {
    expect(extractPrNumbers("completed, merge PR #500")).toEqual([{ number: 500, context: "#500" }]);
    expect(extractPrNumbers("PR #600 was merged today")).toEqual([{ number: 600, context: "#600 was merged" }]);
  });

  it("does not extract bare #N without merge keyword", () => {
    expect(extractPrNumbers("see issue #123")).toEqual([]);
    expect(extractPrNumbers("task done #456")).toEqual([]);
  });

  it("extracts multiple PRs without duplicates", () => {
    const result = extractPrNumbers("merged as #10, also #20 merged");
    const numbers = result.map((r) => r.number);
    expect(numbers).toContain(10);
    expect(numbers).toContain(20);
    expect(numbers.length).toBe(2);
  });

  it("returns empty for no PR references", () => {
    expect(extractPrNumbers("task is done")).toEqual([]);
    expect(extractPrNumbers("")).toEqual([]);
  });
});

describe("branchContainsTask", () => {
  it("matches task id as path segment", () => {
    expect(branchContainsTask("kiro/kiro-A/feat-login", "feat-login")).toBe(true);
    expect(branchContainsTask("feature/feat-login", "feat-login")).toBe(true);
    expect(branchContainsTask("feat-login", "feat-login")).toBe(true);
  });

  it("matches with separator normalization", () => {
    expect(branchContainsTask("kiro/kiro-A/feat_login", "feat-login")).toBe(true);
    expect(branchContainsTask("kiro/kiro-A/feat-login", "feat_login")).toBe(true);
  });

  it("matches task id as suffix", () => {
    expect(branchContainsTask("topic/feat-login", "feat-login")).toBe(true);
  });

  it("does not match partial task id", () => {
    expect(branchContainsTask("kiro/feat-login-fix", "feat-login")).toBe(false);
    expect(branchContainsTask("kiro/prefeat-login", "feat-login")).toBe(false);
  });

  it("case insensitive matching", () => {
    expect(branchContainsTask("kiro/FEAT-LOGIN", "feat-login")).toBe(true);
    expect(branchContainsTask("kiro/feat-login", "FEAT-LOGIN")).toBe(true);
  });

  it("handles multi-part task ids", () => {
    expect(branchContainsTask("kiro/kiro-A/api/users", "api/users")).toBe(true);
    expect(branchContainsTask("kiro/kiro-A/api-users", "api-users")).toBe(true);
  });
});

describe("branchMatchesAgent", () => {
  const makeMapping = (branchPattern: RegExp | null, branches: BranchGlob[]): AuthorMapping => ({
    branchPattern,
    branches,
    fromTasksFile: false,
  });

  it("matches via branch_pattern", () => {
    const mapping = makeMapping(/^kiro\/(?<agent>[^/]+)\//, []);
    expect(branchMatchesAgent("kiro/kiro-A/feat-login", "kiro-A", mapping)).toBe(true);
    expect(branchMatchesAgent("kiro/kiro-B/feat-login", "kiro-A", mapping)).toBe(false);
  });

  it("matches via branches glob", () => {
    const glob = compileBranchGlob("team/kiro-A/**", "kiro-A") as BranchGlob;
    const mapping = makeMapping(null, [glob]);
    expect(branchMatchesAgent("team/kiro-A/feat-login", "kiro-A", mapping)).toBe(true);
    expect(branchMatchesAgent("team/kiro-B/feat-login", "kiro-A", mapping)).toBe(false);
  });

  it("returns false when no mapping", () => {
    expect(branchMatchesAgent("kiro/kiro-A/feat", "kiro-A", null)).toBe(false);
  });

  it("returns false when no expected agent", () => {
    const mapping = makeMapping(/^kiro\/(?<agent>[^/]+)\//, []);
    expect(branchMatchesAgent("kiro/kiro-A/feat", null, mapping)).toBe(false);
  });
});

describe("titleBodyNamesTask", () => {
  const pr = (title: string, body: string | null): PrMetadata => ({
    number: 1,
    headBranch: "main",
    title,
    body,
    state: "merged",
  });

  it("matches task id in title", () => {
    expect(titleBodyNamesTask(pr("feat-login: add auth", null), "feat-login")).toBe(true);
    expect(titleBodyNamesTask(pr("[feat-login] add auth", null), "feat-login")).toBe(true);
  });

  it("matches task id in body", () => {
    expect(titleBodyNamesTask(pr("Add auth", "Closes feat-login"), "feat-login")).toBe(true);
    expect(titleBodyNamesTask(pr("Add auth", "Task: feat-login done"), "feat-login")).toBe(true);
  });

  it("matches with separator variations", () => {
    expect(titleBodyNamesTask(pr("feat_login: add auth", null), "feat-login")).toBe(true);
  });

  it("case insensitive", () => {
    expect(titleBodyNamesTask(pr("FEAT-LOGIN: add auth", null), "feat-login")).toBe(true);
  });

  it("does not match partial task id", () => {
    expect(titleBodyNamesTask(pr("feat-login-fix: add auth", null), "feat-login")).toBe(false);
  });

  it("handles null body", () => {
    expect(titleBodyNamesTask(pr("feat-login: add auth", null), "feat-login")).toBe(true);
    expect(titleBodyNamesTask(pr("other", null), "feat-login")).toBe(false);
  });
});

describe("checkPrOwnership", () => {
  const pr = (branch: string, title: string, body: string | null): PrMetadata => ({
    number: 1,
    headBranch: branch,
    title,
    body,
    state: "merged",
  });

  const mapping = (pattern: RegExp | null): AuthorMapping => ({
    branchPattern: pattern,
    branches: [],
    fromTasksFile: false,
  });

  it("owns when branch contains task", () => {
    const result = checkPrOwnership(pr("kiro/kiro-A/feat-login", "other", null), "feat-login", "kiro-A", null);
    expect(result.owns).toBe(true);
    expect(result.method).toBe("branch_contains_task");
  });

  it("owns when branch matches agent", () => {
    const result = checkPrOwnership(
      pr("kiro/kiro-A/other", "other", null),
      "feat-login",
      "kiro-A",
      mapping(/^kiro\/(?<agent>[^/]+)\//),
    );
    expect(result.owns).toBe(true);
    expect(result.method).toBe("branch_agent_match");
  });

  it("owns when title names task", () => {
    const result = checkPrOwnership(pr("main", "feat-login: add auth", null), "feat-login", null, null);
    expect(result.owns).toBe(true);
    expect(result.method).toBe("title_body_match");
  });

  it("does not own when nothing matches", () => {
    const result = checkPrOwnership(pr("main", "other", null), "feat-login", "kiro-A", null);
    expect(result.owns).toBe(false);
    expect(result.method).toBe("none");
    expect(result.reason).toContain("branch 'main' does not contain task id 'feat-login'");
    expect(result.reason).toContain("title/body does not name task 'feat-login'");
  });

  it("prefers branch_contains_task over other methods", () => {
    // All three would match, but branch_contains_task is checked first
    const result = checkPrOwnership(
      pr("kiro/kiro-A/feat-login", "feat-login: done", null),
      "feat-login",
      "kiro-A",
      mapping(/^kiro\/(?<agent>[^/]+)\//),
    );
    expect(result.owns).toBe(true);
    expect(result.method).toBe("branch_contains_task");
  });
});


describe("verifierSection PR ownership instructions", () => {
  // Import verifierSection to test the instructions are included
  // This ensures the verifier gets guidance about PR ownership checks
  it("includes PR ownership instructions for finish proposals", async () => {
    const { verifierSection } = await import("./verifier.js");
    const section = verifierSection({
      runId: "run-123",
      verdictsFile: "/tmp/verdicts.json",
      proposals: [{ index: 0, op: "finish", task: "feat-login", agent: null, text: null, reason: "merged as #230" }],
      context: { json: "{}" },
    });

    // Should include PR ownership guidance
    expect(section).toContain("PR ownership for finish proposals");
    expect(section).toContain("branch contains the task id");
    expect(section).toContain("title or body names the task id");
    expect(section).toContain("gh pr view");
    expect(section).toContain("unsure");
  });

  it("includes the proposals in the data section", async () => {
    const { verifierSection } = await import("./verifier.js");
    const section = verifierSection({
      runId: "run-456",
      verdictsFile: "/tmp/verdicts.json",
      proposals: [
        { index: 0, op: "finish", task: "feat-search", agent: "worker-a", text: null, reason: "PR #123 merged" },
        { index: 1, op: "add", task: "feat-cart", agent: "worker-b", text: "Cart page", reason: "ready" },
      ],
      context: { json: '{"note": "test context"}' },
    });

    // Should include proposals in the JSON data block
    expect(section).toContain('"op": "finish"');
    expect(section).toContain('"task": "feat-search"');
    expect(section).toContain('"reason": "PR #123 merged"');
    expect(section).toContain('"op": "add"');
    expect(section).toContain('"task": "feat-cart"');
  });
});
