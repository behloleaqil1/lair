/**
 * G1's quota lines (docs/design/ai-spend.md §4.5): the quota patterns, run in a vm that interrupts them, and the
 * reset times a pattern's (?<reset>...) group captures.
 */
import { describe, expect, it } from "vitest";
import { matchQuota, QUOTA_MAX_COOLDOWN_MS, quotaResetAt } from "./failover.js";

const HOUR = 3_600_000;

describe("G1 quota lines: matchQuota and quotaResetAt", () => {
  it("a clock time without a zone is the server's local time, at its next occurrence", () => {
    const oneAm = new Date(2026, 2, 3, 1, 0, 0).getTime();
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 2, day, hour, minute, 0).getTime();
    expect(quotaResetAt("5am", oneAm)).toBe(local(3, 5));
    expect(quotaResetAt("5 AM", oneAm)).toBe(local(3, 5));
    expect(quotaResetAt("5:30 p.m.", oneAm)).toBe(local(3, 17, 30));
    expect(quotaResetAt("12pm", oneAm)).toBe(local(3, 12));
    expect(quotaResetAt("13:05", oneAm)).toBe(local(3, 13, 5));
    // Already past today: tomorrow's
    expect(quotaResetAt("12:30am", oneAm)).toBe(local(4, 0, 30));
    expect(quotaResetAt("1am", oneAm)).toBe(local(4, 1));
  });

  it("a zone, an ISO time and 'in <n>' are read; the cooldown is capped at 24 h", () => {
    const noon = Date.parse("2026-03-03T12:00:00Z");
    expect(quotaResetAt("14:00 UTC", noon)).toBe(Date.parse("2026-03-03T14:00:00Z"));
    expect(quotaResetAt("11:00Z", noon)).toBe(Date.parse("2026-03-04T11:00:00Z"));
    expect(quotaResetAt("6pm (+05:00)", noon)).toBe(Date.parse("2026-03-03T13:00:00Z"));
    expect(quotaResetAt("9am (America/New_York)", noon)).toBe(Date.parse("2026-03-03T14:00:00Z"));
    expect(quotaResetAt("11pm (Asia/Tokyo)", noon)).toBe(Date.parse("2026-03-03T14:00:00Z"));
    expect(quotaResetAt("2026-03-03T18:00:00Z", noon)).toBe(Date.parse("2026-03-03T18:00:00Z"));
    expect(quotaResetAt("2026-03-03T20:00:00+05:00", noon)).toBe(Date.parse("2026-03-03T15:00:00Z"));
    expect(quotaResetAt("in 90 minutes", noon)).toBe(noon + 1.5 * HOUR);
    expect(quotaResetAt("in 2 hours", noon)).toBe(noon + 2 * HOUR);
    expect(quotaResetAt("in 30 hours", noon)).toBe(noon + QUOTA_MAX_COOLDOWN_MS);
    expect(quotaResetAt("2026-03-06T00:00:00Z", noon)).toBe(noon + QUOTA_MAX_COOLDOWN_MS);
  });

  it("anything else is not a time: the cooldown falls back to the backoff", () => {
    const noon = Date.parse("2026-03-03T12:00:00Z");
    for (const text of ["tomorrow", "soon", "", "25:00", "13pm", "0am", "5:75", "5am (Nowhere/Zone)", "2026-03-03T11:00:00Z", "2026-03-03T18:00:00", "in 0 minutes"]) {
      expect([text, quotaResetAt(text, noon)]).toEqual([text, null]);
    }
  });

  it("the newest line a pattern matches, with its reset capture; patterns that backtrack badly are interrupted: no match", () => {
    const withReset = /hit your .* limit . resets (?<reset>\d{1,2}(:\d{2})?\s?[ap]m)/i;
    const patterns = [/DAILY_REQUEST_COUNT/i, withReset];
    expect(matchQuota(["working", "You've hit your daily limit · resets 5am"], patterns)).toEqual({ index: 1, reset: "5am" });
    expect(matchQuota(['HTTP 429 body={"reason":"DAILY_REQUEST_COUNT"}', "exiting"], patterns)).toEqual({ index: 0, reset: null });
    expect(matchQuota(["DAILY_REQUEST_COUNT", "You've hit your daily limit · resets 7pm"], patterns)).toEqual({ index: 1, reset: "7pm" });
    expect(matchQuota(["added a daily request counter"], [/DAILY_REQUEST_COUNT/, withReset])).toBeNull();
    expect(matchQuota(["DAILY_REQUEST_COUNT"], [])).toBeNull();
    expect(matchQuota([], patterns)).toBeNull();
    const started = Date.now();
    expect(matchQuota(["DAILY_REQUEST_COUNT", `${"a".repeat(40)}!`], [/(a+)+$/, /DAILY_REQUEST_COUNT/])).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    // The vm is reusable after an interrupted run
    expect(matchQuota(["DAILY_REQUEST_COUNT"], [/DAILY_REQUEST_COUNT/])).toEqual({ index: 0, reset: null });
  });
});
