import { describe, expect, it } from "vitest";
import { evaluateReady, parseReadyReport, unmappedFindings, type ReadyFacts, type ReadyVerdict } from "./guard.js";

const HEAD = "abc1234def56789012345678901234567890abcd";

const ready: ReadyFacts = {
  state: "open",
  headSha: HEAD,
  baseRef: "main",
  mergeable: true,
  behindBy: 0,
  body: "Closes #1",
  checks: [{ name: "build", state: "success" }],
  commitShas: [HEAD],
  gate: null,
  findingIds: [],
};

const judge = (facts: Partial<ReadyFacts>, sha: string | null = "abc1234"): Promise<ReadyVerdict> =>
  evaluateReady({ pr: 7, sha }, { facts: async () => ({ ...ready, ...facts }) });

function refused(v: ReadyVerdict) {
  if (v.ok) throw new Error("expected a refusal");
  return v;
}

describe("parseReadyReport", () => {
  it("reads the PR and the head from a DONE line", () => {
    expect(parseReadyReport("- DONE task-a by worker-a 10:00Z: PR #12 at ABC1234, CI green")).toEqual({ pr: 12, sha: "abc1234" });
    expect(parseReadyReport("- DONE task-a by worker-a: pull request #5")).toEqual({ pr: 5, sha: null });
  });
  it("is null for a line that names no PR", () => {
    expect(parseReadyReport("- DONE task-a by worker-a 10:00Z: merged by hand")).toBeNull();
  });
});

describe("evaluateReady", () => {
  it("accepts a PR that is up to date, green, and has nothing to map", async () => {
    expect(await judge({})).toEqual({ ok: true });
  });

  it("refuses failing CI by check name, and says what to do", async () => {
    const v = refused(await judge({ checks: [{ name: "build", state: "success" }, { name: "unit", state: "failure" }] }));
    expect(v).toMatchObject({ reason: "ci_failed", retry: false });
    expect(v.instruction).toContain("CI is not green at the head: unit");
    expect(v.instruction).toContain("Nothing was sent to review and the task stays open");
  });

  it("refuses pending CI as a retry, and a PR with no checks yet the same way", async () => {
    expect(refused(await judge({ checks: [{ name: "build", state: "pending" }] }))).toMatchObject({ reason: "ci_pending", retry: true });
    expect(refused(await judge({ checks: [] }))).toMatchObject({ reason: "ci_pending", retry: true });
  });

  it("a skipped check is not a failure", async () => {
    expect(await judge({ checks: [{ name: "build", state: "success" }, { name: "deploy", state: "skipped" }] })).toEqual({ ok: true });
  });

  it("refuses a branch behind its base", async () => {
    const v = refused(await judge({ behindBy: 2 }));
    expect(v).toMatchObject({ reason: "behind_base", retry: false });
    expect(v.instruction).toContain("2 commit(s) behind main");
  });

  it("refuses a conflicting branch", async () => {
    expect(refused(await judge({ mergeable: false }))).toMatchObject({ reason: "conflicting", retry: false });
  });

  it("refuses when the host has not said whether the branch is behind or conflicting (fail closed, retry)", async () => {
    expect(refused(await judge({ mergeable: null }))).toMatchObject({ reason: "unverifiable", retry: true });
    expect(refused(await judge({ behindBy: null }))).toMatchObject({ reason: "unverifiable", retry: true });
  });

  it("refuses when the project's gate did not pass at the head, and waits while it runs", async () => {
    const v = refused(await judge({ gate: [{ name: "backend", status: "failed" }] }));
    expect(v).toMatchObject({ reason: "gate_unverified", retry: false });
    expect(v.instruction).toContain("backend (failed)");
    expect(refused(await judge({ gate: [{ name: "backend", status: "missing" }] }))).toMatchObject({ reason: "gate_unverified", retry: false });
    expect(refused(await judge({ gate: [{ name: "backend", status: "pending" }] }))).toMatchObject({ reason: "gate_unverified", retry: true });
    expect(await judge({ gate: [{ name: "backend", status: "passed" }] })).toEqual({ ok: true });
  });

  it("refuses a PR whose body does not map each finding to one of its commits", async () => {
    const facts = { findingIds: ["f-1", "f-2"], body: "f-1 fixed in abc1234\nf-2 fixed in 9999999" };
    const v = refused(await judge(facts));
    expect(v).toMatchObject({ reason: "findings_unmapped", retry: false });
    expect(v.instruction).toContain("f-2");
    expect(v.instruction).not.toContain("f-1,");
    expect(await judge({ findingIds: ["f-1", "f-2"], body: "f-1 -> abc1234\nf-2 -> abc1234def5" })).toEqual({ ok: true });
  });

  it("refuses a report about a head that is no longer the PR's head, and a PR that is not open", async () => {
    expect(refused(await judge({}, "0000000"))).toMatchObject({ reason: "head_moved", retry: false });
    expect(refused(await judge({ state: "closed" }))).toMatchObject({ reason: "not_open", retry: false });
  });

  it("names every failing item, the first one that needs a change leading", async () => {
    const v = refused(await judge({ checks: [{ name: "build", state: "pending" }], behindBy: 1 }));
    expect(v.reason).toBe("behind_base");
    expect(v.retry).toBe(false);
    expect(v.problems).toHaveLength(2);
  });

  it("a host that fails is a retry, never an acceptance", async () => {
    const v = await evaluateReady({ pr: 7, sha: null }, { facts: async () => { throw new Error("401 token abc"); } });
    expect(refused(v)).toMatchObject({ reason: "unverifiable", retry: true });
    expect(JSON.stringify(v)).not.toContain("token");
  });
});

describe("unmappedFindings", () => {
  it("needs the id and a sha prefix of a PR commit on the same line", () => {
    expect(unmappedFindings("f-1\nabc1234", ["f-1"], [HEAD])).toEqual(["f-1"]);
    expect(unmappedFindings("f-1: abc1234", ["f-1"], [HEAD])).toEqual([]);
    expect(unmappedFindings("f-1: abc1234", ["f-1"], ["fffffff0000"])).toEqual(["f-1"]);
  });
});
