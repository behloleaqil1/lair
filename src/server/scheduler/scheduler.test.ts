/**
 * Scheduler tests.
 * Tests job dispatch logic: task-to-node matching, capacity checks, requirements filtering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Scheduler, getScheduler, stopScheduler } from "./scheduler.js";
import { resetEventBus, getEventBus } from "../core/event-bus.js";
import type { Node, Task, Job } from "../../shared/server-types.js";

// Mock store
const mockStore = {
  getQueuedTasks: vi.fn<[], Task[]>(),
  listAvailableNodes: vi.fn<[], Node[]>(),
  createJob: vi.fn<[string, string, number, number], Job>(),
  updateTaskStatus: vi.fn(),
  updateJobStatus: vi.fn(),
  listNodes: vi.fn<[], Node[]>(),
  countTasks: vi.fn<[string?], number>(),
  countJobs: vi.fn<[string?], number>(),
  countRunningAgents: vi.fn<[], number>(),
  getJob: vi.fn<[string], Job | null>(),
};

// Mock node manager
const mockNodeManager = {
  isNodeConnected: vi.fn<[string], boolean>(),
  assignJob: vi.fn<[string, unknown], boolean>(),
};

// Mock the modules
vi.mock("../store/store.js", () => ({
  getStore: () => mockStore,
  closeStore: vi.fn(),
}));

vi.mock("../nodes/node-manager.js", () => ({
  getNodeManager: () => mockNodeManager,
  initNodeManager: vi.fn(),
  closeNodeManager: vi.fn(),
}));

// Helper to create a node
function createNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-1",
    name: "Test Node",
    status: "online",
    capacity: {
      cores: 8,
      ramMb: 16384,
      diskGb: 100,
      gpuCount: 0,
      containerRuntime: "docker",
    },
    usedCapacity: { cores: 0, ramMb: 0 },
    activeJobs: 0,
    lastHeartbeat: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to create a task
function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "build",
    priority: 2,
    status: "queued",
    title: "Test Task",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to create a job
function createJob(taskId: string, nodeId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${taskId}`,
    taskId,
    nodeId,
    status: "pending",
    createdAt: new Date().toISOString(),
    allocatedCores: 1,
    allocatedRamMb: 512,
    ...overrides,
  };
}

describe("Scheduler", () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBus();
    stopScheduler();

    // Default mock implementations
    mockStore.getQueuedTasks.mockReturnValue([]);
    mockStore.listAvailableNodes.mockReturnValue([]);
    mockStore.listNodes.mockReturnValue([]);
    mockStore.countTasks.mockReturnValue(0);
    mockStore.countJobs.mockReturnValue(0);
    mockStore.countRunningAgents.mockReturnValue(0);
    mockNodeManager.isNodeConnected.mockReturnValue(true);
    mockNodeManager.assignJob.mockReturnValue(true);

    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe("tick()", () => {
    it("should do nothing when there are no queued tasks", async () => {
      mockStore.getQueuedTasks.mockReturnValue([]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
      expect(mockNodeManager.assignJob).not.toHaveBeenCalled();
    });

    it("should do nothing when there are no available nodes", async () => {
      mockStore.getQueuedTasks.mockReturnValue([createTask()]);
      mockStore.listAvailableNodes.mockReturnValue([]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
      expect(mockNodeManager.assignJob).not.toHaveBeenCalled();
    });

    it("should not assign to disconnected nodes", async () => {
      const node = createNode();
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockNodeManager.isNodeConnected.mockReturnValue(false);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
      expect(mockNodeManager.assignJob).not.toHaveBeenCalled();
    });

    it("should assign a task to an available node", async () => {
      const node = createNode();
      const task = createTask();
      const job = createJob(task.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, node.id, 1, 512);
      expect(mockStore.updateTaskStatus).toHaveBeenCalledWith(task.id, "assigned", {
        assignedNode: node.id,
        jobId: job.id,
      });
      expect(mockNodeManager.assignJob).toHaveBeenCalledWith(node.id, {
        jobId: job.id,
        taskId: task.id,
        task,
        allocatedCores: 1,
        allocatedRamMb: 512,
      });
    });

    it("should use task requirements for resource allocation", async () => {
      const node = createNode();
      const task = createTask({
        requirements: { minCores: 4, minRamMb: 2048 },
      });
      const job = createJob(task.id, node.id, { allocatedCores: 4, allocatedRamMb: 2048 });

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, node.id, 4, 2048);
    });

    it("should revert on failed assignment", async () => {
      const node = createNode();
      const task = createTask();
      const job = createJob(task.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);
      mockNodeManager.assignJob.mockReturnValue(false);

      await scheduler.tick();

      expect(mockStore.updateJobStatus).toHaveBeenCalledWith(job.id, "failed", {
        error: "Failed to send to node",
      });
      expect(mockStore.updateTaskStatus).toHaveBeenLastCalledWith(task.id, "queued", {
        assignedNode: undefined,
        jobId: undefined,
      });
    });

    it("should emit events on successful assignment", async () => {
      const node = createNode();
      const task = createTask();
      const job = createJob(task.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);

      const eventBus = getEventBus();
      const taskAssigned = vi.fn();
      const jobCreated = vi.fn();
      const schedulerTick = vi.fn();

      eventBus.on("task.assigned", taskAssigned);
      eventBus.on("job.created", jobCreated);
      eventBus.on("scheduler.tick", schedulerTick);

      await scheduler.tick();

      expect(taskAssigned).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "task.assigned",
          data: { taskId: task.id, nodeId: node.id, jobId: job.id },
        })
      );
      expect(jobCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "job.created",
          data: { jobId: job.id, taskId: task.id, nodeId: node.id },
        })
      );
      expect(schedulerTick).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "scheduler.tick",
          data: { assigned: 1, queued: 1 },
        })
      );
    });

    it("should assign multiple tasks to multiple nodes", async () => {
      const node1 = createNode({ id: "node-1", name: "Node 1" });
      const node2 = createNode({ id: "node-2", name: "Node 2" });
      const task1 = createTask({ id: "task-1", title: "Task 1" });
      const task2 = createTask({ id: "task-2", title: "Task 2" });
      const job1 = createJob(task1.id, node1.id);
      const job2 = createJob(task2.id, node2.id);

      mockStore.getQueuedTasks.mockReturnValue([task1, task2]);
      mockStore.listAvailableNodes.mockReturnValue([node1, node2]);
      mockStore.createJob
        .mockReturnValueOnce(job1)
        .mockReturnValueOnce(job2);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledTimes(2);
      expect(mockNodeManager.assignJob).toHaveBeenCalledTimes(2);
    });
  });

  describe("findBestNode() - capacity checks", () => {
    it("should not assign to node with insufficient cores", async () => {
      const node = createNode({
        capacity: { cores: 2, ramMb: 8192, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 2, ramMb: 0 },
      });
      const task = createTask({ requirements: { minCores: 2 } });

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);

      await scheduler.tick();

      // Node has 0 available cores, task needs 2
      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should not assign to node with insufficient RAM", async () => {
      const node = createNode({
        capacity: { cores: 8, ramMb: 1024, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 0, ramMb: 1024 },
      });
      const task = createTask({ requirements: { minRamMb: 512 } });

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);

      await scheduler.tick();

      // Node has 0 available RAM, task needs 512
      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should not assign to node at maxAgentsPerNode limit", async () => {
      const node = createNode({ activeJobs: 8 });
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);

      await scheduler.tick();

      // Default maxAgentsPerNode is 8, node has 8 active jobs
      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should assign to node with sufficient capacity", async () => {
      const node = createNode({
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 4, ramMb: 8192 },
        activeJobs: 4,
      });
      const task = createTask({ requirements: { minCores: 2, minRamMb: 1024 } });
      const job = createJob(task.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      // Node has 4 cores and 8192MB available, task needs 2 cores and 1024MB
      expect(mockStore.createJob).toHaveBeenCalled();
    });

    it("should prefer node with more free resources", async () => {
      const busyNode = createNode({
        id: "busy-node",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 6, ramMb: 12000 },
      });
      const freeNode = createNode({
        id: "free-node",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 0, ramMb: 0 },
      });
      const task = createTask();
      const job = createJob(task.id, "free-node");

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([busyNode, freeNode]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      // Should pick free-node as it has more available resources
      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, "free-node", 1, 512);
    });

    it("should update node capacity tracking during tick", async () => {
      // Single node with capacity for two jobs
      const node = createNode({
        capacity: { cores: 8, ramMb: 8192, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 0, ramMb: 0 },
        activeJobs: 0,
      });
      const task1 = createTask({ id: "task-1", requirements: { minCores: 4, minRamMb: 4096 } });
      const task2 = createTask({ id: "task-2", requirements: { minCores: 4, minRamMb: 4096 } });
      const job1 = createJob(task1.id, node.id);
      const job2 = createJob(task2.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task1, task2]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob
        .mockReturnValueOnce(job1)
        .mockReturnValueOnce(job2);

      await scheduler.tick();

      // Both tasks should be assigned since capacity is tracked during tick
      expect(mockStore.createJob).toHaveBeenCalledTimes(2);
    });
  });

  describe("findBestNode() - requirements filtering", () => {
    it("should respect nodeId pin requirement", async () => {
      const node1 = createNode({ id: "node-1" });
      const node2 = createNode({ id: "node-2" });
      const task = createTask({ requirements: { nodeId: "node-2" } });
      const job = createJob(task.id, "node-2");

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node1, node2]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, "node-2", 1, 512);
    });

    it("should not assign when pinned nodeId is not available", async () => {
      const node1 = createNode({ id: "node-1" });
      const task = createTask({ requirements: { nodeId: "node-999" } });

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node1]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should respect GPU requirement", async () => {
      const noGpuNode = createNode({
        id: "no-gpu",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
      });
      const gpuNode = createNode({
        id: "gpu-node",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 2, containerRuntime: "docker" },
      });
      const task = createTask({ requirements: { gpu: true } });
      const job = createJob(task.id, "gpu-node");

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([noGpuNode, gpuNode]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, "gpu-node", 1, 512);
    });

    it("should not assign GPU task to node without GPU", async () => {
      const noGpuNode = createNode({
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
      });
      const task = createTask({ requirements: { gpu: true } });

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([noGpuNode]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should respect containerRuntime requirement", async () => {
      const dockerNode = createNode({
        id: "docker-node",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
      });
      const podmanNode = createNode({
        id: "podman-node",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "podman" },
      });
      const task = createTask({ requirements: { containerRuntime: "podman" } });
      const job = createJob(task.id, "podman-node");

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([dockerNode, podmanNode]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalledWith(task.id, "podman-node", 1, 512);
    });

    it("should allow any containerRuntime when requirement is 'any'", async () => {
      const dockerNode = createNode({
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
      });
      const task = createTask({ requirements: { containerRuntime: "any" } });
      const job = createJob(task.id, dockerNode.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([dockerNode]);
      mockStore.createJob.mockReturnValue(job);

      await scheduler.tick();

      expect(mockStore.createJob).toHaveBeenCalled();
    });
  });

  describe("offline node handling", () => {
    it("should not consider offline nodes even if returned by listAvailableNodes", async () => {
      const offlineNode = createNode({ status: "offline" });
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([offlineNode]);
      mockNodeManager.isNodeConnected.mockReturnValue(false);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should skip task when assigned node goes offline mid-assignment", async () => {
      const node = createNode();
      const task = createTask();
      const job = createJob(task.id, node.id);

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);
      mockStore.createJob.mockReturnValue(job);
      // Node disconnects before assignment can complete
      mockNodeManager.assignJob.mockReturnValue(false);

      await scheduler.tick();

      // Job should be reverted
      expect(mockStore.updateJobStatus).toHaveBeenCalledWith(job.id, "failed", {
        error: "Failed to send to node",
      });
    });
  });

  describe("overloaded node handling", () => {
    it("should not assign to node at capacity limit", async () => {
      const overloadedNode = createNode({
        capacity: { cores: 4, ramMb: 4096, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 4, ramMb: 4096 },
      });
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([overloadedNode]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should not assign to node with too many active jobs", async () => {
      const overloadedNode = createNode({
        activeJobs: 8, // Default maxAgentsPerNode is 8
      });
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([overloadedNode]);

      await scheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it("should respect custom maxAgentsPerNode config", async () => {
      const customScheduler = new Scheduler({ maxAgentsPerNode: 2 });
      const node = createNode({ activeJobs: 2 });
      const task = createTask();

      mockStore.getQueuedTasks.mockReturnValue([task]);
      mockStore.listAvailableNodes.mockReturnValue([node]);

      await customScheduler.tick();

      expect(mockStore.createJob).not.toHaveBeenCalled();

      customScheduler.stop();
    });
  });

  describe("getState()", () => {
    it("should return current scheduler state", () => {
      const node1 = createNode({
        id: "node-1",
        capacity: { cores: 8, ramMb: 16384, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 2, ramMb: 4096 },
      });
      const node2 = createNode({
        id: "node-2",
        status: "offline",
        capacity: { cores: 4, ramMb: 8192, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 0, ramMb: 0 },
      });

      mockStore.listNodes.mockReturnValue([node1, node2]);
      mockStore.countTasks.mockReturnValue(5);
      mockStore.countJobs.mockReturnValue(2);
      mockStore.countRunningAgents.mockReturnValue(3);

      const state = scheduler.getState();

      expect(state.running).toBe(false);
      expect(state.nodesOnline).toBe(1);
      expect(state.nodesTotal).toBe(2);
      expect(state.totalCapacity.cores).toBe(8);
      expect(state.totalCapacity.ramMb).toBe(16384);
      expect(state.usedCapacity.cores).toBe(2);
      expect(state.usedCapacity.ramMb).toBe(4096);
    });

    it("should compute maxAgents from capacity", () => {
      const node = createNode({
        capacity: { cores: 16, ramMb: 32768, diskGb: 100, gpuCount: 0, containerRuntime: "docker" },
        usedCapacity: { cores: 0, ramMb: 0 },
      });

      mockStore.listNodes.mockReturnValue([node]);
      mockStore.countTasks.mockReturnValue(0);
      mockStore.countJobs.mockReturnValue(0);
      mockStore.countRunningAgents.mockReturnValue(0);

      const state = scheduler.getState();

      // maxAgents = min(16/1, 32768/512, 1*8) = min(16, 64, 8) = 8
      expect(state.maxAgents).toBe(8);
    });
  });

  describe("start() and stop()", () => {
    it("should update running state", () => {
      expect(scheduler.getState().running).toBe(false);

      scheduler.start();
      expect(scheduler.getState().running).toBe(true);

      scheduler.stop();
      expect(scheduler.getState().running).toBe(false);
    });

    it("should not start twice", () => {
      scheduler.start();
      scheduler.start(); // Should be a no-op

      expect(scheduler.getState().running).toBe(true);
      scheduler.stop();
    });

    it("should not stop when not running", () => {
      scheduler.stop(); // Should be a no-op
      expect(scheduler.getState().running).toBe(false);
    });
  });

  describe("getConfig() and updateConfig()", () => {
    it("should return current config", () => {
      const config = scheduler.getConfig();

      expect(config.tickIntervalMs).toBe(2000);
      expect(config.nodeTimeoutMs).toBe(30000);
      expect(config.defaultTaskCores).toBe(1);
      expect(config.defaultTaskRamMb).toBe(512);
      expect(config.maxAgentsPerNode).toBe(8);
    });

    it("should update config", () => {
      scheduler.updateConfig({ tickIntervalMs: 5000, maxAgentsPerNode: 4 });

      const config = scheduler.getConfig();
      expect(config.tickIntervalMs).toBe(5000);
      expect(config.maxAgentsPerNode).toBe(4);
      // Others unchanged
      expect(config.nodeTimeoutMs).toBe(30000);
    });

    it("should use custom config on construction", () => {
      const customScheduler = new Scheduler({
        tickIntervalMs: 1000,
        maxAgentsPerNode: 16,
      });

      const config = customScheduler.getConfig();
      expect(config.tickIntervalMs).toBe(1000);
      expect(config.maxAgentsPerNode).toBe(16);

      customScheduler.stop();
    });
  });

  describe("singleton functions", () => {
    it("getScheduler() should return singleton", () => {
      stopScheduler(); // Clear any existing

      const s1 = getScheduler();
      const s2 = getScheduler();

      expect(s1).toBe(s2);

      stopScheduler();
    });

    it("stopScheduler() should clear singleton", () => {
      const s1 = getScheduler();
      s1.start();

      stopScheduler();

      const s2 = getScheduler();
      expect(s2).not.toBe(s1);
      expect(s2.getState().running).toBe(false);

      stopScheduler();
    });
  });
});
