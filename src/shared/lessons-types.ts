/**
 * The lessons store (src/server/lessons/), shared by the server's routes
 * and the dashboard's Knowledge view.
 * docs/design/autonomy.md §8 (knowledge and learning loop)
 */

/**
 * A signal that triggers a lesson: how to detect the situation.
 * A lesson matches when its signal fires.
 */
export interface LessonSignal {
  /** What the signal watches: a check id, an event kind, a metric name, or a log pattern */
  kind: "check" | "event" | "metric" | "pattern";
  /** The check id, event type, metric name, or regex pattern */
  value: string;
  /** For metrics: the threshold that triggers the signal */
  threshold?: number;
  /** For metrics: whether to trigger above or below the threshold */
  direction?: "above" | "below";
}

/** proposed: awaiting owner approval; active: in use; retired: no longer used */
export type LessonStatus = "proposed" | "active" | "retired";

/** built-in: ships with Lair; project: added for this project */
export type LessonScope = "built-in" | "project";

/**
 * A source that contributed to this lesson: an incident, an escalation,
 * or a manual entry.
 */
export interface LessonSource {
  /** incident, escalation, or manual */
  kind: string;
  /** The incident or escalation id, or "manual" */
  ref: string;
  /** When this source was recorded */
  at: string;
}

/**
 * A lesson: what Lair learned from an incident or experience.
 */
export interface Lesson {
  /** L1, L2, ... for built-in; UUID for project lessons */
  id: string;
  /** Short title describing the situation */
  title: string;
  /** How to detect this situation */
  signal: LessonSignal;
  /** What causes this situation */
  cause: string;
  /** What to do when it happens (a playbook ref or text) */
  response: string;
  /** How to prevent it (a check or feature ref) */
  prevention: string;
  /** Where this lesson came from */
  sources: LessonSource[];
  status: LessonStatus;
  scope: LessonScope;
  /** How many times this lesson's signal has matched */
  matchCount: number;
  /** When the signal last matched */
  lastMatchAt: string | null;
  /** When this lesson was created */
  createdAt: string;
  /** When this lesson was last updated */
  updatedAt: string;
  /** The feature or duty that makes this automatic (e.g., "D28", "#89") */
  feature: string | null;
  /** Content version (increment when built-in lesson content changes) */
  version: number;
}

/** What the list API returns: a lesson summary */
export interface LessonSummary {
  id: string;
  title: string;
  signal: LessonSignal;
  status: LessonStatus;
  scope: LessonScope;
  matchCount: number;
  lastMatchAt: string | null;
  createdAt: string;
}

/** The request to create a lesson */
export interface CreateLessonRequest {
  title: string;
  signal: LessonSignal;
  cause: string;
  response: string;
  prevention: string;
  feature?: string | null;
}

/** The request to update a lesson */
export interface UpdateLessonRequest {
  title?: string;
  signal?: LessonSignal;
  cause?: string;
  response?: string;
  prevention?: string;
  status?: LessonStatus;
  feature?: string | null;
}

/** GET /api/lessons */
export interface LessonsListView {
  project: string;
  enabled: boolean;
  lessons: LessonSummary[];
  counts: {
    total: number;
    active: number;
    proposed: number;
    retired: number;
    builtIn: number;
    project: number;
  };
}

/** GET /api/lessons/:id */
export interface LessonDetailView {
  lesson: Lesson;
  /** Lessons with a similar signal */
  related: LessonSummary[];
}

/** POST /api/lessons/:id/match - record a signal match */
export interface RecordMatchRequest {
  /** What triggered the match */
  evidence?: string;
}

/** POST /api/lessons - propose a new lesson */
export interface ProposeLessonResponse {
  lesson: Lesson;
  /** Whether an existing lesson was reused (its match count incremented) */
  reused: boolean;
}
