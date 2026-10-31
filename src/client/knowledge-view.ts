/**
 * Knowledge view logic: state, filters, display helpers.
 * The React component is in components/Knowledge.tsx.
 *
 * Owner-only: lessons API requires owner auth.
 */
import type { LessonsListView, LessonSummary, LessonDetailView, LessonStatus, LessonScope } from "../shared/lessons-types";
import { listLessons, getLesson, approveLesson, retireLesson } from "./lessons-api";

export interface KnowledgeFilter {
  status: LessonStatus | "all";
  scope: LessonScope | "all";
}

export const DEFAULT_FILTER: KnowledgeFilter = { status: "all", scope: "all" };

export interface KnowledgeViewState {
  loading: boolean;
  error: string | null;
  view: LessonsListView | null;
  filter: KnowledgeFilter;
  detail: LessonDetailView | null;
  detailId: string | null;
}

export function initialKnowledgeState(): KnowledgeViewState {
  return {
    loading: true,
    error: null,
    view: null,
    filter: DEFAULT_FILTER,
    detail: null,
    detailId: null,
  };
}

export async function loadKnowledge(
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  setState({ ...state, loading: true, error: null });
  try {
    const filter = {
      status: state.filter.status === "all" ? undefined : state.filter.status,
      scope: state.filter.scope === "all" ? undefined : state.filter.scope,
    };
    const view = await listLessons(project, filter);
    setState({ ...state, loading: false, view, error: null });
  } catch (e) {
    setState({ ...state, loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function loadLessonDetail(
  id: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  setState({ ...state, detailId: id, detail: null });
  try {
    const detail = await getLesson(id);
    setState({ ...state, detailId: id, detail });
  } catch (e) {
    setState({ ...state, detailId: id, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleApprove(
  id: string,
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  try {
    await approveLesson(id);
    await loadKnowledge(project, state, setState);
    if (state.detailId === id) {
      await loadLessonDetail(id, state, setState);
    }
  } catch (e) {
    setState({ ...state, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleRetire(
  id: string,
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  try {
    await retireLesson(id);
    await loadKnowledge(project, state, setState);
    if (state.detailId === id) {
      await loadLessonDetail(id, state, setState);
    }
  } catch (e) {
    setState({ ...state, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Group lessons by signal kind for the grouped display. */
export function groupBySignalKind(lessons: LessonSummary[]): Map<string, LessonSummary[]> {
  const groups = new Map<string, LessonSummary[]>();
  for (const lesson of lessons) {
    const kind = lesson.signal.kind;
    const list = groups.get(kind) ?? [];
    list.push(lesson);
    groups.set(kind, list);
  }
  return groups;
}

export const STATUS_LABELS: Record<LessonStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  retired: "Retired",
};

/** Tone for status badges (matches ui/tokens Tone type). */
export const STATUS_TONES: Record<LessonStatus, "warning" | "success" | "neutral"> = {
  proposed: "warning",
  active: "success",
  retired: "neutral",
};

/** Legacy color names for backward compatibility. */
export const STATUS_COLORS = STATUS_TONES;

export const SCOPE_LABELS: Record<LessonScope, string> = {
  "built-in": "Built-in",
  project: "Project",
};

export const SIGNAL_KIND_LABELS: Record<string, string> = {
  check: "Checks",
  event: "Events",
  metric: "Metrics",
  pattern: "Patterns",
};

/** Format a date for display. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Summary text for the Knowledge view header. */
export function summaryText(counts: LessonsListView["counts"]): string {
  return `${counts.total} lessons: ${counts.active} active, ${counts.proposed} proposed, ${counts.retired} retired. ` +
    `${counts.builtIn} built-in, ${counts.project} project.`;
}

/** Check if a lesson can be approved (proposed -> active). */
export function canApprove(lesson: { status: LessonStatus }): boolean {
  return lesson.status === "proposed";
}

/** Check if a lesson can be retired. */
export function canRetire(lesson: { status: LessonStatus }): boolean {
  return lesson.status !== "retired";
}

/** Check if a lesson's content can be edited. Built-ins can only change status. */
export function canEditContent(lesson: { scope: LessonScope }): boolean {
  return lesson.scope === "project";
}
