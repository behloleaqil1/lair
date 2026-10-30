/**
 * Tests for the Knowledge view: lessons list grouped by signal kind,
 * status and scope badges, detail view with related lessons.
 */
import { describe, expect, it } from "vitest";
import {
  initialKnowledgeState,
  renderLessonRow,
  renderLessonDetail,
  type KnowledgeViewState,
} from "./knowledge-view";
import { groupBySignalKind, STATUS_LABELS, STATUS_COLORS, SIGNAL_KIND_LABELS } from "./lessons-api";
import type { LessonSummary, LessonDetailView, Lesson } from "../shared/lessons-types";
import { render } from "lit-html";

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

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "L1",
    title: "Test lesson",
    signal: { kind: "check", value: "test_check" },
    cause: "Test cause",
    response: "Test response",
    prevention: "Test prevention",
    sources: [{ kind: "manual", ref: "builtin-seed", at: "2026-10-30T00:00:00.000Z" }],
    status: "active",
    scope: "built-in",
    matchCount: 5,
    lastMatchAt: "2026-10-30T12:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-30T12:00:00.000Z",
    feature: "D28",
    version: 1,
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
});

describe("STATUS_LABELS", () => {
  it("has labels for all statuses", () => {
    expect(STATUS_LABELS.proposed).toBe("Proposed");
    expect(STATUS_LABELS.active).toBe("Active");
    expect(STATUS_LABELS.retired).toBe("Retired");
  });
});

describe("STATUS_COLORS", () => {
  it("has colors for all statuses", () => {
    expect(STATUS_COLORS.proposed).toBe("yellow");
    expect(STATUS_COLORS.active).toBe("green");
    expect(STATUS_COLORS.retired).toBe("gray");
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

describe("renderLessonRow", () => {
  it("renders a lesson row with all fields", () => {
    const lesson = makeSummary();
    const container = document.createElement("tbody");
    const calls: string[] = [];
    render(renderLessonRow(lesson, (id) => calls.push(id)), container);

    const row = container.querySelector("tr");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("L1");
    expect(row?.textContent).toContain("Test lesson");
    expect(row?.textContent).toContain("test_check");
    expect(row?.textContent).toContain("Active");
    expect(row?.textContent).toContain("Built-in");
    expect(row?.textContent).toContain("5");
  });

  it("calls onSelect when clicked", () => {
    const lesson = makeSummary({ id: "L42" });
    const container = document.createElement("tbody");
    const calls: string[] = [];
    render(renderLessonRow(lesson, (id) => calls.push(id)), container);

    const row = container.querySelector("tr");
    row?.click();
    expect(calls).toEqual(["L42"]);
  });
});

describe("renderLessonDetail", () => {
  it("renders the lesson detail with all fields", () => {
    const lesson = makeLesson();
    const detail: LessonDetailView = { lesson, related: [] };
    const container = document.createElement("div");
    const calls: { action: string; id: string }[] = [];

    render(
      renderLessonDetail(
        detail,
        (id) => calls.push({ action: "approve", id }),
        (id) => calls.push({ action: "retire", id }),
        () => calls.push({ action: "close", id: "" }),
        (id) => calls.push({ action: "related", id }),
      ),
      container,
    );

    expect(container.textContent).toContain("L1: Test lesson");
    expect(container.textContent).toContain("Test cause");
    expect(container.textContent).toContain("Test response");
    expect(container.textContent).toContain("Test prevention");
    expect(container.textContent).toContain("D28");
    expect(container.textContent).toContain("test_check");
  });

  it("shows approve button for proposed lessons", () => {
    const lesson = makeLesson({ status: "proposed" });
    const detail: LessonDetailView = { lesson, related: [] };
    const container = document.createElement("div");

    render(
      renderLessonDetail(detail, () => {}, () => {}, () => {}, () => {}),
      container,
    );

    const approveBtn = container.querySelector("button.btn-primary");
    expect(approveBtn?.textContent).toContain("Approve");
  });

  it("does not show approve button for active lessons", () => {
    const lesson = makeLesson({ status: "active" });
    const detail: LessonDetailView = { lesson, related: [] };
    const container = document.createElement("div");

    render(
      renderLessonDetail(detail, () => {}, () => {}, () => {}, () => {}),
      container,
    );

    const approveBtn = container.querySelector("button.btn-primary");
    expect(approveBtn).toBeNull();
  });

  it("shows related lessons", () => {
    const lesson = makeLesson({ id: "L10", signal: { kind: "check", value: "event_loop_lag" } });
    const related: LessonSummary[] = [
      makeSummary({ id: "L26", title: "Related lesson", signal: { kind: "check", value: "event_loop_lag" } }),
    ];
    const detail: LessonDetailView = { lesson, related };
    const container = document.createElement("div");
    const calls: string[] = [];

    render(
      renderLessonDetail(
        detail,
        () => {},
        () => {},
        () => {},
        (id) => calls.push(id),
      ),
      container,
    );

    expect(container.textContent).toContain("Related lessons");
    expect(container.textContent).toContain("L26: Related lesson");

    // Click the related lesson
    const relatedBtn = container.querySelector(".related-lessons button");
    (relatedBtn as HTMLButtonElement)?.click();
    expect(calls).toEqual(["L26"]);
  });
});
