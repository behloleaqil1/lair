/**
 * The Decision Inbox view, rendered to markup with the real components:
 * what an open decision shows, the confirmation step for spend, the secret
 * field of a credentials decision, and the nav badge.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Decision } from "../../shared/decision-types";
import { DecisionCardView, DecisionCountBadge, DecisionInboxView, type DecisionCardViewProps } from "./DecisionInbox";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const noop = () => undefined;

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
    project: "demo",
    kind: "spend",
    title: "Raise the monthly hosting budget",
    context: "The staging deploy needs a larger database plan.",
    options: [
      { id: "approve", label: "Approve the larger plan", consequences: "Costs more each month." },
      { id: "decline", label: "Keep the current plan", consequences: "The deploy stays blocked." },
    ],
    recommended: { optionId: "approve", reasoning: "Staging needs it to start." },
    source: { module: "delivery", ref: "env-staging" },
    key: "budget",
    blocks: ["deploy:staging"],
    links: [{ label: "Plans", url: "https://example.com/plans" }],
    createdAt: "2026-03-02T11:00:00.000Z",
    expiresAt: "2026-03-02T11:30:00.000Z",
    overdue: true,
    status: "open",
    ...overrides,
  };
}

function card(overrides: Partial<DecisionCardViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DecisionCardView, {
      decision: decision(),
      now: NOW,
      secretStore: "server memory only",
      stage: "choose",
      hasSecret: false,
      canAnswer: true,
      submitting: false,
      error: null,
      onChoose: noop,
      onConfirm: noop,
      onCancel: noop,
      onNote: noop,
      onSecret: noop,
      ...overrides,
    }),
  );
}

describe("DecisionCardView", () => {
  it("shows what is blocked and why, every option with its consequences, and the recommended one", () => {
    const html = card();
    expect(html).toContain("Raise the monthly hosting budget");
    expect(html).toContain("The staging deploy needs a larger database plan.");
    expect(html).toContain("deploy:staging");
    expect(html).toContain("Costs more each month.");
    expect(html).toContain("The deploy stays blocked.");
    expect(html).toContain("Approve the larger plan (recommended)");
    expect(html).toContain("Staging needs it to start.");
    expect(html).toContain("Overdue by 30 min");
    expect(html).toContain('href="https://example.com/plans"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('type="password"');
  });

  it("asks for confirmation before sending a spend answer", () => {
    const pending = decision().options[0];
    const html = card({ stage: "confirm", pending });
    expect(html).toContain("Confirm your answer");
    expect(html).toContain("Confirm: Approve the larger plan");
    expect(html).toContain('role="alertdialog"');
    // The option buttons give way to the confirmation step
    expect(html).not.toContain("(recommended)");
  });

  it("gives a credentials decision a password field that renders no value, and needs it before supplying", () => {
    const credentials = decision({
      kind: "credentials",
      secretName: "GIT_HOST_TOKEN",
      options: [
        { id: "supply", label: "Enter the token", consequences: "Stored.", suppliesSecret: true },
        { id: "later", label: "Not now", consequences: "Stays blocked." },
      ],
      recommended: { optionId: "supply", reasoning: "Needed." },
      expiresAt: undefined,
      overdue: false,
    });
    const empty = card({ decision: credentials });
    expect(empty).toContain('type="password"');
    // HTML attribute names are case-insensitive; React 18 renders this one as autoComplete
    expect(empty).toMatch(/autocomplete="new-password"/i);
    expect(empty).not.toMatch(/type="password"[^>]*value=/);
    expect(empty).toContain("GIT_HOST_TOKEN");
    expect(empty).toContain('title="Enter the secret first"');
    expect(card({ decision: credentials, hasSecret: true })).not.toContain('title="Enter the secret first"');
    // No note field: a secret could end up in it
    expect(empty).not.toContain("<textarea");
    expect(card()).toContain("<textarea");
  });

  it("disables every option until answering is unlocked in this browser", () => {
    const locked = card({ canAnswer: false });
    expect(locked.match(/title="Unlock answering first"/g)).toHaveLength(2);
    expect(locked.match(/<button type="button" disabled=""/g)).toHaveLength(2);
    expect(card()).not.toContain("Unlock answering first");
  });
});

describe("DecisionInboxView", () => {
  it("asks for the answer token while answering is locked", () => {
    const view = (answering: boolean) =>
      renderToStaticMarkup(
        createElement(DecisionInboxView, {
          decisions: [decision()],
          secretStore: "x",
          now: NOW,
          answering,
          onUnlock: async () => undefined,
          onAnswered: noop,
        }),
      );
    const locked = view(false);
    expect(locked).toContain('data-unlock="answering"');
    expect(locked).toContain("data/decisions.answer-token");
    expect(locked).toContain('name="answer-token"');
    expect(locked).toContain("Unlock answering first");
    const unlocked = view(true);
    expect(unlocked).not.toContain('data-unlock="answering"');
    expect(unlocked).not.toContain("Unlock answering first");
  });

  it("lists open decisions as cards and closed ones with their outcome, never a secret", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionInboxView, {
        decisions: [
          decision(),
          decision({
            id: "1b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
            kind: "credentials",
            title: "Connect the git host",
            secretName: "GIT_HOST_TOKEN",
            options: [{ id: "supply", label: "Enter the token", consequences: "Stored.", suppliesSecret: true }],
            recommended: { optionId: "supply", reasoning: "Needed." },
            status: "answered",
            answer: { optionId: "supply", secretSupplied: true },
            answeredBy: "owner",
            closedAt: "2026-03-02T11:45:00.000Z",
            overdue: false,
          }),
        ],
        secretStore: "server memory only",
        now: NOW,
        answering: true,
        onUnlock: async () => undefined,
        onAnswered: noop,
      }),
    );
    expect(html).toContain("Decisions (1 open)");
    expect(html).toContain("Raise the monthly hosting budget");
    expect(html).toContain("Connect the git host");
    expect(html).toContain("Enter the token (by owner); secret supplied");
  });

  it("says so when nothing needs you", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionInboxView, {
        decisions: [],
        secretStore: "x",
        now: NOW,
        answering: true,
        onUnlock: async () => undefined,
        onAnswered: noop,
      }),
    );
    expect(html).toContain("Nothing needs you right now.");
  });
});

describe("DecisionCountBadge", () => {
  it("shows the open count, red while any is overdue, and nothing at zero", () => {
    expect(renderToStaticMarkup(createElement(DecisionCountBadge, { open: 0, overdue: 0 }))).toBe("");
    const waiting = renderToStaticMarkup(createElement(DecisionCountBadge, { open: 3, overdue: 0 }));
    expect(waiting).toContain(">3<");
    expect(waiting).toContain("badge-warning");
    expect(renderToStaticMarkup(createElement(DecisionCountBadge, { open: 3, overdue: 1 }))).toContain("badge-error");
  });
});
