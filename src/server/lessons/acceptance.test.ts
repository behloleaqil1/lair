/**
 * Acceptance tests for the lessons module (C8 PR 1: lessons store + built-in lessons + Knowledge view).
 *
 * These tests drive the real entry points (the store and the API routes) and
 * fail on github/main, where the lessons module does not exist.
 *
 * What's tested:
 * - Built-in lessons L1-L28 are loaded on start
 * - Owner-only writes: only the owner session can propose, approve, retire, edit
 * - The list API filters by status and scope
 * - Signal matching finds lessons by their signal
 * - The Knowledge view (GET /api/lessons) returns the lessons with counts
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { registerRootGuards } from "../root-guards.js";
import { mountLessons, BUILTIN_LESSONS, type LessonsModule } from "./index.js";
import type { LessonsListView, LessonDetailView, Lesson } from "../../shared/lessons-types.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
/** What a browser on the dashboard sends with a same-origin request */
const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

let app: FastifyInstance | null = null;
let module: LessonsModule | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  module = null;
  dir = null;
});

async function build() {
  dir = mkdtempSync(join(tmpdir(), "lair-lessons-"));
  const tokenPath = join(dir, "owner.token");
  const dbPath = join(dir, "lessons.db");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const clock = { t: NOW, now: (): number => clock.t };
  app = Fastify();
  registerRootGuards(app);
  await registerOwnerRoutes(app, auth);
  module = await mountLessons(app, {
    dbPath,
    humanAuth: auth,
    defaultProject: () => "example",
    clock: clock.now,
  });
  await app.ready();
  const answerToken = readFileSync(tokenPath, "utf-8").trim();
  return { app, module, clock, auth, answerToken };
}

/** Sign in the way the Knowledge view does; returns headers with the owner session. */
async function unlock(a: FastifyInstance, answerToken: string): Promise<Record<string, string>> {
  const res = await a.inject({ method: "POST", url: "/api/owner/sessions", payload: { token: answerToken }, headers: DASHBOARD });
  expect(res.statusCode).toBe(201);
  return { ...DASHBOARD, [OWNER_SESSION_HEADER]: res.json().data.session as string };
}

function get(a: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return a.inject({ method: "GET", url, headers });
}

function post(a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return a.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers });
}

function patch(a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return a.inject({ method: "PATCH", url, payload: payload as Record<string, unknown>, headers });
}

describe("built-in lessons load on start", () => {
  it("loads L1-L28 as active built-in lessons", async () => {
    const { app, module, answerToken } = await build();
    expect(module.builtInLoaded).toBe(BUILTIN_LESSONS.length);
    expect(module.builtInLoaded).toBeGreaterThanOrEqual(25); // At least L1-L25 from the seed

    const browser = await unlock(app, answerToken);
    const res = await get(app, "/api/lessons?scope=built-in", browser);
    expect(res.statusCode).toBe(200);
    const view = res.json().data as LessonsListView;
    expect(view.lessons.length).toBe(BUILTIN_LESSONS.length);
    expect(view.counts.builtIn).toBe(BUILTIN_LESSONS.length);
    expect(view.counts.active).toBe(BUILTIN_LESSONS.length);

    // Check L1 exists and has the right signal
    const l1 = view.lessons.find((l) => l.id === "L1");
    expect(l1).toBeDefined();
    expect(l1?.title).toBe("A gate runs far longer than it should");
    expect(l1?.signal.kind).toBe("metric");
    expect(l1?.status).toBe("active");
    expect(l1?.scope).toBe("built-in");
  });

  it("does not duplicate built-in lessons on restart", async () => {
    const { module: m1 } = await build();
    expect(m1.builtInLoaded).toBe(BUILTIN_LESSONS.length);
    await app?.close();

    // Build again with the same db
    app = Fastify();
    const tokenPath = join(dir!, "owner.token");
    const dbPath = join(dir!, "lessons.db");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    registerRootGuards(app);
    await registerOwnerRoutes(app, auth);
    module = await mountLessons(app, {
      dbPath,
      humanAuth: auth,
      defaultProject: () => "example",
    });
    await app.ready();

    // Should not load again
    expect(module.builtInLoaded).toBe(0);
    expect(module.store.counts().builtIn).toBe(BUILTIN_LESSONS.length);
  });
});

