import { describe, expect, it } from "vitest";
import type { Decision } from "../shared/decision-types";
import { answerBody, confirmationText, expiryText, needsConfirmation, outcomeText } from "./decisions-api";
import { tokenFromHash } from "./owner-session";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
    project: "demo",
    kind: "other",
    attention: "action",
    title: "Pick the default page size",
    context: "The list view needs a page size.",
    options: [
      { id: "small", label: "20 rows", consequences: "Faster pages." },
      { id: "large", label: "100 rows", consequences: "Less paging." },
    ],
    recommended: { optionId: "small", reasoning: "Most lists are short." },
    source: { module: "planner", ref: "card-12" },
    key: "page-size",
    blocks: [],
    links: [],
    createdAt: "2026-03-02T11:00:00.000Z",
    overdue: false,
    status: "open",
    raisedVia: "server",
    ...overrides,
  };
}

const credentials = decision({
  kind: "credentials",
  secretName: "GIT_HOST_TOKEN",
  options: [
    { id: "supply", label: "Enter the token", consequences: "Stored.", suppliesSecret: true },
    { id: "later", label: "Not now", consequences: "Stays blocked." },
  ],
  recommended: { optionId: "supply", reasoning: "Needed." },
});

describe("answer rules", () => {
  it("confirms spend and go/no-go answers only", () => {
    expect(needsConfirmation("spend")).toBe(true);
    expect(needsConfirmation("go_no_go")).toBe(true);
    for (const kind of ["pricing", "legal", "account", "credentials", "security", "escalation", "other"] as const) {
      expect(needsConfirmation(kind)).toBe(false);
    }
  });

  it("builds the answer body: confirm for spend, a trimmed note, the secret only for the option that supplies it", () => {
    expect(answerBody(decision(), { optionId: "large", note: "  " })).toEqual({ optionId: "large" });
    expect(answerBody(decision({ kind: "spend" }), { optionId: "large", note: " ok " })).toEqual({
      optionId: "large",
      note: "ok",
      confirm: true,
    });
    expect(answerBody(credentials, { optionId: "supply", note: "", secret: "typed-value" })).toEqual({
      optionId: "supply",
      secret: "typed-value",
    });
    expect(answerBody(credentials, { optionId: "later", note: "", secret: "typed-value" })).toEqual({
      optionId: "later",
    });
    // Credentials decisions take no note
    expect(answerBody(credentials, { optionId: "later", note: "the token is abc" })).toEqual({ optionId: "later" });
  });

  it("takes the answer token only from a setup link's fragment", () => {
    const token = "Abc_def-0123456789Abc_def-0123456789Abc_def";
    expect(tokenFromHash(`#owner-token=${token}`)).toBe(token);
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#owner-token=short")).toBeNull();
    expect(tokenFromHash(`#owner-token=${token}&next=/x`)).toBeNull();
    expect(tokenFromHash(`#other=${token}`)).toBeNull();
  });

  it("says what is being confirmed, with the consequences", () => {
    const budget = decision({ kind: "spend" });
    expect(confirmationText(budget, budget.options[1])).toBe('Spend decision: "100 rows". Less paging.');
  });
});

describe("display text", () => {
  it("describes the expiry: in the future, overdue, with or without a default", () => {
    expect(expiryText(decision(), NOW)).toBeNull();
    expect(expiryText(decision({ expiresAt: "2026-03-02T12:30:00.000Z" }), NOW)).toBe(
      "Expires in 30 min; it keeps waiting after that",
    );
    expect(
      expiryText(decision({ expiresAt: "2026-03-02T15:00:00.000Z", defaultOptionId: "large" }), NOW),
    ).toBe('Expires in 3 h; then "100 rows" applies');
    expect(expiryText(decision({ expiresAt: "2026-03-02T11:00:00.000Z", overdue: true }), NOW)).toBe(
      "Overdue by 1 h: still waiting for your answer",
    );
    expect(
      expiryText(decision({ expiresAt: "2026-03-02T11:59:00.000Z", defaultOptionId: "large" }), NOW + MIN),
    ).toBe('Expired: "100 rows" applies at the next check');
    expect(expiryText(decision({ expiresAt: "2026-03-02T11:00:00.000Z", status: "answered" }), NOW)).toBeNull();
  });

  it("describes how a decision ended, without any secret", () => {
    expect(
      outcomeText({
        ...credentials,
        status: "answered",
        answer: { optionId: "supply", secretSupplied: true },
        answeredBy: "owner",
      }),
    ).toBe("Enter the token (by owner); secret supplied");
    expect(outcomeText(decision({ status: "expired", answer: { optionId: "large" }, answeredBy: "lair" }))).toBe(
      'Expired unanswered; its default "100 rows" applied',
    );
    expect(outcomeText(decision({ status: "withdrawn", withdrawnReason: "Done another way." }))).toBe(
      "Withdrawn by planner: Done another way.",
    );
  });
});
