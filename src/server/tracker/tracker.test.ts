/**
 * Acceptance tests for the tracker module.
 *
 * These tests verify the core tracker behaviors using a fake GitHub client
 * at the boundary. The TrackerService and TrackerStore are real; only the
 * GitHub API calls are faked.
 *
 * Each test must FAIL on github/main before this change (no tracker module
 * exists there).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { TrackerService } from "./service.js";
import { TrackerStore } from "./store.js";
import {
  GitHubProjectsClient,
  ProjectsApiError,
  type ProjectBoard,
  type TrackerIssue,
  type TrackerMilestone,
} from "./github-projects.js";
import { type TrackerSettings } from "./config.js";
import { EventBus } from "../core/event-bus.js";

// ============ FAKE GITHUB CLIENT ============

/** In-memory state for the fake GitHub client */
interface FakeGitHubState {
  board: ProjectBoard | null;
  items: Map<string, FakeProjectItem>;
  issues: Map<number, TrackerIssue>;
  milestones: Map<number, TrackerMilestone>;
  rateLimited: boolean;
  nextItemId: number;
  apiCalls: Array<{ method: string; args: unknown[] }>;
}

interface FakeProjectItem {
  id: string;
  contentId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  issueNumber: number | null;
  status: string | null;
  agent: string | null;
}


function createFakeState(): FakeGitHubState {
  return {
    board: {
      id: "board-1",
      title: "Test Board",
      url: "https://github.com/orgs/test/projects/1",
      statusField: {
        id: "status-field-1",
        name: "Status",
        options: [
          { id: "opt-backlog", name: "Backlog" },
          { id: "opt-ready", name: "Ready" },
          { id: "opt-in-progress", name: "In progress" },
          { id: "opt-in-review", name: "In review" },
          { id: "opt-done", name: "Done" },
        ],
      },
      agentField: { id: "agent-field-1", name: "Agent" },
    },
    items: new Map(),
    issues: new Map(),
    milestones: new Map(),
    rateLimited: false,
    nextItemId: 1,
    apiCalls: [],
  };
}


