/**
 * Healer retry limit: every reschedule creates a new job id, so retries must
 * be counted per task or maxRetries is never reached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "../../shared/server-types.js";

const mocks = vi.hoisted(() => ({
  jobs: new Map<string, Partial<Job>>(),
  updateTaskStatus: vi.fn(),
  tick: vi.fn(async () => {}),
}));

vi.mock("../store/store.js", () => ({
  getStore: () => ({
    getJob: (id: string) => mocks.jobs.get(id),
    getTask: (id: string) => ({ id, title: `task ${id}` }),
    updateTaskStatus: mocks.updateTaskStatus,
  }),
}));

vi.mock("../scheduler/scheduler.js", () => ({
  getScheduler: () => ({ tick: mocks.tick }),
}));

vi.mock("../nodes/node-manager.js", () => ({
  getNodeManager: () => ({ cancelJob: vi.fn() }),
}));

import { Healer } from "./healer.js";

type HealerInternals = {
  handleJobFailed(jobId: string, error?: string): Promise<void>;
};

describe("Healer retry limit", () => {
  beforeEach(() => {
    mocks.jobs.clear();
    mocks.updateTaskStatus.mockClear();
    mocks.tick.mockClear();
  });

  it("stops rescheduling a task after maxRetries, across new job ids", async () => {
    const healer = new Healer({ maxRetries: 3, autoReschedule: true });
    const internals = healer as unknown as HealerInternals;

    // Each failure is a NEW job for the same task (what a reschedule produces)
    for (let attempt = 0; attempt < 6; attempt++) {
      const jobId = `job-${attempt}`;
      mocks.jobs.set(jobId, { id: jobId, taskId: "task-1", nodeId: "node-1" });
      await internals.handleJobFailed(jobId, "boom");
    }

    expect(mocks.tick).toHaveBeenCalledTimes(3);
    expect(healer.getTaskRetryCount("task-1")).toBe(3);
    const last = healer.getEvents().at(-1);
    expect(last?.type).toBe("job_failed");
    expect(last?.action).toBe("No more retries");
  });

  it("counts retries separately per task", async () => {
    const healer = new Healer({ maxRetries: 1, autoReschedule: true });
    const internals = healer as unknown as HealerInternals;

    mocks.jobs.set("a-1", { id: "a-1", taskId: "task-a", nodeId: "n" });
    mocks.jobs.set("b-1", { id: "b-1", taskId: "task-b", nodeId: "n" });
    await internals.handleJobFailed("a-1");
    await internals.handleJobFailed("b-1");

    expect(mocks.tick).toHaveBeenCalledTimes(2);
  });
});
