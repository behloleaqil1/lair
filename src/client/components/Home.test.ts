/**
 * Home's "Needs you" card, rendered to markup with the real components: the
 * rows and their inline answers (buttons, the confirmation step, the link
 * for a credentials decision, disabled while signed out), the collapsed FYI
 * list, and the empty state.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Decision } from "../../shared/decision-types";
import { inlineAnswer, needsYou, type NeedsInput } from "../home-view";
import { NeedAnswerView, NeedsYouCard, type NeedAnswerViewProps } from "./Home";

const noop = () => undefined;

const decision = (over: Partial<Decision> = {}): Decision =>
  ({
    id: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
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

const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({
  project: "demo",
  decisions: [],
  failures: [],
  prs: [],
  configProblems: [],
  work: [],
  signedIn: true,
  ...over,
});

function card(over: Partial<NeedsInput> = {}): string {
  const { items, fyi } = needsYou(input(over));
  return renderToStaticMarkup(createElement(NeedsYouCard, { items, fyi, onAnswered: noop }));
}

function answerView(over: Partial<NeedAnswerViewProps> = {}): string {
  const d = over.decision ?? decision();
  return renderToStaticMarkup(
    createElement(NeedAnswerView, {
      decision: d,
      answer: inlineAnswer(d, true),
      pending: null,
      submitting: false,
      error: null,
      onChoose: noop,
      onConfirm: noop,
      onCancel: noop,
      ...over,
    }),
  );
}

describe("Home: Needs you", () => {
  it("says 'Nothing needs you.' when nothing does, and has no FYI list then", () => {
    const html = card();
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain('data-empty="needs-you"');
    expect(html).not.toContain("<details");
  });

  it("shows each item's sentence, its answer buttons inline and the link to its full context", () => {
    const html = card({ decisions: [decision()] });
    expect(html).not.toContain('data-empty="needs-you"');
    expect(html).toContain("kiro-A is paused: its last run failed while Lair was restarting");
    expect(html).toContain(">Start it again</button>");
    expect(html).toContain(">Keep it paused (recommended)</button>");
    expect(html).toContain('href="#/decisions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b"');
    expect(html).not.toContain('disabled=""');
  });

  it("signed out: the buttons are disabled and say how to sign in", () => {
    const html = card({ decisions: [decision()], signedIn: false });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Sign in as the owner from Decisions to answer here");
    expect(html).toContain('href="#/decisions">Sign in</a>');
  });

  it("puts notices in a collapsed FYI list, without answer buttons", () => {
    const html = card({
      decisions: [decision({ id: "n1", attention: "notice", title: "No merge for 4.2 h", options: [{ id: "stand_down", label: "Leave it to me", consequences: "x" }] })],
    });
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain('<details class="needs-fyi" data-card="fyi">');
    expect(html).not.toContain("<details open");
    expect(html).toContain("FYI (1)");
    expect(html).toContain("No merge for 4.2 h");
    expect(html).not.toContain("Leave it to me</button>");
  });

  it("a spend answer goes through the confirmation step; a credentials decision is answered in Decisions", () => {
    const spend = decision({
      kind: "spend",
      options: [
        { id: "allow", label: "Allow runs past the limit", consequences: "Runs start until the period ends." },
        { id: "wait", label: "Wait", consequences: "Runs wait." },
      ],
      recommended: { optionId: "wait", reasoning: "" },
    });
    const confirming = answerView({ decision: spend, answer: inlineAnswer(spend, true), pending: spend.options[0] });
    expect(confirming).toContain('role="alertdialog"');
    expect(confirming).toContain("Confirm: Allow runs past the limit");
    expect(confirming).toContain("Runs start until the period ends.");
    expect(confirming).not.toContain("(recommended)");

    const credentials = decision({ kind: "credentials" });
    const link = answerView({ decision: credentials, answer: inlineAnswer(credentials, true) });
    expect(link).toContain('data-answer="link"');
    expect(link).toContain(">Answer in Decisions</a>");
    expect(link).not.toContain("<button");
  });

  it("shows a failed answer's error beside the buttons", () => {
    expect(answerView({ error: "Decision is answered, not open" })).toContain("Decision is answered, not open");
  });
});