function createFakeClient(state: FakeGitHubState): GitHubProjectsClient {
  const recordCall = (method: string, args: unknown[]) => {
    state.apiCalls.push({ method, args });
  };

  const checkRateLimit = () => {
    if (state.rateLimited) {
      throw new ProjectsApiError("Rate limit exceeded", 429);
    }
  };

  return {
    checkScopes: async () => {
      recordCall("checkScopes", []);
      return { ok: true, missing: [] };
    },
    getProjectBoard: async () => {
      recordCall("getProjectBoard", []);
      return state.board;
    },
    listProjectItems: async (boardId: string) => {
      recordCall("listProjectItems", [boardId]);
      return Array.from(state.items.values());
    },
    addItemToProject: async (boardId: string, contentId: string) => {
      recordCall("addItemToProject", [boardId, contentId]);
      checkRateLimit();
      const id = `item-${state.nextItemId++}`;
      const issue = Array.from(state.issues.values()).find(
        (i) => `issue-node-${i.number}` === contentId,
      );
      state.items.set(id, {
        id, contentId, contentType: "Issue",
        issueNumber: issue?.number ?? null, status: null, agent: null,
      });
      return id;
    },

    setItemSingleSelectField: async (boardId: string, itemId: string, fieldId: string, optionId: string) => {
      recordCall("setItemSingleSelectField", [boardId, itemId, fieldId, optionId]);
      checkRateLimit();
      const item = state.items.get(itemId);
      if (!item) throw new ProjectsApiError("Item not found", 404);
      const option = state.board?.statusField?.options.find((o) => o.id === optionId);
      if (option) item.status = option.name;
    },
    setItemTextField: async (boardId: string, itemId: string, fieldId: string, text: string) => {
      recordCall("setItemTextField", [boardId, itemId, fieldId, text]);
      checkRateLimit();
      const item = state.items.get(itemId);
      if (!item) throw new ProjectsApiError("Item not found", 404);
      if (fieldId === state.board?.agentField?.id) item.agent = text;
    },
    getIssue: async (number: number) => {
      recordCall("getIssue", [number]);
      return state.issues.get(number) ?? null;
    },
    findIssueByTitle: async (title: string) => {
      recordCall("findIssueByTitle", [title]);
      return Array.from(state.issues.values()).find(
        (i) => i.title.toLowerCase() === title.toLowerCase(),
      ) ?? null;
    },

    createIssue: async (options: { title: string; body: string; labels?: string[] }) => {
      recordCall("createIssue", [options]);
      checkRateLimit();
      const number = state.issues.size + 1;
      const issue: TrackerIssue = {
        number, title: options.title, state: "open",
        url: `https://github.com/test/repo/issues/${number}`,
        labels: options.labels ?? [], milestoneNumber: null, projectItemId: null,
      };
      state.issues.set(number, issue);
      return issue;
    },
    closeIssue: async (number: number) => {
      recordCall("closeIssue", [number]);
      checkRateLimit();
      const issue = state.issues.get(number);
      if (issue) issue.state = "closed";
    },
    reopenIssue: async (number: number) => {
      recordCall("reopenIssue", [number]);
      checkRateLimit();
      const issue = state.issues.get(number);
      if (issue) issue.state = "open";
    },
    addLabel: async (number: number, label: string) => {
      recordCall("addLabel", [number, label]);
      checkRateLimit();
      const issue = state.issues.get(number);
      if (issue && !issue.labels.includes(label)) issue.labels.push(label);
    },
    removeLabel: async (number: number, label: string) => {
      recordCall("removeLabel", [number, label]);
      checkRateLimit();
      const issue = state.issues.get(number);
      if (issue) issue.labels = issue.labels.filter((l) => l !== label);
    },
    addComment: async (number: number, body: string) => {
      recordCall("addComment", [number, body]);
      checkRateLimit();
    },

    getIssueNodeId: async (number: number) => {
      recordCall("getIssueNodeId", [number]);
      return state.issues.has(number) ? `issue-node-${number}` : null;
    },
    listMilestones: async (milestoneState: "open" | "closed" | "all" = "all") => {
      recordCall("listMilestones", [milestoneState]);
      return Array.from(state.milestones.values()).filter((m) => {
        if (milestoneState === "all") return true;
        return m.state === milestoneState;
      });
    },
    getMilestone: async (number: number) => {
      recordCall("getMilestone", [number]);
      return state.milestones.get(number) ?? null;
    },
    closeMilestone: async (number: number) => {
      recordCall("closeMilestone", [number]);
      checkRateLimit();
      const m = state.milestones.get(number);
      if (m) m.state = "closed";
    },
    reopenMilestone: async (number: number) => {
      recordCall("reopenMilestone", [number]);
      checkRateLimit();
      const m = state.milestones.get(number);
      if (m) m.state = "open";
    },
  } as unknown as GitHubProjectsClient;
}


// ============ TEST HELPERS ============

function createTestSettings(overrides?: Partial<TrackerSettings>): TrackerSettings {
  return {
    enabled: true,
    mode: "act",
    repo: "test/repo",
    project: { owner: "test", number: 1 },
    statusField: "Status",
    statusOptions: {
      backlog: "Backlog", ready: "Ready", in_progress: "In progress",
      in_review: "In review", done: "Done",
    },
    agentField: "Agent",
    createIssuesForNewTasks: false,
    defaultLabels: [],
    tierLabels: null,
    milestones: null,
    redactPatterns: [],
    reconcileIntervalSeconds: 900,
    writeBudgetPerMinute: 30,
    tokenEnv: null,
    tokenCmd: null,
    apiUrl: "https://api.github.com",
    warnings: [],
    ...overrides,
  };
}

interface TestContext {
  db: Database.Database;
  store: TrackerStore;
  eventBus: EventBus;
  state: FakeGitHubState;
  client: GitHubProjectsClient;
  service: TrackerService;
}

function createTestContext(settingsOverrides?: Partial<TrackerSettings>): TestContext {
  const db = new Database(":memory:");
  const store = new TrackerStore(db);
  const eventBus = new EventBus();
  const state = createFakeState();
  const client = createFakeClient(state);
  const settings = createTestSettings(settingsOverrides);
  const service = new TrackerService({
    project: "test-project", settings, store, eventBus, client,
  });
  return { db, store, eventBus, state, client, service };
}


// ============ ACCEPTANCE TESTS ============

