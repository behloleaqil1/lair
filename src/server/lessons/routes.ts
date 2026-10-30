/**
 * The lessons module's routes.
 *
 * Owner-only from a signed-in dashboard (requireOwner()):
 *
 *   GET  /api/lessons?project=&status=&scope=&limit=  list lessons
 *   GET  /api/lessons/:id                             one lesson detail
 *   POST /api/lessons                                 propose a new lesson (owner only)
 *   PATCH /api/lessons/:id                            update a lesson (owner only)
 *   POST /api/lessons/:id/approve                     approve a proposed lesson (owner only)
 *   POST /api/lessons/:id/retire                      retire a lesson (owner only)
 *   POST /api/lessons/:id/match                       record a signal match (internal, signed results)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { projectNameError } from "../config.js";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type {
  CreateLessonRequest,
  LessonDetailView,
  LessonsListView,
  LessonSignal,
  LessonStatus,
  ProposeLessonResponse,
  UpdateLessonRequest,
} from "../../shared/lessons-types.js";
import type { LessonsStore } from "./store.js";
import type { LessonsSettings } from "./config.js";

export interface LessonsRoutesOptions {
  store: LessonsStore;
  auth: HumanAuth;
  settings: (project: string) => LessonsSettings;
  defaultProject(): string;
  projectsDir?: string;
  clock?: () => number;
}

const ok = <T>(data: T) => ({ success: true, data, timestamp: new Date().toISOString() });

function refuse(reply: FastifyReply, statusCode: number, error: string) {
  return reply.code(statusCode).send({ success: false, error, timestamp: new Date().toISOString() });
}

const VALID_SIGNAL_KINDS = ["check", "event", "metric", "pattern"] as const;
const VALID_STATUSES: LessonStatus[] = ["proposed", "active", "retired"];

function validateSignal(signal: unknown): { ok: true; signal: LessonSignal } | { ok: false; error: string } {
  if (typeof signal !== "object" || signal === null) {
    return { ok: false, error: "signal must be an object with kind and value" };
  }
  const s = signal as Record<string, unknown>;
  if (!VALID_SIGNAL_KINDS.includes(s.kind as (typeof VALID_SIGNAL_KINDS)[number])) {
    return { ok: false, error: `signal.kind must be one of: ${VALID_SIGNAL_KINDS.join(", ")}` };
  }
  if (typeof s.value !== "string" || s.value.trim() === "") {
    return { ok: false, error: "signal.value must be a non-empty string" };
  }
  const validated: LessonSignal = { kind: s.kind as LessonSignal["kind"], value: s.value.slice(0, 500) };
  if (s.kind === "metric") {
    if (s.threshold !== undefined) {
      if (typeof s.threshold !== "number") return { ok: false, error: "signal.threshold must be a number" };
      validated.threshold = s.threshold;
    }
    if (s.direction !== undefined) {
      if (s.direction !== "above" && s.direction !== "below") {
        return { ok: false, error: "signal.direction must be 'above' or 'below'" };
      }
      validated.direction = s.direction;
    }
  }
  return { ok: true, signal: validated };
}

export async function registerLessonsRoutes(fastify: FastifyInstance, options: LessonsRoutesOptions): Promise<void> {
  const { store, auth } = options;
  const clock = options.clock ?? Date.now;

  const projectOf = (value: unknown, reply: FastifyReply): string | null => {
    const project = typeof value === "string" && value !== "" ? value : options.defaultProject();
    const problem = projectNameError(project, options.projectsDir);
    if (problem) {
      void refuse(reply, 400, problem);
      return null;
    }
    return project;
  };

  // Owner-only routes
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", auth.requireOwner("Only the owner can manage lessons, from the dashboard signed in as the owner"));

    // List lessons
    app.get<{ Querystring: { project?: string; status?: string; scope?: string; limit?: string } }>(
      "/api/lessons",
      async (request, reply) => {
        const project = projectOf(request.query.project, reply);
        if (project === null) return reply;
        const settings = options.settings(project);
        const status = VALID_STATUSES.includes(request.query.status as LessonStatus)
          ? (request.query.status as LessonStatus)
          : undefined;
        const scope = request.query.scope === "built-in" || request.query.scope === "project" ? request.query.scope : undefined;
        const limit = request.query.limit ? Math.min(Math.max(1, parseInt(request.query.limit, 10)), 500) : 100;

        const lessons = store.list({ status, scope: scope as "built-in" | "project", limit });
        const counts = store.counts();

        const view: LessonsListView = {
          project,
          enabled: settings.enabled,
          lessons,
          counts,
        };
        return reply.send(ok(view));
      },
    );

    // Get lesson detail
    app.get<{ Params: { id: string } }>("/api/lessons/:id", async (request, reply) => {
      const lesson = store.get(request.params.id);
      if (!lesson) return refuse(reply, 404, "Lesson not found");

      // Find related lessons (same signal kind and similar value)
      const related = store.findBySignal(lesson.signal.kind, lesson.signal.value).filter((l) => l.id !== lesson.id);

      const view: LessonDetailView = {
        lesson,
        related: related.map((l) => ({
          id: l.id,
          title: l.title,
          signal: l.signal,
          status: l.status,
          scope: l.scope,
          matchCount: l.matchCount,
          lastMatchAt: l.lastMatchAt,
          createdAt: l.createdAt,
        })),
      };
      return reply.send(ok(view));
    });

    // Create/propose a lesson
    app.post<{ Body: CreateLessonRequest }>("/api/lessons", { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const body = request.body ?? {};

      if (typeof body.title !== "string" || body.title.trim() === "") {
        return refuse(reply, 400, "title is required");
      }
      const signalResult = validateSignal(body.signal);
      if (!signalResult.ok) return refuse(reply, 400, signalResult.error);
      if (typeof body.cause !== "string" || body.cause.trim() === "") {
        return refuse(reply, 400, "cause is required");
      }
      if (typeof body.response !== "string" || body.response.trim() === "") {
        return refuse(reply, 400, "response is required");
      }
      if (typeof body.prevention !== "string" || body.prevention.trim() === "") {
        return refuse(reply, 400, "prevention is required");
      }

      // Check if a lesson with the same signal already exists
      const existing = store.findBySignal(signalResult.signal.kind, signalResult.signal.value);
      if (existing.length > 0) {
        // Reuse the first matching lesson: increment its match count
        const reused = existing[0];
        store.recordMatch(reused.id, clock());
        const response: ProposeLessonResponse = {
          lesson: store.get(reused.id)!,
          reused: true,
        };
        return reply.code(200).send(ok(response));
      }

      const now = clock();
      store.add(
        {
          title: body.title.trim(),
          signal: signalResult.signal,
          cause: body.cause.trim(),
          response: body.response.trim(),
          prevention: body.prevention.trim(),
          sources: [{ kind: "manual", ref: "owner", at: new Date(now).toISOString() }],
          status: "proposed",
          scope: "project",
          feature: body.feature ?? null,
        },
        now,
      );

      // Find the newly created lesson (last created with this title)
      const lessons = store.list({ limit: 1 });
      const response: ProposeLessonResponse = {
        lesson: lessons.length > 0 ? store.get(lessons[0].id)! : store.get(body.title)!,
        reused: false,
      };
      return reply.code(201).send(ok(response));
    });

    // Update a lesson
    app.patch<{ Params: { id: string }; Body: UpdateLessonRequest }>("/api/lessons/:id", { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const lesson = store.get(request.params.id);
      if (!lesson) return refuse(reply, 404, "Lesson not found");

      // Built-in lessons can only have their status changed
      if (lesson.scope === "built-in") {
        const body = request.body ?? {};
        if (Object.keys(body).some((k) => k !== "status")) {
          return refuse(reply, 400, "Built-in lessons can only have their status changed");
        }
      }

      const body = request.body ?? {};
      const updates: Parameters<typeof store.update>[1] = {};

      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.trim() === "") {
          return refuse(reply, 400, "title must be a non-empty string");
        }
        updates.title = body.title.trim();
      }
      if (body.signal !== undefined) {
        const signalResult = validateSignal(body.signal);
        if (!signalResult.ok) return refuse(reply, 400, signalResult.error);
        updates.signal = signalResult.signal;
      }
      if (body.cause !== undefined) {
        if (typeof body.cause !== "string") return refuse(reply, 400, "cause must be a string");
        updates.cause = body.cause;
      }
      if (body.response !== undefined) {
        if (typeof body.response !== "string") return refuse(reply, 400, "response must be a string");
        updates.response = body.response;
      }
      if (body.prevention !== undefined) {
        if (typeof body.prevention !== "string") return refuse(reply, 400, "prevention must be a string");
        updates.prevention = body.prevention;
      }
      if (body.status !== undefined) {
        if (!VALID_STATUSES.includes(body.status)) {
          return refuse(reply, 400, `status must be one of: ${VALID_STATUSES.join(", ")}`);
        }
        updates.status = body.status;
      }
      if (body.feature !== undefined) {
        updates.feature = body.feature;
      }

      if (Object.keys(updates).length === 0) {
        return refuse(reply, 400, "No fields to update");
      }

      store.update(request.params.id, updates, clock());
      return reply.send(ok(store.get(request.params.id)));
    });

    // Approve a proposed lesson
    app.post<{ Params: { id: string } }>("/api/lessons/:id/approve", { bodyLimit: 1024 }, async (request, reply) => {
      const lesson = store.get(request.params.id);
      if (!lesson) return refuse(reply, 404, "Lesson not found");
      if (lesson.status !== "proposed") {
        return refuse(reply, 400, "Only proposed lessons can be approved");
      }
      store.update(request.params.id, { status: "active" }, clock());
      return reply.send(ok(store.get(request.params.id)));
    });

    // Retire a lesson
    app.post<{ Params: { id: string } }>("/api/lessons/:id/retire", { bodyLimit: 1024 }, async (request, reply) => {
      const lesson = store.get(request.params.id);
      if (!lesson) return refuse(reply, 404, "Lesson not found");
      if (lesson.status === "retired") {
        return refuse(reply, 400, "Lesson is already retired");
      }
      store.update(request.params.id, { status: "retired" }, clock());
      return reply.send(ok(store.get(request.params.id)));
    });

    // Record a signal match (internal use, but owner can trigger for testing)
    app.post<{ Params: { id: string }; Body: { evidence?: string } }>("/api/lessons/:id/match", { bodyLimit: 4096 }, async (request, reply) => {
      const lesson = store.get(request.params.id);
      if (!lesson) return refuse(reply, 404, "Lesson not found");
      store.recordMatch(request.params.id, clock());
      return reply.send(ok({ id: request.params.id, matchCount: (store.get(request.params.id)?.matchCount ?? 0) }));
    });
  });
}
