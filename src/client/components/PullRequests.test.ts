/**
 * "Re-check all" in the PRs section: the owner's, after a confirmation, and
 * it evaluates every open PR again (pr-view.ts prsToEvaluate), the newest
 * evaluation winning over the list's.
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrSummary } from "../../shared/review-types";
import { prsToEvaluate, recheckAllQuestion, summaryReadiness } from "../pr-view";
import { RecheckAllButton } from "./PullRequests";

const HEAD = "b".repeat(40);
const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 7,
  title: "Add login",
  headSha: HEAD,
  headRef: "feat/login",
  baseRef: "main",
  draft: false,
  updatedAt: null,
  tier: "amber",
  canMerge: false,
  reasons: ["a review is missing"],
  evaluatedAt: "2026-10-27T10:00:00.000Z",
  ...over,
});

type ButtonProps = { disabled: boolean; onClick: () => void };

function button(signedIn: boolean | null, confirm: (q: string) => boolean, onConfirmed: () => void) {
  return RecheckAllButton({ count: 3, signedIn, confirm, onConfirmed }) as ReactElement<ButtonProps>;
}

describe("Re-check all", () => {
  it("is the owner's: disabled and asks nothing until this browser is signed in", () => {
    const asked: string[] = [];
    let ran = 0;
    for (const signedIn of [false, null]) {
      const el = button(signedIn, (q) => (asked.push(q), true), () => (ran += 1));
      expect(el.props.disabled).toBe(true);
      el.props.onClick();
    }
    expect(asked).toEqual([]);
    expect(ran).toBe(0);
    expect(renderToStaticMarkup(createElement(RecheckAllButton, { count: 3, signedIn: false, confirm: () => true, onConfirmed: () => undefined }))).toContain(
      'disabled=""',
    );
  });

  it("asks first, and re-checks only when the owner confirms", () => {
    const asked: string[] = [];
    let ran = 0;
    button(true, (q) => (asked.push(q), false), () => (ran += 1)).props.onClick();
    expect(ran).toBe(0);
    button(true, (q) => (asked.push(q), true), () => (ran += 1)).props.onClick();
    expect(ran).toBe(1);
    expect(asked).toEqual([recheckAllQuestion(3), recheckAllQuestion(3)]);
    expect(asked[0]).toContain("all 3 open pull requests");
    expect(button(true, () => true, () => undefined).props.disabled).toBe(false);
  });

  it("evaluates every open PR when forced, else only those not evaluated at their head", () => {
    const prs = [summary(), summary({ number: 8, canMerge: null, evaluatedAt: null })];
    expect(prsToEvaluate(prs, false)).toEqual([{ number: 8, headRefOid: HEAD }]);
    expect(prsToEvaluate(prs, true)).toEqual([
      { number: 7, headRefOid: HEAD },
      { number: 8, headRefOid: HEAD },
    ]);
  });

  it("shows the re-check's answer once it is newer than the list's evaluation", () => {
    const pr = summary();
    const fresh = {
      headSha: HEAD,
      checkedAt: Date.parse("2026-10-27T10:05:00.000Z"),
      status: { headSha: HEAD, canMerge: true, reasons: [], risk: { tier: "green" } },
      error: null,
    } as unknown as Parameters<typeof summaryReadiness>[1];
    expect(summaryReadiness(pr).label).toBe("Waiting: a review is missing");
    expect(summaryReadiness(pr, fresh)).toMatchObject({ group: "ready", label: "Merge ready", tier: "green" });
    const older = { ...fresh!, checkedAt: Date.parse("2026-10-27T09:00:00.000Z") };
    expect(summaryReadiness(pr, older).label).toBe("Waiting: a review is missing");
  });
});
