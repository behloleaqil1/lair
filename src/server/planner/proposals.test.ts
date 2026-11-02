/**
 * The proposal checks (checkProposals, the production code the planner runs
 * on every proposal file) for the rules about blocked tasks and active runs.
 */
import { describe, expect, it } from "vitest";
import type { BlockedClass } from "../../shared/planner-types.js";
import { checkProposals, type CheckContext } from "./proposals.js";
import { applyEdit, findTask, parseTasksDoc } from "./tasks-file.js";

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

describe("unassigned lines (an empty agent field): open lines the planner sees, never dropped", () => {
  const text = ["worker-a|Alice|feat-cart|Cart", "|Pool|free-1|Anyone can take this", "||free-2|", ""].join("\n");
  const doc = parseTasksDoc(text, "#done ");
  const withDoc = (c: CheckContext): CheckContext => ({ ...c, doc });

  it("are parsed as open lines with no agent, so an id is never reused and they count toward fill's cap", () => {
    expect(doc.tasks.map((t) => [t.line, t.agent, t.task])).toEqual([
      [1, "worker-a", "feat-cart"],
      [2, null, "free-1"],
      [3, null, "free-2"],
    ]);
    expect(doc.malformed).toEqual([]);
    expect(refusalOf({ op: "add", task: "free-1", agent: "worker-b", text: "Again", reason: "x" }, withDoc(ctx({})))).toBe(
      "task free-1 is already in the tasks file (line 2)",
    );
    expect(applyEdit(doc, { op: "add", agent: "worker-b", name: "Bob", task: "free-2", description: "Again" }, "#done ")).toEqual({
      ok: false,
      reason: "task free-2 is already in the tasks file",
    });
    const full = parseTasksDoc([...Array.from({ length: 199 }, (_, i) => `worker-a|A|t-${i}|`), "|Pool|free-1|", ""].join("\n"), "#done ");
    expect(full.tasks).toHaveLength(200);
    expect(applyEdit(full, { op: "add", agent: "worker-b", name: "Bob", task: "one-more", description: "" }, "#done ")).toEqual({
      ok: false,
      reason: "the tasks file has 200 tasks, fill's limit",
    });
  });

  it("reassign gives one an agent; reword keeps it unassigned; finish and drop work as for any line", () => {
    const { checked } = checkProposals([{ op: "reassign", task: "free-1", agent: "worker-b", reason: "worker-b is idle" }], withDoc(ctx({})));
    expect(checked[0]).toMatchObject({ refusal: null, edit: { op: "reassign", task: "free-1", agent: "worker-b" } });
    const assigned = applyEdit(doc, { op: "reassign", task: "free-1", agent: "worker-b", name: "Bob" }, "#done ");
    expect(assigned).toMatchObject({ ok: true, before: "|Pool|free-1|Anyone can take this", after: "worker-b|Bob|free-1|Anyone can take this" });
    expect(assigned.ok && findTask(assigned.doc, "free-1")).toMatchObject({ agent: "worker-b", name: "Bob" });

    const reworded = applyEdit(doc, { op: "reword", task: "free-2", description: "Now with words" }, "#done ");
    expect(reworded).toMatchObject({ ok: true, after: "||free-2|Now with words" });
    expect(reworded.ok && findTask(reworded.doc, "free-2")).toMatchObject({ agent: null, description: "Now with words" });

    const finished = applyEdit(doc, { op: "mark_done", task: "free-1" }, "#done ");
    expect(finished.ok && [findTask(finished.doc, "free-1"), finished.doc.done.get("free-1")]).toEqual([null, 2]);
    const dropped = applyEdit(doc, { op: "drop", task: "free-2" }, "#done ");
    expect(dropped.ok && dropped.doc.tasks.map((t) => t.task)).toEqual(["feat-cart", "free-1"]);
  });
});
