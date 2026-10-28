/**
 * Read-only routes for the cleanup module.
 */
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { CleanupStore } from "./store.js";
import type { CleanupService, CleanupPending } from "./service.js";

export interface CleanupRoutesDeps {
  store: CleanupStore;
  getService: (project: string) => CleanupService | null;
}

interface ProjectQuery {
  project: string;
}

interface LimitQuery extends ProjectQuery {
  limit?: string;
}

export async function cleanupRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { deps: CleanupRoutesDeps },
): Promise<void> {
  const { store, getService } = opts.deps;

  // GET /api/cleanup/status - current mode, last cycle, pending
  app.get<{ Querystring: ProjectQuery }>(
    "/status",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["project"],
          properties: { project: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { project } = req.query;
      const service = getService(project);

      if (!service) {
        return reply.status(404).send({ error: "cleanup not enabled for project" });
      }

      const lastCycle = store.getLastCompletedCycle(project);
      let pending: CleanupPending | null = null;
      try {
        pending = await service.getPending();
      } catch {
        // If we can't get pending, return null
      }

      return {
        project,
        lastCycle: lastCycle
          ? {
              id: lastCycle.id,
              mode: lastCycle.mode,
              finishedAt: lastCycle.finishedAt,
              entriesRemoved: lastCycle.entriesRemoved,
              bytesFreed: lastCycle.bytesFreed,
              entriesSkipped: lastCycle.entriesSkipped,
            }
          : null,
        pending: pending
          ? {
              totalEntries: pending.totalEntries,
              totalBytes: pending.totalBytes,
              worktreeCount: pending.worktrees.length,
              retentionCount: pending.retention.length,
            }
          : null,
      };
    },
  );

  // GET /api/cleanup/pending - detailed pending list
  app.get<{ Querystring: ProjectQuery }>(
    "/pending",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["project"],
          properties: { project: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { project } = req.query;
      const service = getService(project);

      if (!service) {
        return reply.status(404).send({ error: "cleanup not enabled for project" });
      }

      try {
        const pending = await service.getPending();
        return {
          project,
          worktrees: pending.worktrees.map((w) => ({
            path: w.path,
            branch: w.branch,
            reason: w.reason,
            pr: w.pr,
          })),
          retention: pending.retention.map((r) => ({
            path: r.path,
            kind: r.kind,
            reason: r.reason,
            sizeBytes: r.sizeBytes,
          })),
          totalEntries: pending.totalEntries,
          totalBytes: pending.totalBytes,
        };
      } catch (err) {
        return reply.status(500).send({ error: "failed to get pending" });
      }
    },
  );

  // GET /api/cleanup/removals - recent removals
  app.get<{ Querystring: LimitQuery }>(
    "/removals",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["project"],
          properties: {
            project: { type: "string" },
            limit: { type: "string" },
          },
        },
      },
    },
    async (req, _reply) => {
      const { project, limit } = req.query;
      const limitNum = Math.min(parseInt(limit || "100", 10), 500);

      const removals = store.getRecentRemovals(project, limitNum);
      return {
        project,
        removals: removals.map((r) => ({
          id: r.id,
          path: r.path,
          kind: r.kind,
          reason: r.reason,
          bytesFreed: r.bytesFreed,
          removedAt: r.removedAt,
        })),
      };
    },
  );

  // GET /api/cleanup/cycles - recent cycles
  app.get<{ Querystring: LimitQuery }>(
    "/cycles",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["project"],
          properties: {
            project: { type: "string" },
            limit: { type: "string" },
          },
        },
      },
    },
    async (req, _reply) => {
      const { project, limit } = req.query;
      const limitNum = Math.min(parseInt(limit || "20", 10), 100);

      const cycles = store.getRecentCycles(project, limitNum);
      return {
        project,
        cycles: cycles.map((c) => ({
          id: c.id,
          mode: c.mode,
          startedAt: c.startedAt,
          finishedAt: c.finishedAt,
          entriesRemoved: c.entriesRemoved,
          bytesFreed: c.bytesFreed,
          entriesSkipped: c.entriesSkipped,
        })),
      };
    },
  );

  // GET /api/cleanup/stats - summary statistics
  app.get<{ Querystring: ProjectQuery }>(
    "/stats",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["project"],
          properties: { project: { type: "string" } },
        },
      },
    },
    async (req, _reply) => {
      const { project } = req.query;

      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      return {
        project,
        allTime: {
          bytesFreed: store.getTotalBytesFreed(project),
          entriesRemoved: store.getTotalEntriesRemoved(project),
        },
        last24Hours: {
          bytesFreed: store.getTotalBytesFreed(project, dayAgo),
          entriesRemoved: store.getTotalEntriesRemoved(project, dayAgo),
        },
        last7Days: {
          bytesFreed: store.getTotalBytesFreed(project, weekAgo),
          entriesRemoved: store.getTotalEntriesRemoved(project, weekAgo),
        },
      };
    },
  );
}
