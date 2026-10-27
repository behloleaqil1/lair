/**
 * The proposal checks (checkProposals, the production code the planner runs
 * on every proposal file) for the rules about blocked tasks and active runs.
 */
import { describe, expect, it } from "vitest";
import type { BlockedClass } from "../../shared/planner-types.js";
import { checkProposals, type CheckContext } from "./proposals.js";
import { parseTasksDoc } from "./tasks-file.js";

const DOC = parseTasksDoc(
  ["# agent|name|task|description", "worker-a|Alice|feat-cart|Cart", "worker-b|Bob|feat-search|Search page", ""].join("\n"),
  "#done ",
);

function ctx(over: {
  blocked?: Record<string, { class: BlockedClass; kept: boolean; attempts: number }>;
  active?: Record<string, { id: string; agent: string }>;
}): CheckContext {
  return {
    maxProposals: 10,
    allowlist: ["worker-a", "worker-b"],
    plannerAgent: "planner",
    taskIdPattern: null,
    doneMarker: "#done ",
    doc: DOC,
    nameOf: (agent) => agent,
    activeRun: (task) => over.active?.[task] ?? null,
    blocked: (task) => over.blocked?.[task] ?? null,
    attemptsPerTask: 2,
  };
}

const refusalOf = (item: Record<string, unknown>, c: CheckContext) => checkProposals([item], c).checked[0].refusal;

describe("unblock and reword of blocked tasks", () => {
  const unblock = { op: "unblock", task: "feat-cart", reason: "the scope is clear now" };

  it("an unblock needs a task problem the planner may still work on", () => {
    expect(refusalOf(unblock, ctx({}))).toBe("task feat-cart is not blocked: no BLOCKED line for it since it was last unblocked");
    expect(refusalOf(unblock, ctx({ blocked: { "feat-cart": { class: "environment", kept: false, attempts: 0 } } }))).toBe(
      "task feat-cart is blocked by its environment: the owner unblocks it",
    );
    expect(refusalOf(unblock, ctx({ blocked: { "feat-cart": { class: "owner", kept: false, attempts: 0 } } }))).toBe(
      "task feat-cart is blocked by something only the owner decides: the owner unblocks it",
    );
    expect(refusalOf(unblock, ctx({ blocked: { "feat-cart": { class: "task", kept: false, attempts: 2 } } }))).toBe(
      "the planner's attempts on task feat-cart are spent (2 of 2): the owner decides",
    );
    // A task problem with an attempt left: accepted (it changes no line, so it has no edit)
    const ok = checkProposals([unblock], ctx({ blocked: { "feat-cart": { class: "task", kept: false, attempts: 1 } } })).checked[0];
    expect(ok).toMatchObject({ refusal: null, edit: null, op: "unblock" });
  });

  it("neither an unblock nor a reword touches a task the owner keeps blocked", () => {
    const kept = ctx({ blocked: { "feat-cart": { class: "task", kept: true, attempts: 0 } } });
    const message = "the owner keeps task feat-cart blocked: the planner leaves it alone until its line changes";
    expect(refusalOf(unblock, kept)).toBe(message);
    expect(refusalOf({ op: "reword", task: "feat-cart", text: "Checkout", reason: "clearer" }, kept)).toBe(message);
    // Other tasks are not affected
    expect(refusalOf({ op: "reword", task: "feat-search", text: "Search page v2", reason: "clearer" }, kept)).toBeNull();
  });

  it("reassign and drop wait while the task has an active run; finish and reword don't", () => {
    const busy = ctx({ active: { "feat-search": { id: "0123456789abcdef", agent: "worker-b" } } });
    expect(refusalOf({ op: "reassign", task: "feat-search", agent: "worker-a", reason: "b is slow" }, busy)).toBe(
      "task feat-search has an active run (01234567 of worker-b): reassign it once that run ends",
    );
    expect(refusalOf({ op: "drop", task: "feat-search", reason: "superseded" }, busy)).toContain("drop it once that run ends");
    expect(refusalOf({ op: "finish", task: "feat-search", reason: "merged" }, busy)).toBeNull();
    expect(refusalOf({ op: "reassign", task: "feat-cart", agent: "worker-a", reason: "x" }, busy)).toBe("task feat-cart is already worker-a's");
  });
});
