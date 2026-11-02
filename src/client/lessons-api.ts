/**
 * Lessons API for the Knowledge view: list, detail, and owner actions.
 */
import type {
  LessonsListView,
  LessonDetailView,
  Lesson,
  LessonStatus,
  ProposeLessonResponse,
  CreateLessonRequest,
  UpdateLessonRequest,
} from "../shared/lessons-types";
import { fetchApi, ownerHeaders } from "./owner-session";

export const STATUS_LABELS: Record<LessonStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  retired: "Retired",
};

export const STATUS_TONES: Record<LessonStatus, "warning" | "success" | "neutral"> = {
  proposed: "warning",
  active: "success",
  retired: "neutral",
};

/** @deprecated Use STATUS_TONES */
export const STATUS_COLORS = STATUS_TONES;

export interface LessonFilter {
  status?: LessonStatus;
  scope?: "built-in" | "project";
  limit?: number;
}

/**
 * List lessons with optional filters.
 */
export function listLessons(project: string, filter?: LessonFilter): Promise<LessonsListView> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (filter?.status) params.set("status", filter.status);
  if (filter?.scope) params.set("scope", filter.scope);
  if (filter?.limit) params.set("limit", String(filter.limit));
  const query = params.toString();
  return fetchApi<LessonsListView>(`/api/lessons${query ? `?${query}` : ""}`, {
    headers: ownerHeaders(),
  });
}

/**
 * Get a single lesson's detail.
 */
export function getLesson(id: string): Promise<LessonDetailView> {
  return fetchApi<LessonDetailView>(`/api/lessons/${encodeURIComponent(id)}`, {
    headers: ownerHeaders(),
  });
}

/**
 * Propose a new lesson.
 */
export function proposeLesson(request: CreateLessonRequest): Promise<ProposeLessonResponse> {
  return fetchApi<ProposeLessonResponse>("/api/lessons", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: JSON.stringify(request),
  });
}

/**
 * Update a lesson.
 */
export function updateLesson(id: string, request: UpdateLessonRequest): Promise<Lesson> {
  return fetchApi<Lesson>(`/api/lessons/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: JSON.stringify(request),
  });
}

/**
 * Approve a proposed lesson.
 */
export function approveLesson(id: string): Promise<Lesson> {
  return fetchApi<Lesson>(`/api/lessons/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: "{}",
  });
}

/**
 * Retire a lesson.
 */
export function retireLesson(id: string): Promise<Lesson> {
  return fetchApi<Lesson>(`/api/lessons/${encodeURIComponent(id)}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: "{}",
  });
}

/**
 * Record a signal match (for testing).
 */
export function recordMatch(id: string, evidence?: string): Promise<{ id: string; matchCount: number }> {
  return fetchApi<{ id: string; matchCount: number }>(`/api/lessons/${encodeURIComponent(id)}/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: JSON.stringify({ evidence }),
  });
}

/**
 * Group lessons by signal kind for the Knowledge view.
 */
export function groupBySignalKind(lessons: { signal: { kind: string } }[]): Map<string, typeof lessons> {
  const groups = new Map<string, typeof lessons>();
  for (const lesson of lessons) {
    const kind = lesson.signal.kind;
    const list = groups.get(kind) ?? [];
    list.push(lesson);
    groups.set(kind, list);
  }
  return groups;
}

export const SIGNAL_KIND_LABELS: Record<string, string> = {
  check: "Checks",
  event: "Events",
  metric: "Metrics",
  pattern: "Patterns",
};