describe("owner-only writes", () => {
  it("refuses lesson creation without owner session (403)", async () => {
    const { app } = await build();
    const lesson = {
      title: "Test lesson",
      signal: { kind: "event", value: "test.event" },
      cause: "Testing",
      response: "Do nothing",
      prevention: "None",
    };
    const res = await post(app, "/api/lessons", lesson, DASHBOARD);
    expect(res.statusCode).toBe(403);
  });

  it("allows the owner to propose a project lesson", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const lesson = {
      title: "Test lesson",
      signal: { kind: "event", value: "test.event" },
      cause: "Testing",
      response: "Do nothing",
      prevention: "None",
    };
    const res = await post(app, "/api/lessons", lesson, browser);
    expect(res.statusCode).toBe(201);
    const created = res.json().data.lesson as Lesson;
    expect(created.title).toBe("Test lesson");
    expect(created.status).toBe("proposed");
    expect(created.scope).toBe("project");
  });

  it("allows the owner to approve a proposed lesson", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Create a proposed lesson
    const lesson = {
      title: "Approval test",
      signal: { kind: "check", value: "approval_test" },
      cause: "Testing approval",
      response: "Approve it",
      prevention: "None",
    };
    const createRes = await post(app, "/api/lessons", lesson, browser);
    expect(createRes.statusCode).toBe(201);
    const id = createRes.json().data.lesson.id;

    // Approve it
    const approveRes = await post(app, `/api/lessons/${id}/approve`, {}, browser);
    expect(approveRes.statusCode).toBe(200);
    const approved = approveRes.json().data as Lesson;
    expect(approved.status).toBe("active");
  });

  it("allows the owner to retire a lesson", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Retire L1 (a built-in)
    const retireRes = await post(app, "/api/lessons/L1/retire", {}, browser);
    expect(retireRes.statusCode).toBe(200);
    const retired = retireRes.json().data as Lesson;
    expect(retired.status).toBe("retired");
  });

  it("allows the owner to edit a project lesson but not built-in content", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Create a project lesson
    const lesson = {
      title: "Edit test",
      signal: { kind: "pattern", value: "edit_test" },
      cause: "Testing edit",
      response: "Edit it",
      prevention: "None",
    };
    const createRes = await post(app, "/api/lessons", lesson, browser);
    const id = createRes.json().data.lesson.id;

    // Edit the project lesson (allowed)
    const editRes = await patch(app, `/api/lessons/${id}`, { title: "Edited title" }, browser);
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().data.title).toBe("Edited title");

    // Try to edit L1's title (built-in: only status can change)
    const builtInEdit = await patch(app, "/api/lessons/L1", { title: "New title" }, browser);
    expect(builtInEdit.statusCode).toBe(400);
    expect(builtInEdit.json().error).toContain("Built-in lessons can only have their status changed");

    // But status can change
    const statusEdit = await patch(app, "/api/lessons/L1", { status: "retired" }, browser);
    expect(statusEdit.statusCode).toBe(200);
  });
});

describe("list and filter lessons", () => {
  it("lists all lessons by default", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    const res = await get(app, "/api/lessons", browser);
    expect(res.statusCode).toBe(200);
    const view = res.json().data as LessonsListView;
    expect(view.lessons.length).toBeGreaterThanOrEqual(BUILTIN_LESSONS.length);
    expect(view.enabled).toBe(true);
    expect(view.project).toBe("example");
  });

  it("filters by status", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Create a proposed lesson
    await post(app, "/api/lessons", {
      title: "Proposed one",
      signal: { kind: "event", value: "proposed.event" },
      cause: "Testing",
      response: "Wait",
      prevention: "None",
    }, browser);

    const activeRes = await get(app, "/api/lessons?status=active", browser);
    const view = activeRes.json().data as LessonsListView;
    expect(view.lessons.every((l) => l.status === "active")).toBe(true);
    expect(view.counts.active).toBe(view.lessons.length);

    const proposedRes = await get(app, "/api/lessons?status=proposed", browser);
    const proposedView = proposedRes.json().data as LessonsListView;
    expect(proposedView.lessons.length).toBe(1);
    expect(proposedView.lessons[0].title).toBe("Proposed one");
  });

  it("filters by scope", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Add a project lesson
    await post(app, "/api/lessons", {
      title: "Project lesson",
      signal: { kind: "event", value: "project.event" },
      cause: "Testing",
      response: "Project response",
      prevention: "None",
    }, browser);

    const builtInRes = await get(app, "/api/lessons?scope=built-in", browser);
    const builtInView = builtInRes.json().data as LessonsListView;
    expect(builtInView.lessons.every((l) => l.scope === "built-in")).toBe(true);

    const projectRes = await get(app, "/api/lessons?scope=project", browser);
    const projectView = projectRes.json().data as LessonsListView;
    expect(projectView.lessons.length).toBe(1);
    expect(projectView.lessons[0].scope).toBe("project");
  });
});

