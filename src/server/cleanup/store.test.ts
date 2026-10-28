import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CleanupStore } from "./store.js";

describe("CleanupStore", () => {
  let store: CleanupStore;

  beforeEach(() => {
    store = new CleanupStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("removals", () => {
    it("records and retrieves a removal", () => {
      const removal = store.recordRemoval({
        project: "test",
        path: "/repo/worktree-1",
        kind: "worktree",
        reason: "merged PR #42",
        bytesFreed: 1024000,
        removedAt: Date.now(),
      });

      expect(removal.id).toBeTruthy();
      expect(removal.path).toBe("/repo/worktree-1");

      const recent = store.getRecentRemovals("test", 10);
      expect(recent).toHaveLength(1);
      expect(recent[0].path).toBe("/repo/worktree-1");
    });

    it("checks if path was removed", () => {
      store.recordRemoval({
        project: "test",
        path: "/repo/worktree-1",
        kind: "worktree",
        reason: "merged",
        bytesFreed: 1024,
        removedAt: Date.now(),
      });

      expect(store.wasRemoved("test", "/repo/worktree-1")).toBe(true);
      expect(store.wasRemoved("test", "/repo/worktree-2")).toBe(false);
      expect(store.wasRemoved("other", "/repo/worktree-1")).toBe(false);
    });

    it("gets removals by paths", () => {
      store.recordRemoval({
        project: "test",
        path: "/a",
        kind: "file",
        reason: "old",
        bytesFreed: 100,
        removedAt: Date.now(),
      });
      store.recordRemoval({
        project: "test",
        path: "/b",
        kind: "file",
        reason: "old",
        bytesFreed: 200,
        removedAt: Date.now(),
      });

      const map = store.getRemovalsByPaths("test", ["/a", "/c"]);
      expect(map.has("/a")).toBe(true);
      expect(map.has("/c")).toBe(false);
    });

    it("limits recent removals", () => {
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

      const recent = store.getRecentRemovals("test", 5);
      expect(recent).toHaveLength(5);
      // Most recent first
      expect(recent[0].path).toBe("/path-9");
    });
  });

  describe("cycles", () => {
    it("starts and finishes a cycle", () => {
      const cycle = store.startCycle("test", "observe");
      expect(cycle.id).toBeTruthy();
      expect(cycle.finishedAt).toBeNull();
      expect(cycle.mode).toBe("observe");

      store.finishCycle(cycle.id, 5, 10240, 2);

      const recent = store.getRecentCycles("test", 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].finishedAt).toBeTruthy();
      expect(recent[0].entriesRemoved).toBe(5);
      expect(recent[0].bytesFreed).toBe(10240);
      expect(recent[0].entriesSkipped).toBe(2);
    });

    it("gets last completed cycle", () => {
      const cycle1 = store.startCycle("test", "observe");
      store.finishCycle(cycle1.id, 1, 100, 0);

      // Add a small delay to ensure different finished_at timestamps
      const cycle2 = store.startCycle("test", "act");
      // Manually update the started_at to ensure it's later (so finished_at is also later)
      store["db"]
        .prepare("UPDATE cleanup_cycles SET started_at = started_at + 1 WHERE id = ?")
        .run(cycle2.id);
      store.finishCycle(cycle2.id, 2, 200, 1);

      store.startCycle("test", "observe"); // Incomplete

      const last = store.getLastCompletedCycle("test");
      expect(last).toBeTruthy();
      expect(last!.entriesRemoved).toBe(2);
    });

    it("finds incomplete cycles", () => {
      const cycle1 = store.startCycle("test", "observe");
      store.finishCycle(cycle1.id, 1, 100, 0);

      const cycle2 = store.startCycle("test", "act"); // Incomplete

      const incomplete = store.getIncompleteCycles("test");
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].id).toBe(cycle2.id);
    });

    it("marks incomplete cycle", () => {
      const cycle = store.startCycle("test", "observe");
      store.markCycleIncomplete(cycle.id);

      const incomplete = store.getIncompleteCycles("test");
      expect(incomplete).toHaveLength(0);

      const recent = store.getRecentCycles("test", 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].entriesSkipped).toBe(-1); // Marker for interrupted
    });
  });

  describe("stats", () => {
    it("calculates total bytes freed", () => {
      store.recordRemoval({
        project: "test",
        path: "/a",
        kind: "file",
        reason: "old",
        bytesFreed: 1000,
        removedAt: Date.now(),
      });
      store.recordRemoval({
        project: "test",
        path: "/b",
        kind: "file",
        reason: "old",
        bytesFreed: 2000,
        removedAt: Date.now(),
      });

      expect(store.getTotalBytesFreed("test")).toBe(3000);
    });

    it("calculates total bytes freed since time", () => {
      const oldTime = Date.now() - 1000;
      const newTime = Date.now();

      store.recordRemoval({
        project: "test",
        path: "/old",
        kind: "file",
        reason: "old",
        bytesFreed: 1000,
        removedAt: oldTime,
      });
      store.recordRemoval({
        project: "test",
        path: "/new",
        kind: "file",
        reason: "new",
        bytesFreed: 2000,
        removedAt: newTime,
      });

      expect(store.getTotalBytesFreed("test", newTime - 500)).toBe(2000);
    });

    it("counts total entries removed", () => {
      store.recordRemoval({
        project: "test",
        path: "/a",
        kind: "file",
        reason: "old",
        bytesFreed: 1000,
        removedAt: Date.now(),
      });
      store.recordRemoval({
        project: "test",
        path: "/b",
        kind: "file",
        reason: "old",
        bytesFreed: 2000,
        removedAt: Date.now(),
      });

      expect(store.getTotalEntriesRemoved("test")).toBe(2);
    });

    it("isolates stats by project", () => {
      store.recordRemoval({
        project: "test1",
        path: "/a",
        kind: "file",
        reason: "old",
        bytesFreed: 1000,
        removedAt: Date.now(),
      });
      store.recordRemoval({
        project: "test2",
        path: "/b",
        kind: "file",
        reason: "old",
        bytesFreed: 2000,
        removedAt: Date.now(),
      });

      expect(store.getTotalBytesFreed("test1")).toBe(1000);
      expect(store.getTotalBytesFreed("test2")).toBe(2000);
    });
  });
});
