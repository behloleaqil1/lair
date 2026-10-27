/**
 * Home's "Needs you" and FYI lists (home-view.ts): the open action items,
 * newest first, each a plain sentence with its answer inline and a link to
 * its full context; the notices and the rest apart, for information.
 */
import { describe, expect, it } from "vitest";
import type { Decision } from "../shared/decision-types";
import type { ProviderUnreachableView } from "../shared/agents-types";
import { NOTHING_NEEDS_YOU, SIGN_IN_TO_ANSWER, inlineAnswer, needsYou, type NeedsInput } from "./home-view";
import type { WorkRow } from "./work-view";
import type { PrRow } from "./pr-view";

const decision = (over: Partial<Decision>): Decision =>
  ({
    id: "d1",
    project: "demo",
    kind: "escalation",
    attention: "action",
    title: "kiro-A is paused: its last run failed while Lair was restarting",
    context: "",
    options: [
      { id: "start_again", label: "Start it again", consequences: "Fill starts it on its next check." },
      { id: "keep_held", label: "Keep it paused", consequences: "Fill leaves it until you release it." },
    ],
    recommended: { optionId: "keep_held", reasoning: "" },
    source: { module: "agents", ref: "fill:feat-x" },
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
  failures: [],
  prs: [],
  configProblems: [],
  work: [],
  signedIn: true,
};

describe("needs you", () => {
  it("is empty when nothing waits on the owner, and says so in those words", () => {
    expect(needsYou(empty)).toEqual({ items: [], fyi: [] });
    expect(NOTHING_NEEDS_YOU).toBe("Nothing needs you.");
  });

  it("lists this project's open action items newest first, each its sentence, answer and link; notices go to FYI", () => {
    const { items, fyi } = needsYou({
      ...empty,
      decisions: [
        decision({ id: "old", createdAt: "2026-10-27T08:00:00Z", title: "Merge of #3 is held: freeze" }),
        decision({ id: "new", createdAt: "2026-10-27T11:00:00Z" }),
        decision({ id: "overdue", createdAt: "2026-10-27T09:00:00Z", overdue: true, title: "Approve the plan" }),
        decision({ id: "closed", status: "answered" }),
        decision({ id: "fyi", attention: "notice", title: "No merge for 4.2 h", createdAt: "2026-10-27T11:30:00Z" }),
        decision({ id: "other-fyi", attention: "notice", project: "other" }),
      ],
    });
    expect(items.map((i) => [i.kind, i.title, i.href])).toEqual([
      ["decision", "kiro-A is paused: its last run failed while Lair was restarting", "#/decisions/new"],
      ["decision", "Approve the plan", "#/decisions/overdue"],
      ["decision", "Merge of #3 is held: freeze", "#/decisions/old"],
    ]);
    expect(items[0]).toMatchObject({ tone: "warning", linkLabel: "Details", detail: "from agents" });
    expect(items[1]).toMatchObject({ tone: "error", detail: "Overdue · from agents" });
    expect(items[0].answer).toMatchObject({ mode: "buttons", disabledReason: null });
    // A notice asks nothing: it is listed for information only, with no answer buttons
    expect(fyi.map((i) => [i.kind, i.title, i.href])).toEqual([["notice", "No merge for 4.2 h", "#/decisions/fyi"]]);
    expect(fyi[0].answer).toBeUndefined();
  });

  it("other projects' action items are one row, last; their notices are not counted", () => {
    const { items } = needsYou({
      ...empty,
      decisions: [
        decision({ id: "a", project: "other" }),
        decision({ id: "b", project: "shop" }),
        decision({ id: "c", project: "shop", attention: "notice" }),
        decision({ id: "mine" }),
      ],
    });
    expect(items.map((i) => [i.kind, i.title, i.href])).toEqual([
      ["decision", "kiro-A is paused: its last run failed while Lair was restarting", "#/decisions/mine"],
      ["elsewhere", "2 things need you in other projects", "#/decisions"],
    ]);
    expect(needsYou({ ...empty, decisions: [decision({ project: "other" })] }).items[0].title).toBe(
      "1 thing needs you in other projects",
    );
  });

  it("keeps the project's config errors in the list, newest first among the decisions, linking to Settings", () => {
    const { items } = needsYou({
      ...empty,
      decisions: [decision({ id: "d", createdAt: "2026-10-27T10:00:00Z" })],
      configProblems: [
        { project: "demo", file: "projects/demo.yaml", error: "bad key", previousRunning: true, at: "2026-10-27T11:00:00Z" },
        { project: "other", file: "projects/other.yaml", error: "bad", previousRunning: false, at: "2026-10-27T11:00:00Z" },
      ],
    });
    expect(items.map((i) => [i.kind, i.href])).toEqual([
      ["config", "#/settings"],
      ["decision", "#/decisions/d"],
    ]);
    expect(items[0]).toMatchObject({
      title: "projects/demo.yaml has an error: Lair can't use it until you fix it",
      detail: "The previous config is still running: bad key",
      linkLabel: "Open Settings",
      tone: "error",
    });
    expect(items[0].answer).toBeUndefined();
  });

  it("lists holds only through their decisions, and puts agents in trouble, failed gates and ready PRs under FYI", () => {
    const { items, fyi } = needsYou({
      ...empty,
      failures: [{ id: "g1", track: "api", finishedAt: "2026-10-27T11:00:00Z", failedSteps: ["test"] }],
      prs: [
        { number: 7, title: "Add login", updatedAt: "2026-10-27T10:30:00Z", readiness: { group: "ready", label: "Merge ready", tier: "green", checkedAt: null } } as PrRow,
        { number: 8, title: "WIP", readiness: { group: "waiting", label: "Waiting: x", tier: null, checkedAt: null } } as PrRow,
      ],
      work: [
        { id: "kiro-A", state: "hung", detail: "no output", attention: true } as WorkRow,
        { id: "kiro-B", state: "working", detail: null, attention: false } as WorkRow,
      ],
    });
    expect(items).toEqual([]);
    expect(fyi.map((i) => [i.kind, i.title, i.href])).toEqual([
      ["gate", "Gate failed: api", "#/gates/g1?tab=results"],
      ["pr", "#7 is ready to merge", "#/prs/7"],
      ["agent", "kiro-A is hung", "#/work/kiro-A"],
    ]);
  });

  it("counts a decision from a server without attention as an action item", () => {
    const { items } = needsYou({ ...empty, decisions: [decision({ attention: undefined })] });
    expect(items.map((i) => i.kind)).toEqual(["decision"]);
  });
});

describe("answering from Home: the Decisions view's rules", () => {
  it("offers every option inline, the recommended one marked", () => {
    const answer = inlineAnswer(decision({}), true);
    expect(answer).toEqual({
      mode: "buttons",
      disabledReason: null,
      options: [
        { option: expect.objectContaining({ id: "start_again", label: "Start it again" }), recommended: false, confirm: false },
        { option: expect.objectContaining({ id: "keep_held", label: "Keep it paused" }), recommended: true, confirm: false },
      ],
    });
  });

  it("asks for a confirmation first on spend and go/no-go answers", () => {
    for (const kind of ["spend", "go_no_go"] as const) {
      const answer = inlineAnswer(decision({ kind }), true);
      expect(answer.mode === "buttons" && answer.options.every((o) => o.confirm)).toBe(true);
    }
    const escalation = inlineAnswer(decision({ kind: "escalation" }), true);
    expect(escalation.mode === "buttons" && escalation.options.some((o) => o.confirm)).toBe(false);
  });

  it("answers a credentials decision only in the Decisions view (its secret is typed there)", () => {
    expect(inlineAnswer(decision({ kind: "credentials" }), true)).toMatchObject({ mode: "link", label: "Answer in Decisions" });
    const { items } = needsYou({ ...empty, decisions: [decision({ kind: "credentials", id: "cred" })] });
    expect(items[0]).toMatchObject({ href: "#/decisions/cred", answer: { mode: "link" } });
  });

  it("keeps the buttons disabled, with the way to sign in, until this browser is the owner's", () => {
    expect(inlineAnswer(decision({}), false)).toMatchObject({ mode: "buttons", disabledReason: SIGN_IN_TO_ANSWER });
    expect(inlineAnswer(decision({}), null)).toMatchObject({ mode: "buttons", disabledReason: SIGN_IN_TO_ANSWER });
    const { items } = needsYou({ ...empty, signedIn: false, decisions: [decision({})] });
    expect(items[0].answer).toMatchObject({ disabledReason: SIGN_IN_TO_ANSWER });
  });

  it("tells about a provider Lair waits out after transient errors in FYI, never as something that needs the owner", () => {
    const outage = (provider: string, over: Partial<ProviderUnreachableView> = {}): ProviderUnreachableView => ({
      provider,
      since: "2026-10-27T11:30:00.000Z",
      failures: 6,
      nextTryAt: "2026-10-27T12:15:00.000Z",
      line: "Error: A network error occurred.",
      fleet: true,
      agents: ["kiro-A", "kiro-B"],
      waiting: 4,
      ...over,
    });
    const { items, fyi } = needsYou({
      ...empty,
      decisions: [decision({ id: "d-open" })],
      unreachable: [
        outage("provider-a"),
        outage("provider-b", { since: "2026-10-27T11:58:00.000Z", failures: 1, fleet: false, agents: ["kiro-C"], waiting: 1 }),
      ],
    });
    expect(items.map((i) => i.key)).toEqual(["decision:d-open"]);
    expect(fyi.map((i) => [i.kind, i.tone, i.title, i.detail, i.href, i.at])).toEqual([
      [
        "agent",
        "neutral",
        "Provider provider-b is unreachable",
        "kiro-C waits: 1 run(s), 1 transient failure(s); Lair tries one start at a time",
        "#/work",
        "2026-10-27T11:58:00.000Z",
      ],
      [
        "agent",
        "neutral",
        "Provider provider-a is unreachable",
        "Every agent waits: 4 run(s), 6 transient failure(s); Lair tries one start at a time",
        "#/work",
        "2026-10-27T11:30:00.000Z",
      ],
    ]);
  });
});