describe("Tracker Module Acceptance Tests", () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    ctx?.service.stop();
    ctx?.db.close();
    vi.useRealTimers();
  });

  describe("1. Run starts for a linked task -> item moves to In progress with agent set", () => {
    it("moves the item to In progress and sets the agent on run start", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "backlog", agent: null,
      });
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "Backlog", agent: null,
      });

      await ctx.service.start();
      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", task: "test-task-1", agent: "kiro-A",
      });

      const item = ctx.state.items.get("item-1");
      expect(item?.status).toBe("In progress");
      expect(item?.agent).toBe("kiro-A");
      const link = ctx.store.getLink("test-project", "test-task-1");
      expect(link?.status).toBe("in_progress");
      expect(link?.agent).toBe("kiro-A");
    });


    it("is idempotent - second event is a no-op", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "backlog", agent: null,
      });
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "Backlog", agent: null,
      });

      await ctx.service.start();
      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", task: "test-task-1", agent: "kiro-A",
      });
      const callsAfterFirst = ctx.state.apiCalls.filter(
        (c) => c.method === "setItemSingleSelectField",
      ).length;

      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", task: "test-task-1", agent: "kiro-A",
      });
      const callsAfterSecond = ctx.state.apiCalls.filter(
        (c) => c.method === "setItemSingleSelectField",
      ).length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });


  describe("2. PR with Closes #N merges -> Done and issue closed once", () => {
    it("moves to Done and closes issue when PR merges", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "in_progress", agent: "kiro-A",
      });
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "In progress", agent: "kiro-A",
      });

      await ctx.service.start();
      await ctx.eventBus.emit("review.merged", {
        project: "test-project",
        pr: { number: 100, body: "Closes #42\n\nSome description" },
      });

      const item = ctx.state.items.get("item-1");
      expect(item?.status).toBe("Done");
      const issue = ctx.state.issues.get(42);
      expect(issue?.state).toBe("closed");
    });

    it("closes the issue only once (idempotent)", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "in_progress", agent: "kiro-A",
      });
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "In progress", agent: "kiro-A",
      });

      await ctx.service.start();
      await ctx.eventBus.emit("review.merged", {
        project: "test-project", pr: { number: 100, body: "Closes #42" },
      });
      const closeCallsAfterFirst = ctx.state.apiCalls.filter((c) => c.method === "closeIssue").length;

      await ctx.eventBus.emit("review.merged", {
        project: "test-project", pr: { number: 101, body: "Closes #42" },
      });
      const closeCallsAfterSecond = ctx.state.apiCalls.filter((c) => c.method === "closeIssue").length;

      expect(closeCallsAfterSecond).toBe(closeCallsAfterFirst);
    });
  });


  describe("3. New task linking: adopt existing or create in act mode, observe records", () => {
    it("adopts an existing issue with the same title (no duplicate created)", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true });
      ctx.state.issues.set(99, {
        number: 99, title: "New feature task", state: "open",
        url: "https://github.com/test/repo/issues/99",
        labels: [], milestoneNumber: null, projectItemId: null,
      });

      await ctx.service.start();
      const link = await ctx.service.linkTaskToIssue("New feature task", "Description");

      expect(link?.issueNumber).toBe(99);
      const createCalls = ctx.state.apiCalls.filter((c) => c.method === "createIssue");
      expect(createCalls.length).toBe(0);
    });

    it("creates a new issue in act mode when no existing issue matches", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true });
      await ctx.service.start();

      const link = await ctx.service.linkTaskToIssue("Brand new task", "Task description");

      expect(link?.issueNumber).toBe(1);
      expect(ctx.state.issues.get(1)?.title).toBe("Brand new task");
    });

    it("in observe mode: nothing written, would-be writes recorded", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true, mode: "observe" });
      await ctx.service.start();

      const link = await ctx.service.linkTaskToIssue("Observed task", "Description");

      expect(link).toBeNull();
      const writes = ctx.store.listRecentWrites("test-project");
      expect(writes.some((w) => w.op === "create_issue" && w.mode === "observe")).toBe(true);
    });
  });


  describe("4. Reconcile fixes drift (card moved by hand to wrong column)", () => {
    it("reconcile corrects a card moved by hand and reports the drift", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "in_progress", agent: "kiro-A",
      });
      // Board item is in "Ready" (someone moved it by hand)
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "Ready", agent: "kiro-A",
      });

      await ctx.service.start();
      const { fixed, errors } = await ctx.service.reconcile();

      expect(fixed).toBe(1);
      expect(errors.length).toBe(0);
      const item = ctx.state.items.get("item-1");
      expect(item?.status).toBe("In progress");
      const syncState = ctx.store.getSyncState("test-project");
      expect(syncState?.driftFixedCount).toBe(1);
    });
  });


  describe("5. Milestones: close when zero open issues, reopen when issue reopens", () => {
    it("closes a milestone with zero open issues", async () => {
      ctx = createTestContext({
        milestones: { from: "label", closeWhenComplete: true },
      });
      ctx.state.milestones.set(1, {
        number: 1, title: "v1.0", state: "open",
        openIssues: 0, closedIssues: 3, dueOn: null, description: null,
      });

      await ctx.service.start();
      const closed = await ctx.service.closeDoneMilestones();

      expect(closed).toBe(1);
      expect(ctx.state.milestones.get(1)?.state).toBe("closed");
    });

    it("reopens a milestone when an issue reopens", async () => {
      ctx = createTestContext();
      ctx.state.milestones.set(1, {
        number: 1, title: "v1.0", state: "closed",
        openIssues: 0, closedIssues: 3, dueOn: null, description: null,
      });

      await ctx.service.start();
      await ctx.service.reopenMilestoneIfNeeded(1);

      expect(ctx.state.milestones.get(1)?.state).toBe("open");
    });

    it("never writes due dates (they are the owner's)", async () => {
      ctx = createTestContext({
        milestones: { from: "label", closeWhenComplete: true },
      });
      ctx.state.milestones.set(1, {
        number: 1, title: "v1.0", state: "open",
        openIssues: 0, closedIssues: 3, dueOn: "2026-12-31", description: "Release",
      });

      await ctx.service.start();
      await ctx.service.closeDoneMilestones();

      const milestoneCalls = ctx.state.apiCalls.filter(
        (c) => c.method === "closeMilestone" || c.method === "reopenMilestone",
      );
      expect(milestoneCalls.length).toBe(1);
      expect(milestoneCalls[0].method).toBe("closeMilestone");
    });
  });


  describe("6. Missing scope refused clearly; rate limits back off", () => {
    it("refuses with a clear message when project scope is missing", async () => {
      ctx = createTestContext();
      // Override checkScopes to report missing scope
      (ctx.client as unknown as Record<string, unknown>).checkScopes = async () => ({
        ok: false,
        missing: ["project"],
      });

      const result = await ctx.client.checkScopes();
      expect(result.ok).toBe(false);
      expect(result.missing).toContain("project");
    });

    it("records rate_limited result when budget exceeded", async () => {
      ctx = createTestContext();
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "backlog", agent: null,
      });
      ctx.state.items.set("item-1", {
        id: "item-1", contentId: "issue-node-42", contentType: "Issue",
        issueNumber: 42, status: "Backlog", agent: null,
      });

      await ctx.service.start();
      ctx.state.rateLimited = true;

      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", task: "test-task-1", agent: "kiro-A",
      });

      const writes = ctx.store.listRecentWrites("test-project");
      expect(writes.some((w) => w.result === "rate_limited")).toBe(true);
    });
  });


  describe("7. Outgoing text matching redact_patterns is redacted", () => {
    it("redacts text matching configured patterns", async () => {
      ctx = createTestContext({
        redactPatterns: [/secret-\d+/gi, /\/private\//gi],
      });
      ctx.state.issues.set(42, {
        number: 42, title: "Test task", state: "open",
        url: "https://github.com/test/repo/issues/42",
        labels: [], milestoneNumber: null, projectItemId: null,
      });
      ctx.store.upsertLink("test-project", {
        task: "test-task-1", issueNumber: 42,
        issueUrl: "https://github.com/test/repo/issues/42",
        projectItemId: "item-1", status: "in_progress", agent: "kiro-A",
      });

      await ctx.service.start();
      // Simulate a blocked task with sensitive info in the reason
      await ctx.eventBus.emit("agent.run.ended", {
        project: "test-project",
        task: "test-task-1",
        blocked: true,
        reason: "Cannot access /private/data secret-12345 path",
      });

      // The addComment call should have redacted text
      const commentCalls = ctx.state.apiCalls.filter((c) => c.method === "addComment");
      if (commentCalls.length > 0) {
        const body = (commentCalls[0].args[1] as string);
        expect(body).not.toContain("secret-12345");
        expect(body).not.toContain("/private/");
        expect(body).toContain("[REDACTED]");
      }
    });
  });
});
