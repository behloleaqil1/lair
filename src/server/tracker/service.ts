/**
 * TrackerService: keeps GitHub issues, Projects boards and milestones in sync
 * with Lair's tasks, runs and PRs.
 *
 * Events -> board updates (idempotent, bounded):
 * - task added -> Backlog (or Ready if fill can start it)
 * - run starts -> In progress + Agent field
 * - PR opened -> In review
 * - PR merged / task done -> Done + close issue
 * - blocked -> blocked label + comment
 *
 * Periodic reconcile fixes drift.
 */
import type { Event } from "../../shared/server-types.js";
import type { TrackerLink, TrackerOp, TrackerStatus, TrackerStatusView, TrackerWrite } from "../../shared/tracker-types.js";
import type { EventBus } from "../core/event-bus.js";
import { tokenFrom } from "../review/github.js";
import type { TrackerSettings, StatusMapping } from "./config.js";
import { statusToOption, optionToStatus } from "./config.js";
import { GitHubProjectsClient, ProjectsApiError, type ProjectBoard, type ProjectItem } from "./github-projects.js";
import type { TrackerStore } from "./store.js";

/** Max text length for comments sent to GitHub */
const MAX_COMMENT_LENGTH = 500;
/** Max writes per reconcile cycle */
const MAX_WRITES_PER_RECONCILE = 20;

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "api" | "scope" | "rate_limit",
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

export interface TrackerServiceOptions {
  project: string;
  settings: TrackerSettings;
  store: TrackerStore;
  eventBus: EventBus;
  /** Override for testing */
  client?: GitHubProjectsClient;
}

export class TrackerService {
  readonly project: string;
  private readonly settings: TrackerSettings;
  private readonly store: TrackerStore;
  private readonly eventBus: EventBus;
  private readonly client: GitHubProjectsClient;

  private board: ProjectBoard | null = null;
  private unsubscribes: (() => void)[] = [];
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private writeBudget = 0;
  private writeBudgetResetAt = 0;

  constructor(options: TrackerServiceOptions) {
    this.project = options.project;
    this.settings = options.settings;
    this.store = options.store;
    this.eventBus = options.eventBus;

    // Create the GitHub client
    const tokenSource = tokenFrom(
      options.settings.tokenEnv ?? "GITHUB_TOKEN",
      options.settings.tokenCmd,
    );
    this.client =
      options.client ??
      new GitHubProjectsClient({
        repo: options.settings.repo,
        project: options.settings.project,
        apiUrl: options.settings.apiUrl,
        token: tokenSource,
        statusFieldName: options.settings.statusField,
        agentFieldName: options.settings.agentField,
      });
  }

  /** Start listening to events and schedule reconciles */
  async start(): Promise<void> {
    if (!this.settings.enabled || this.settings.mode === "off") return;

    // Load the board
    this.board = await this.client.getProjectBoard();
    if (!this.board && this.settings.project) {
      throw new TrackerError(
        `Project board ${this.settings.project.owner}/${this.settings.project.number} not found`,
        "config",
      );
    }

    // Subscribe to events
    this.unsubscribes.push(
      this.eventBus.on("agent.run.started", (e) => this.onRunStarted(e)),
      this.eventBus.on("agent.run.ended", (e) => this.onRunEnded(e)),
      this.eventBus.on("review.merged", (e) => this.onPRMerged(e)),
      this.eventBus.on("planner.changed", (e) => this.onPlannerChanged(e)),
    );

    // Schedule first reconcile
    this.scheduleReconcile();
  }

