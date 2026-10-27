/**
 * Home's "Needs you" list (home-view.ts): everything that waits on the
 * owner, each with a link to the row that explains it.
 */
import { describe, expect, it } from "vitest";
import type { Decision } from "../shared/decision-types";
import type { DeliveryProjectStatus } from "../shared/delivery-types";
import { needsYou, type NeedsInput } from "./home-view";
import type { WorkRow } from "./work-view";
import type { PrRow } from "./pr-view";

const decision = (over: Partial<Decision>): Decision =>
  ({
    id: "d1",
    project: "demo",
    kind: "spend",
    title: "Raise the budget",
    context: "",
    options: [],
    recommended: { optionId: "x", reasoning: "" },
    source: { module: "agents", ref: "r" },
    key: "k",
    blocks: [],
    links: [],
    createdAt: "2026-10-27T10:00:00Z",
    overdue: false,
    status: "open",
    raisedVia: "server",
    ...over,
  }) as Decision;

const empty: NeedsInput = {
  project: "demo",
  decisions: [],
  reviewHolds: [],
  agents: null,
  delivery: null,
  failures: [],
  prs: [],
  configProblems: [],
  work: [],
};

describe("needs you", () => {
  it("is empty when nothing waits on the owner", () => {
    expect(needsYou(empty)).toEqual([]);
  });

  it("lists decisions, config problems, agents in trouble, holds, failed gates and ready PRs, worst first", () => {
    const delivery = {
      project: "demo",
      enabled: true,
      environments: [
        {
          environment: "staging",
          services: [{ name: "api", held: { reason: "stopped by the owner", heldAt: "2026-10-27T09:00:00Z" } }],
        },
      ],
    } as unknown as DeliveryProjectStatus;
    const items = needsYou({
      ...empty,
      decisions: [
        decision({ id: "d-overdue", overdue: true, title: "Approve the plan" }),
        decision({ id: "d-open" }),
        decision({ id: "d-closed", status: "answered" }),
        decision({ id: "d-other", project: "other" }),
      ],
      reviewHolds: [
        { id: "h1", project: "demo", pr: null, reason: "freeze", createdBy: "ops", createdAt: "x", releasedAt: null, releasedBy: null },
        { id: "h2", project: "demo", pr: 3, reason: "old", createdBy: "ops", createdAt: "x", releasedAt: "y", releasedBy: "owner" },
      ],
      delivery,
      failures: [{ id: "g1", track: "api", finishedAt: "2026-10-27T11:00:00Z", failedSteps: ["test"] }],
      prs: [
        { number: 7, title: "Add login", readiness: { group: "ready", label: "Merge ready", tier: "green", checkedAt: null } } as PrRow,
        { number: 8, title: "WIP", readiness: { group: "waiting", label: "Waiting: x", tier: null, checkedAt: null } } as PrRow,
      ],
      configProblems: [
        { project: "demo", file: "projects/demo.yaml", error: "bad key", previousRunning: true, at: "x" },
        { project: "other", file: "projects/other.yaml", error: "bad", previousRunning: false, at: "x" },
      ],
      work: [
        { id: "kiro-A", state: "hung", detail: "no output", attention: true } as WorkRow,
        { id: "kiro-B", state: "working", detail: null, attention: false } as WorkRow,
      ],
    });
    expect(items.map((i) => [i.kind, i.title, i.href])).toEqual([
      ["decision", "Approve the plan", "#/decisions/d-overdue"],
      ["config", "projects/demo.yaml has an error", "#/settings"],
      ["agent", "kiro-A is hung", "#/work/kiro-A"],
      ["gate", "Gate failed: api", "#/gates/g1?tab=results"],
      ["decision", "Raise the budget", "#/decisions/d-open"],
      ["hold", "Every merge is held", "#/prs"],
      ["decision", "1 open decision in other projects", "#/decisions"],
      ["hold", "staging/api is held", "#/delivery"],
      ["pr", "#7 is ready to merge", "#/prs/7"],
    ]);
  });

  it("lists the tasks fill holds for the owner, linking to the agent", () => {
    const items = needsYou({
      ...empty,
      agents: {
        fill: {
          enabled: true,
          lines: [
            { line: 4, agent: "kiro-A", task: "feat-x", releasable: true, detail: "its runs exited 0 without reporting it done" },
            { line: 5, agent: "kiro-A", task: "feat-y", releasable: false, detail: "backoff" },
          ],
        },
      } as unknown as NeedsInput["agents"],
    });
    expect(items).toEqual([
      expect.objectContaining({ kind: "hold", title: "feat-x is held for you", href: "#/work/kiro-A" }),
    ]);
  });
});