describe("signal matching", () => {
  it("finds lessons by their signal value", async () => {
    const { module } = await build();

    // L4 has signal value containing "exit 125"
    const matches = module.store.findBySignal("pattern", "exit 125|Cannot connect to the Docker daemon");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].id).toBe("L4");
  });

  it("records a signal match and increments the count", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Get L1's initial count
    const before = await get(app, "/api/lessons/L1", browser);
    const initialCount = before.json().data.lesson.matchCount;

    // Record a match
    const matchRes = await post(app, "/api/lessons/L1/match", { evidence: "Test match" }, browser);
    expect(matchRes.statusCode).toBe(200);
    expect(matchRes.json().data.matchCount).toBe(initialCount + 1);

    // Verify
    const after = await get(app, "/api/lessons/L1", browser);
    expect(after.json().data.lesson.matchCount).toBe(initialCount + 1);
    expect(after.json().data.lesson.lastMatchAt).toBeTruthy();
  });

  it("reuses an existing lesson when proposing one with the same signal", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // L1's signal is { kind: "metric", value: "gate_duration_seconds" }
    // Proposing a lesson with the same signal should reuse L1
    const res = await post(app, "/api/lessons", {
      title: "Duplicate of L1",
      signal: { kind: "metric", value: "gate_duration_seconds" },
      cause: "Same as L1",
      response: "Same as L1",
      prevention: "Same as L1",
    }, browser);
    expect(res.statusCode).toBe(200); // 200, not 201 - reused
    expect(res.json().data.reused).toBe(true);
    expect(res.json().data.lesson.id).toBe("L1");
    expect(res.json().data.lesson.matchCount).toBeGreaterThan(0);
  });
});

describe("lesson detail view", () => {
  it("returns the lesson with related lessons", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    const res = await get(app, "/api/lessons/L1", browser);
    expect(res.statusCode).toBe(200);
    const view = res.json().data as LessonDetailView;
    expect(view.lesson.id).toBe("L1");
    expect(view.lesson.title).toBe("A gate runs far longer than it should");
    expect(view.lesson.signal).toEqual({
      kind: "metric",
      value: "gate_duration_seconds",
      threshold: 2400,
      direction: "above",
    });
    expect(view.lesson.sources).toHaveLength(1);
    expect(view.lesson.sources[0].kind).toBe("manual");
    // Related lessons (same signal kind or value) may be empty or not
    expect(Array.isArray(view.related)).toBe(true);
  });

  it("returns 404 for unknown lesson", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    const res = await get(app, "/api/lessons/L999", browser);
    expect(res.statusCode).toBe(404);
  });
});

describe("the Knowledge view counts", () => {
  it("returns accurate counts", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);

    // Create a proposed lesson
    await post(app, "/api/lessons", {
      title: "Proposed",
      signal: { kind: "event", value: "proposed" },
      cause: "Test",
      response: "Test",
      prevention: "Test",
    }, browser);

    // Retire L1
    await post(app, "/api/lessons/L1/retire", {}, browser);

    const res = await get(app, "/api/lessons", browser);
    const view = res.json().data as LessonsListView;
    expect(view.counts.total).toBe(BUILTIN_LESSONS.length + 1);
    expect(view.counts.active).toBe(BUILTIN_LESSONS.length - 1); // L1 retired
    expect(view.counts.proposed).toBe(1);
    expect(view.counts.retired).toBe(1);
    expect(view.counts.builtIn).toBe(BUILTIN_LESSONS.length);
    expect(view.counts.project).toBe(1);
  });
});