  /** Stop listening and cancel timers */
  stop(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  // ============ Event handlers ============

  private async onRunStarted(event: Event): Promise<void> {
    const data = event.data as { project?: string; task?: string; agent?: string };
    if (data.project !== this.project || !data.task) return;

    const link = this.store.getLink(this.project, data.task);
    if (!link) return;

    await this.moveToStatus(link, "in_progress", data.agent ?? null);
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onRunEnded(event: Event): Promise<void> {
    const data = event.data as { project?: string; task?: string; done?: boolean; blocked?: boolean; reason?: string };
    if (data.project !== this.project || !data.task) return;

    const link = this.store.getLink(this.project, data.task);
    if (!link) return;

    if (data.done) {
      await this.moveToStatus(link, "done", null);
      await this.closeIssueIfNeeded(link);
    } else if (data.blocked) {
      await this.addBlockedLabel(link, data.reason ?? null);
    }
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onPRMerged(event: Event): Promise<void> {
    const data = event.data as { project?: string; pr?: { number: number; body?: string } };
    if (data.project !== this.project || !data.pr) return;

    // Find linked task from PR body (Closes #N)
    const body = data.pr.body ?? "";
    const match = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!match) return;

    const issueNumber = parseInt(match[1], 10);
    const link = this.store.getLinkByIssue(this.project, issueNumber);
    if (!link) return;

    await this.moveToStatus(link, "done", null);
    await this.closeIssueIfNeeded(link);
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onPlannerChanged(event: Event): Promise<void> {
    const data = event.data as { project?: string; added?: string[]; done?: string[] };
    if (data.project !== this.project) return;

    // Handle new tasks
    for (const task of data.added ?? []) {
      await this.linkTaskToIssue(task);
    }

    // Handle done tasks
    for (const task of data.done ?? []) {
      const link = this.store.getLink(this.project, task);
      if (link) {
        await this.moveToStatus(link, "done", null);
        await this.closeIssueIfNeeded(link);
      }
    }
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  // ============ Core operations ============

  /** Link a task to a GitHub issue (by extracting #N from the task, or creating one) */
  async linkTaskToIssue(task: string, description?: string): Promise<TrackerLink | null> {
    // Check if already linked
    const existing = this.store.getLink(this.project, task);
    if (existing) return existing;

    // Try to extract issue number from task description
    const issueMatch = description?.match(/#(\d+)|github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
    let issueNumber = issueMatch ? parseInt(issueMatch[1] ?? issueMatch[2], 10) : null;

    if (issueNumber) {
      // Verify the issue exists
      const issue = await this.client.getIssue(issueNumber);
      if (issue) {
        return this.createLink(task, issue.number, issue.url);
      }
      issueNumber = null;
    }

    // Try to find by exact title match (adopt existing)
    const byTitle = await this.client.findIssueByTitle(task);
    if (byTitle) {
      return this.createLink(task, byTitle.number, byTitle.url);
    }

    // Create a new issue if configured
    if (this.settings.createIssuesForNewTasks && this.settings.mode === "act") {
      const issue = await this.client.createIssue({
        title: task,
        body: this.redact(description ?? `Task: ${task}`),
        labels: this.settings.defaultLabels,
      });
      return this.createLink(task, issue.number, issue.url);
    }

    // Record what would be created in observe mode
    if (this.settings.createIssuesForNewTasks && this.settings.mode === "observe") {
      this.recordWrite({
        task,
        issueNumber: null,
        op: "create_issue",
        value: task,
        mode: "observe",
        wouldSend: JSON.stringify({ title: task, labels: this.settings.defaultLabels }),
        result: null,
        error: null,
      });
    }

    return null;
  }

  private async createLink(task: string, issueNumber: number, issueUrl: string): Promise<TrackerLink> {
    // Add to project board if configured
    let projectItemId: string | null = null;
    if (this.board) {
      const nodeId = await this.client.getIssueNodeId(issueNumber);
      if (nodeId) {
        try {
          projectItemId = await this.client.addItemToProject(this.board.id, nodeId);
        } catch (e) {
          if (!(e instanceof ProjectsApiError && e.status === 422)) throw e;
          // Already on board, find its item id
          const items = await this.client.listProjectItems(this.board.id);
          const item = items.find((i) => i.issueNumber === issueNumber);
          projectItemId = item?.id ?? null;
        }
      }
    }

    const link: TrackerLink = {
      task,
      issueNumber,
      issueUrl,
      projectItemId,
      status: "backlog",
      agent: null,
      linkedAt: new Date().toISOString(),
      syncedAt: null,
    };
    this.store.upsertLink(this.project, link);

    // Move to backlog on the board
    await this.moveToStatus(link, "backlog", null);

    return link;
  }

  /** Move an issue to a status on the Projects board */
  private async moveToStatus(link: TrackerLink, status: TrackerStatus, agent: string | null): Promise<void> {
    if (!this.board || !link.projectItemId) return;
    if (link.status === status && link.agent === agent) return; // Idempotent

    const statusField = this.board.statusField;
    if (!statusField) return;

    const optionName = statusToOption(status, this.settings.statusOptions);
    const option = statusField.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
    if (!option) return;

    if (this.settings.mode === "act") {
      if (!this.checkWriteBudget()) {
        this.recordWrite({
          task: link.task,
          issueNumber: link.issueNumber,
          op: statusOp(status),
          value: optionName,
          mode: "act",
          wouldSend: null,
          result: "rate_limited",
          error: "Write budget exceeded",
        });
        return;
      }

      try {
        await this.client.setItemSingleSelectField(this.board.id, link.projectItemId, statusField.id, option.id);
        this.recordWrite({
          task: link.task,
          issueNumber: link.issueNumber,
          op: statusOp(status),
          value: optionName,
          mode: "act",
          wouldSend: null,
          result: "success",
          error: null,
        });
      } catch (e) {
        this.handleApiError(e, link.task, statusOp(status));
        return;
      }

      // Set agent field if configured and provided
      if (agent && this.board.agentField) {
        try {
          await this.client.setItemTextField(this.board.id, link.projectItemId, this.board.agentField.id, agent);
          this.recordWrite({
            task: link.task,
            issueNumber: link.issueNumber,
            op: "set_agent",
            value: agent,
            mode: "act",
            wouldSend: null,
            result: "success",
            error: null,
          });
        } catch (e) {
          this.handleApiError(e, link.task, "set_agent");
        }
      }
    } else {
      // Observe mode: record what would be done
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: statusOp(status),
        value: optionName,
        mode: "observe",
        wouldSend: JSON.stringify({ status: optionName, agent }),
        result: null,
        error: null,
      });
    }

    this.store.updateLinkStatus(this.project, link.task, status, agent);
    link.status = status;
    link.agent = agent;
  }

  /** Close an issue when its task is done */
  private async closeIssueIfNeeded(link: TrackerLink): Promise<void> {
    if (this.settings.mode !== "act") {
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "close_issue",
        value: null,
        mode: "observe",
        wouldSend: JSON.stringify({ state: "closed" }),
        result: null,
        error: null,
      });
      return;
    }

    if (!this.checkWriteBudget()) return;

    try {
      // Check if already closed
      const issue = await this.client.getIssue(link.issueNumber);
      if (issue?.state === "closed") return;

      await this.client.closeIssue(link.issueNumber);
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "close_issue",
        value: null,
        mode: "act",
        wouldSend: null,
        result: "success",
        error: null,
      });
    } catch (e) {
      this.handleApiError(e, link.task, "close_issue");
    }
  }

  /** Add a blocked label and comment */
  private async addBlockedLabel(link: TrackerLink, reason: string | null): Promise<void> {
    const label = "blocked";

    if (this.settings.mode !== "act") {
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "add_label",
        value: label,
        mode: "observe",
        wouldSend: JSON.stringify({ label, comment: this.redact(reason ?? "Blocked") }),
        result: null,
        error: null,
      });
      return;
    }

    if (!this.checkWriteBudget()) return;

    try {
      await this.client.addLabel(link.issueNumber, label);
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "add_label",
        value: label,
        mode: "act",
        wouldSend: null,
        result: "success",
        error: null,
      });

      if (reason && this.checkWriteBudget()) {
        const comment = this.redact(reason);
        await this.client.addComment(link.issueNumber, `Blocked: ${comment}`);
        this.recordWrite({
          task: link.task,
          issueNumber: link.issueNumber,
          op: "add_comment",
          value: comment.slice(0, 100),
          mode: "act",
          wouldSend: null,
          result: "success",
          error: null,
        });
      }
    } catch (e) {
      this.handleApiError(e, link.task, "add_label");
    }
  }

  // ============ Reconciliation ============

  private scheduleReconcile(): void {
    const interval = this.settings.reconcileIntervalSeconds * 1000;
    const nextAt = new Date(Date.now() + interval).toISOString();
    this.store.upsertSyncState(this.project, { nextReconcileAt: nextAt });

    this.reconcileTimer = setTimeout(() => {
      this.reconcile().catch((e) => {
        this.store.incrementErrorCount(this.project, e instanceof Error ? e.message : String(e));
      });
      this.scheduleReconcile();
    }, interval);
  }

  /** Full reconcile: ensure board matches expected state */
  async reconcile(): Promise<{ fixed: number; errors: string[] }> {
    const now = new Date().toISOString();
    const errors: string[] = [];
    let fixed = 0;

    if (!this.board) {
      this.store.upsertSyncState(this.project, { lastReconcileAt: now });
      return { fixed, errors };
    }

    // Get all items on the board
    const items = await this.client.listProjectItems(this.board.id);
    const itemByIssue = new Map<number, ProjectItem>();
    for (const item of items) {
      if (item.issueNumber !== null) {
        itemByIssue.set(item.issueNumber, item);
      }
    }

    // Check each linked task
    const links = this.store.listLinks(this.project);
    let writes = 0;

    for (const link of links) {
      if (writes >= MAX_WRITES_PER_RECONCILE) break;

      const item = itemByIssue.get(link.issueNumber);
      if (!item) {
        // Issue not on board, add it
        if (link.projectItemId) {
          // We thought it was on the board
          this.store.updateLinkProjectItem(this.project, link.task, null);
        }
        continue;
      }

      // Update project item id if we didn't have it
      if (!link.projectItemId) {
        this.store.updateLinkProjectItem(this.project, link.task, item.id);
        link.projectItemId = item.id;
      }

      // Check status drift
      const expectedStatus = link.status;
      const actualStatus = item.status ? optionToStatus(item.status, this.settings.statusOptions) : null;

      if (expectedStatus && actualStatus !== expectedStatus) {
        // Status drifted, fix it
        try {
          await this.moveToStatus({ ...link, status: actualStatus }, expectedStatus, link.agent);
          fixed++;
          writes++;
          this.store.incrementDriftFixed(this.project);
        } catch (e) {
          errors.push(`Failed to fix drift for ${link.task}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    this.store.upsertSyncState(this.project, { lastReconcileAt: now });
    if (errors.length === 0) {
      this.store.clearErrors(this.project);
    }

    return { fixed, errors };
  }

  // ============ Milestones ============

  /** Close milestones with no open issues */
  async closeDoneMilestones(): Promise<number> {
    if (!this.settings.milestones?.closeWhenComplete) return 0;
    if (this.settings.mode !== "act") return 0;

    const milestones = await this.client.listMilestones("open");
    let closed = 0;

    for (const m of milestones) {
      if (m.openIssues === 0 && m.closedIssues > 0) {
        if (!this.checkWriteBudget()) break;
        try {
          await this.client.closeMilestone(m.number);
          this.recordWrite({
            task: null,
            issueNumber: null,
            op: "close_milestone",
            value: m.title,
            mode: "act",
            wouldSend: null,
            result: "success",
            error: null,
          });
          closed++;
        } catch (e) {
          this.handleApiError(e, null, "close_milestone");
        }
      }
    }

    return closed;
  }

  /** Reopen a milestone if an issue reopens */
  async reopenMilestoneIfNeeded(milestoneNumber: number): Promise<void> {
    if (this.settings.mode !== "act") return;

    const milestone = await this.client.getMilestone(milestoneNumber);
    if (milestone?.state === "closed") {
      if (!this.checkWriteBudget()) return;
      await this.client.reopenMilestone(milestoneNumber);
    }
  }

  // ============ Helpers ============

  /** Redact sensitive patterns from text */
  private redact(text: string): string {
    let result = text;
    for (const pattern of this.settings.redactPatterns) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result.slice(0, MAX_COMMENT_LENGTH);
  }

  /** Check and decrement write budget */
  private checkWriteBudget(): boolean {
    const now = Date.now();
    if (now >= this.writeBudgetResetAt) {
      this.writeBudget = this.settings.writeBudgetPerMinute;
      this.writeBudgetResetAt = now + 60_000;
    }
    if (this.writeBudget <= 0) return false;
    this.writeBudget--;
    return true;
  }

  private recordWrite(write: Omit<TrackerWrite, "id" | "at">): void {
    this.store.recordWrite(this.project, write);
  }

  private handleApiError(e: unknown, task: string | null, op: TrackerOp): void {
    const isRateLimit = e instanceof ProjectsApiError && (e.status === 403 || e.status === 429);
    const error = e instanceof Error ? e.message : String(e);

    this.recordWrite({
      task,
      issueNumber: null,
      op,
      value: null,
      mode: "act",
      wouldSend: null,
      result: isRateLimit ? "rate_limited" : "error",
      error: error.slice(0, 200),
    });

    this.store.incrementErrorCount(this.project, error);

    if (isRateLimit) {
      // Back off for a minute
      this.writeBudget = 0;
      this.writeBudgetResetAt = Date.now() + 60_000;
    }
  }

  // ============ Status view ============

  getStatus(): TrackerStatusView {
    const syncState = this.store.getSyncState(this.project);
    const links = this.store.listLinks(this.project);
    const writes = this.store.listRecentWrites(this.project, 20);

    return {
      enabled: this.settings.enabled,
      mode: this.settings.mode,
      repo: this.settings.repo || null,
      projectNumber: this.settings.project?.number ?? null,
      projectUrl: this.board?.url ?? null,
      syncState,
      links,
      recentWrites: writes,
      warnings: this.settings.warnings,
      errors: [],
    };
  }
}

function statusOp(status: TrackerStatus): TrackerOp {
  switch (status) {
    case "backlog":
      return "move_to_backlog";
    case "ready":
      return "move_to_ready";
    case "in_progress":
      return "move_to_in_progress";
    case "in_review":
      return "move_to_in_review";
    case "done":
      return "move_to_done";
  }
}
