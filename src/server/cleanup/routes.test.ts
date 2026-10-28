import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { cleanupRoutes, type CleanupRoutesDeps } from "./routes.js";
import { CleanupStore } from "./store.js";
import type { CleanupService, CleanupPending } from "./service.js";

describe("cleanup routes", () => {
  let store: CleanupStore;
  let app: ReturnType<typeof Fastify>;
  let mockService: CleanupService;

  beforeEach(async () => {
    store = new CleanupStore(":memory:");
    mockService = {
      getPending: async (): Promise<CleanupPending> => ({
        worktrees: [
          {
            path: "/repo/wt-1",
            branch: "feature",
            head: "abc123",
            removable: true,
            reason: "merged PR #42",
            isMain: false,
          },
        ],
        retention: [
          {
            path: "/results/old.log",
            entryPath: "/results",
            kind: "file",
            removable: true,
            reason: "unused for 10 days",
            lastUsedMs: 0,
            sizeBytes: 1024,
          },
        ],
        totalBytes: 52429824,
        totalEntries: 2,
      }),
    } as CleanupService;

    const deps: CleanupRoutesDeps = {
      store,
      getService: (project) => (project === "test" ? mockService : null),
    };

    app = Fastify();
    await app.register(cleanupRoutes, { prefix: "/api/cleanup", deps });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  describe("GET /api/cleanup/status", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/status?project=unknown",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns status for enabled project", async () => {
      // Add a completed cycle
      const cycle = store.startCycle("test", "observe");
      store.finishCycle(cycle.id, 5, 10240, 2);

      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/status?project=test",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.project).toBe("test");
      expect(body.lastCycle).toBeTruthy();
      expect(body.lastCycle.entriesRemoved).toBe(5);
      expect(body.pending.totalEntries).toBe(2);
    });
  });

  describe("GET /api/cleanup/pending", () => {
    it("returns pending list", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/pending?project=test",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.worktrees).toHaveLength(1);
      expect(body.worktrees[0].branch).toBe("feature");
      expect(body.retention).toHaveLength(1);
      expect(body.retention[0].path).toBe("/results/old.log");
    });
  });

  describe("GET /api/cleanup/removals", () => {
    it("returns recent removals", async () => {
      store.recordRemoval({
        project: "test",
        path: "/repo/wt-1",
        kind: "worktree",
        reason: "merged",
        bytesFreed: 1024000,
        removedAt: Date.now(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/removals?project=test",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.removals).toHaveLength(1);
      expect(body.removals[0].path).toBe("/repo/wt-1");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        store.recordRemoval({
          project: "test",
          path: `/path-${i}`,
          kind: "file",
          reason: "old",
          bytesFreed: 100,
          removedAt: Date.now() + i,
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/removals?project=test&limit=3",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.removals).toHaveLength(3);
    });
  });

  describe("GET /api/cleanup/cycles", () => {
    it("returns recent cycles", async () => {
      const cycle = store.startCycle("test", "act");
      store.finishCycle(cycle.id, 3, 5000, 1);

      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/cycles?project=test",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cycles).toHaveLength(1);
      expect(body.cycles[0].mode).toBe("act");
      expect(body.cycles[0].entriesRemoved).toBe(3);
    });
  });

  describe("GET /api/cleanup/stats", () => {
    it("returns statistics", async () => {
      const now = Date.now();
      store.recordRemoval({
        project: "test",
        path: "/old",
        kind: "file",
        reason: "old",
        bytesFreed: 1000,
        removedAt: now - 2 * 24 * 60 * 60 * 1000, // 2 days ago
      });
      store.recordRemoval({
        project: "test",
        path: "/recent",
        kind: "file",
        reason: "recent",
        bytesFreed: 2000,
        removedAt: now - 1000, // Just now
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/cleanup/stats?project=test",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allTime.bytesFreed).toBe(3000);
      expect(body.allTime.entriesRemoved).toBe(2);
      expect(body.last24Hours.bytesFreed).toBe(2000);
      expect(body.last24Hours.entriesRemoved).toBe(1);
    });
  });
});
