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
  comments: Map<number, string[]>;
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
    comments: new Map(),
  };
}


function createFakeClient(state: FakeGitHubState): GitHubProjectsClient {
  const recordCall = (method: string, args: unknown[]) => {
    state.apiCalls.push({ method, args });
  };

  const checkRateLimit = () => {
    if (state.rateLimited) {
      throw new ProjectsApiError("Rate limit exceeded", 429, "rate_limit");
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
        (i) => i.title.toLowerCase() === title.toLowerCase() && i.state === "open",
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
      const comments = state.comments.get(number) ?? [];
      comments.push(body);
      state.comments.set(number, comments);
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
    clearScopeError: () => { /* no-op */ },
    getRateLimitResetAt: () => 0,
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

  describe("1. Run starts for a linked task -> item moves to In progress", () => {
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
      // Real event payload: { project, kind, eventId, agent, task, runId, subject, summary }
      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", kind: "started", eventId: "evt-1",
        agent: "kiro-A", task: "test-task-1", runId: "run-1",
        subject: null, summary: "Starting task",
      });

      const item = ctx.state.items.get("item-1");
      expect(item?.status).toBe("In progress");
      expect(item?.agent).toBe("kiro-A");
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
        project: "test-project", kind: "started", eventId: "evt-1",
        agent: "kiro-A", task: "test-task-1", runId: "run-1",
        subject: null, summary: "Starting task",
      });
      const callsAfterFirst = ctx.state.apiCalls.filter(
        (c) => c.method === "setItemSingleSelectField",
      ).length;

      await ctx.eventBus.emit("agent.run.started", {
        project: "test-project", kind: "started", eventId: "evt-2",
        agent: "kiro-A", task: "test-task-1", runId: "run-1",
        subject: null, summary: "Starting again",
      });
      const callsAfterSecond = ctx.state.apiCalls.filter(
        (c) => c.method === "setItemSingleSelectField",
      ).length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });


  describe("2. Planner changed with op=done -> Done and issue closed", () => {
    it("moves to Done and closes issue when planner.changed op=done", async () => {
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
      // Real event payload: { op, task, source, outcome }
      await ctx.eventBus.emit("planner.changed", {
        op: "done", task: "test-task-1", source: "deterministic", outcome: "applied",
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
      await ctx.eventBus.emit("planner.changed", {
        op: "done", task: "test-task-1", source: "deterministic", outcome: "applied",
      });
      const closeCallsAfterFirst = ctx.state.apiCalls.filter((c) => c.method === "closeIssue").length;

      await ctx.eventBus.emit("planner.changed", {
        op: "done", task: "test-task-1", source: "deterministic", outcome: "applied",
      });
      const closeCallsAfterSecond = ctx.state.apiCalls.filter((c) => c.method === "closeIssue").length;

      expect(closeCallsAfterSecond).toBe(closeCallsAfterFirst);
    });
  });


  describe("3. New task linking: adopt existing or create in act mode", () => {
    it("adopts an existing issue with the same title", async () => {
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

    it("observe mode: nothing written, would-be writes recorded", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true, mode: "observe" });
      await ctx.service.start();

      const link = await ctx.service.linkTaskToIssue("Observed task", "Description");

      expect(link).toBeNull();
      const mutationCalls = ctx.state.apiCalls.filter((c) =>
        ["createIssue", "addItemToProject", "setItemSingleSelectField"].includes(c.method)
      );
      expect(mutationCalls.length).toBe(0);
      const writes = ctx.store.listRecentWrites("test-project");
      expect(writes.some((w) => w.op === "create_issue" && w.mode === "observe")).toBe(true);
    });

    it("observe mode: adopt path does not call addItemToProject (F2)", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true, mode: "observe" });
      ctx.state.issues.set(99, {
        number: 99, title: "Existing task", state: "open",
        url: "https://github.com/test/repo/issues/99",
        labels: [], milestoneNumber: null, projectItemId: null,
      });

      await ctx.service.start();
      await ctx.service.linkTaskToIssue("Existing task", "Description");

      const addItemCalls = ctx.state.apiCalls.filter((c) => c.method === "addItemToProject");
      expect(addItemCalls.length).toBe(0);
    });
  });


  describe("4. Reconcile fixes drift", () => {
    it("reconcile corrects a card moved by hand", async () => {
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
        issueNumber: 42, status: "Ready", agent: "kiro-A",
      });

      await ctx.service.start();
      const { fixed, errors } = await ctx.service.reconcile();

      expect(fixed).toBe(1);
      expect(errors.length).toBe(0);
      const item = ctx.state.items.get("item-1");
      expect(item?.status).toBe("In progress");
    });

    it("does not count drift as fixed when write fails (F14)", async () => {
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
        issueNumber: 42, status: "Ready", agent: "kiro-A",
      });

      await ctx.service.start();
      ctx.state.rateLimited = true;
      const { fixed, errors } = await ctx.service.reconcile();

      expect(fixed).toBe(0);
      expect(errors.length).toBe(1);
      const syncState = ctx.store.getSyncState("test-project");
      expect(syncState?.driftFixedCount).toBe(0);
    });
  });


  describe("5. Milestones: close when zero open issues", () => {
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
  });

  describe("6. Missing scope refused clearly; rate limits back off", () => {
    it("refuses with a clear message when scope is missing", async () => {
      ctx = createTestContext();
      (ctx.client as unknown as Record<string, unknown>).checkScopes = async () => ({
        ok: false,
        missing: ["project"],
      });

      await expect(ctx.service.start()).rejects.toThrow(/scope/i);
    });

    it("records rate_limited result when API returns 429", async () => {
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
        project: "test-project", kind: "started", eventId: "evt-1",
        agent: "kiro-A", task: "test-task-1", runId: "run-1",
        subject: null, summary: "Starting task",
      });

      const writes = ctx.store.listRecentWrites("test-project");
      expect(writes.some((w) => w.result === "rate_limited")).toBe(true);
    });
  });


  describe("7. Outgoing text is redacted (F4 default + configured patterns)", () => {
    it("redacts built-in patterns (GitHub tokens, paths) by default", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true });

      await ctx.service.start();
      await ctx.service.linkTaskToIssue(
        "Task with secrets",
        "Check /Users/dev/secret and use ghp_abcdef1234567890abcdef1234567890abcdef token",
      );

      const createCalls = ctx.state.apiCalls.filter((c) => c.method === "createIssue");
      expect(createCalls.length).toBe(1);
      const body = (createCalls[0].args[0] as { body: string }).body;
      expect(body).not.toContain("ghp_abcdef");
      expect(body).not.toContain("/Users/dev");
      expect(body).toContain("[REDACTED]");
    });

    it("redacts text matching configured patterns", async () => {
      ctx = createTestContext({
        createIssuesForNewTasks: true,
        redactPatterns: [/secret-\d+/gi],
      });

      await ctx.service.start();
      await ctx.service.linkTaskToIssue("Task name", "secret-12345 data");

      const createCalls = ctx.state.apiCalls.filter((c) => c.method === "createIssue");
      const body = (createCalls[0].args[0] as { body: string }).body;
      expect(body).not.toContain("secret-12345");
      expect(body).toContain("[REDACTED]");
    });

    it("redacts titles as well as bodies", async () => {
      ctx = createTestContext({ createIssuesForNewTasks: true });

      await ctx.service.start();
      await ctx.service.linkTaskToIssue("Fix /Users/dev/myproject/bug", "Description");

      const createCalls = ctx.state.apiCalls.filter((c) => c.method === "createIssue");
      const title = (createCalls[0].args[0] as { title: string }).title;
      expect(title).not.toContain("/Users/dev");
      expect(title).toContain("[REDACTED]");
    });
  });

  describe("8. Blocked comments are idempotent (F8)", () => {
    it("skips duplicate blocked comment for same reason", async () => {
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

      await ctx.service.start();
      const link = ctx.store.getLink("test-project", "test-task-1")!;
      // @ts-expect-error - accessing private method
      await ctx.service.addBlockedLabel(link, "Same reason");
      // @ts-expect-error - accessing private method
      await ctx.service.addBlockedLabel(link, "Same reason");

      const commentCalls = ctx.state.apiCalls.filter((c) => c.method === "addComment");
      expect(commentCalls.length).toBe(1);
    });

    it("adds new comment when reason changes", async () => {
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

      await ctx.service.start();
      const link = ctx.store.getLink("test-project", "test-task-1")!;
      // @ts-expect-error - accessing private method
      await ctx.service.addBlockedLabel(link, "First reason");
      // @ts-expect-error - accessing private method
      await ctx.service.addBlockedLabel(link, "Different reason");

      const commentCalls = ctx.state.apiCalls.filter((c) => c.method === "addComment");
      expect(commentCalls.length).toBe(2);
    });
  });
});
