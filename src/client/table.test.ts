/**
 * The one table's sorting and keyboard moves (table.ts), and how times read
 * (time.ts).
 */
import { describe, expect, it } from "vitest";
import { ariaSort, compareValues, moveFocus, nextSort, opensRow, sortRows } from "./table";
import { absoluteTime, durationText, gitDateToIso, relativeTime, secondsBetween } from "./time";

describe("table sorting", () => {
  const rows = [
    { id: "run 10", n: 3 },
    { id: "run 2", n: null },
    { id: "Run 1", n: 1 },
    { id: "", n: 2 },
  ];

  it("sorts text numerically and without case, numbers by value, empty values last either way", () => {
    expect(sortRows(rows, (r) => r.id, "asc").map((r) => r.id)).toEqual(["Run 1", "run 2", "run 10", ""]);
    expect(sortRows(rows, (r) => r.id, "desc").map((r) => r.id)).toEqual(["run 10", "run 2", "Run 1", ""]);
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.n)).toEqual([1, 2, 3, null]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.n)).toEqual([3, 2, 1, null]);
    expect(compareValues(true, false)).toBeLessThan(0);
  });

  it("keeps equal rows in their order", () => {
    const same = [{ k: "a", i: 1 }, { k: "a", i: 2 }, { k: "a", i: 3 }];
    expect(sortRows(same, (r) => r.k, "desc").map((r) => r.i)).toEqual([1, 2, 3]);
  });

  it("sorts by a header ascending first, then flips it", () => {
    const first = nextSort(null, "age");
    expect(first).toEqual({ key: "age", dir: "asc" });
    expect(nextSort(first, "age")).toEqual({ key: "age", dir: "desc" });
    expect(nextSort({ key: "age", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(ariaSort(first, "age")).toBe("ascending");
    expect(ariaSort(first, "name")).toBe("none");
  });
});

describe("table keys", () => {
  it("moves between rows with the arrows, Home and End, and opens one with Enter or Space", () => {
    expect(moveFocus(0, "ArrowDown", 3)).toBe(1);
    expect(moveFocus(2, "ArrowDown", 3)).toBe(2);
    expect(moveFocus(0, "ArrowUp", 3)).toBe(0);
    expect(moveFocus(1, "Home", 3)).toBe(0);
    expect(moveFocus(1, "End", 3)).toBe(2);
    expect(moveFocus(1, "a", 3)).toBeNull();
    expect(moveFocus(0, "ArrowDown", 0)).toBeNull();
    expect(opensRow("Enter")).toBe(true);
    expect(opensRow(" ")).toBe(true);
    expect(opensRow("Escape")).toBe(false);
  });
});

describe("times", () => {
  const NOW = Date.parse("2026-10-27T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('reads "5 min ago", with the absolute time for the hover', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(relativeTime(ago(4 * 86_400_000), NOW)).toBe("4 days ago");
    expect(relativeTime(ago(-12 * 60_000), NOW)).toBe("in 12 min");
    expect(relativeTime(undefined, NOW)).toBe("—");
    expect(relativeTime("not a time", NOW)).toBe("—");
    expect(absoluteTime(ago(0))).toBe(new Date(NOW).toLocaleString());
    expect(absoluteTime(null)).toBe("");
  });

  it("reads durations and git's dates", () => {
    expect(durationText(42)).toBe("42 s");
    expect(durationText(210)).toBe("3.5 min");
    expect(durationText(3900)).toBe("1 h 5 min");
    expect(durationText(null)).toBe("—");
    expect(secondsBetween("2026-10-27T12:00:00Z", "2026-10-27T12:01:30Z")).toBe(90);
    expect(secondsBetween(null, "2026-10-27T12:01:30Z")).toBeNull();
    expect(gitDateToIso("2026-10-24 14:35:00 +0200")).toBe("2026-10-24T14:35:00+02:00");
    expect(Date.parse(gitDateToIso("2026-10-24 14:35:00 +0200")!)).toBe(Date.parse("2026-10-24T12:35:00Z"));
    expect(gitDateToIso("unknown")).toBeNull();
  });
});
