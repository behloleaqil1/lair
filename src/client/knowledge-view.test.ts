/**
 * Tests for the Knowledge view logic: grouping, filters, display helpers.
 */
import { describe, expect, it } from "vitest";
import {
  groupBySignalKind,
  STATUS_LABELS,
  STATUS_TONES,
  SCOPE_LABELS,
  SIGNAL_KIND_LABELS,
  DEFAULT_FILTER,
  formatDate,
  summaryText,
  canApprove,
  canRetire,
  canEditContent,
  initialKnowledgeState,
} from "./knowledge-view";
import type { LessonSummary, LessonsListView } from "../shared/lessons-types";

function makeSummary(overrides: Partial<LessonSummary> = {}): LessonSummary {
  return {
    id: "L1",
    title: "Test lesson",
    signal: { kind: "check", value: "test_check" },
    status: "active",
    scope: "built-in",
    matchCount: 5,
    lastMatchAt: "2026-10-30T12:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("initialKnowledgeState", () => {
  it("returns a loading state with no data", () => {
    const state = initialKnowledgeState();
    expect(state.loading).toBe(true);
    expect(state.view).toBeNull();
    expect(state.detail).toBeNull();
    expect(state.filter.status).toBe("all");
    expect(state.filter.scope).toBe("all");
  });
});

describe("DEFAULT_FILTER", () => {
  it("has all filters set to 'all'", () => {
    expect(DEFAULT_FILTER.status).toBe("all");
    expect(DEFAULT_FILTER.scope).toBe("all");
  });
});

describe("groupBySignalKind", () => {
  it("groups lessons by signal kind", () => {
    const lessons = [
      makeSummary({ id: "L1", signal: { kind: "check", value: "check1" } }),
      makeSummary({ id: "L2", signal: { kind: "event", value: "event1" } }),
      makeSummary({ id: "L3", signal: { kind: "check", value: "check2" } }),
      makeSummary({ id: "L4", signal: { kind: "metric", value: "metric1" } }),
    ];
    const grouped = groupBySignalKind(lessons);
    expect(grouped.size).toBe(3);
    expect(grouped.get("check")?.length).toBe(2);
    expect(grouped.get("event")?.length).toBe(1);
    expect(grouped.get("metric")?.length).toBe(1);
  });

  it("returns empty map for empty input", () => {
    const grouped = groupBySignalKind([]);
    expect(grouped.size).toBe(0);
  });

  it("preserves order within groups", () => {
    const lessons = [
      makeSummary({ id: "L1", signal: { kind: "check", value: "a" } }),
      makeSummary({ id: "L2", signal: { kind: "check", value: "b" } }),
      makeSummary({ id: "L3", signal: { kind: "check", value: "c" } }),
    ];
    const grouped = groupBySignalKind(lessons);
    const checks = grouped.get("check")!;
    expect(checks[0].id).toBe("L1");
    expect(checks[1].id).toBe("L2");
    expect(checks[2].id).toBe("L3");
  });
});

describe("STATUS_LABELS", () => {
  it("has labels for all statuses", () => {
    expect(STATUS_LABELS.proposed).toBe("Proposed");
    expect(STATUS_LABELS.active).toBe("Active");
    expect(STATUS_LABELS.retired).toBe("Retired");
  });
});

describe("STATUS_TONES", () => {
  it("has tones for all statuses", () => {
    expect(STATUS_TONES.proposed).toBe("warning");
    expect(STATUS_TONES.active).toBe("success");
    expect(STATUS_TONES.retired).toBe("neutral");
  });
});

describe("SCOPE_LABELS", () => {
  it("has labels for all scopes", () => {
    expect(SCOPE_LABELS["built-in"]).toBe("Built-in");
    expect(SCOPE_LABELS.project).toBe("Project");
  });
});

describe("SIGNAL_KIND_LABELS", () => {
  it("has labels for all signal kinds", () => {
    expect(SIGNAL_KIND_LABELS.check).toBe("Checks");
    expect(SIGNAL_KIND_LABELS.event).toBe("Events");
    expect(SIGNAL_KIND_LABELS.metric).toBe("Metrics");
    expect(SIGNAL_KIND_LABELS.pattern).toBe("Patterns");
  });
});

describe("formatDate", () => {
  it("formats a date string", () => {
    const result = formatDate("2026-10-30T12:00:00.000Z");
    // Date formatting is locale-dependent; just check it produces something
    expect(result).not.toBe("—");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });
});

describe("summaryText", () => {
  it("returns a summary string", () => {
    const counts: LessonsListView["counts"] = {
      total: 28,
      active: 25,
      proposed: 2,
      retired: 1,
      builtIn: 26,
      project: 2,
    };
    const text = summaryText(counts);
    expect(text).toContain("28 lessons");
    expect(text).toContain("25 active");
    expect(text).toContain("2 proposed");
    expect(text).toContain("1 retired");
    expect(text).toContain("26 built-in");
    expect(text).toContain("2 project");
  });
});

describe("canApprove", () => {
  it("returns true for proposed lessons", () => {
    expect(canApprove({ status: "proposed" })).toBe(true);
  });

  it("returns false for active lessons", () => {
    expect(canApprove({ status: "active" })).toBe(false);
  });

  it("returns false for retired lessons", () => {
    expect(canApprove({ status: "retired" })).toBe(false);
  });
});

describe("canRetire", () => {
  it("returns true for active lessons", () => {
    expect(canRetire({ status: "active" })).toBe(true);
  });

  it("returns true for proposed lessons", () => {
    expect(canRetire({ status: "proposed" })).toBe(true);
  });

  it("returns false for retired lessons", () => {
    expect(canRetire({ status: "retired" })).toBe(false);
  });
});

describe("canEditContent", () => {
  it("returns true for project lessons", () => {
    expect(canEditContent({ scope: "project" })).toBe(true);
  });

  it("returns false for built-in lessons", () => {
    expect(canEditContent({ scope: "built-in" })).toBe(false);
  });
});
