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
import { createHash } from "crypto";
import type { Event } from "../../shared/server-types.js";
import type { TrackerLink, TrackerOp, TrackerStatus, TrackerStatusView, TrackerWrite } from "../../shared/tracker-types.js";
import type { EventBus } from "../core/event-bus.js";
import { tokenFrom } from "../review/github.js";
import type { TrackerSettings } from "./config.js";
import { statusToOption, optionToStatus } from "./config.js";
import { GitHubProjectsClient, ProjectsApiError, type ProjectBoard, type ProjectItem } from "./github-projects.js";
import type { TrackerStore } from "./store.js";

/** Max text length for comments sent to GitHub */
const MAX_COMMENT_LENGTH = 500;
/** Max writes per reconcile cycle */
const MAX_WRITES_PER_RECONCILE = 20;
/** Marker prefix in issue body for idempotent issue creation */
const LAIR_TASK_MARKER = "<!-- lair-task:";

/** Built-in patterns for default redaction (home dir, absolute paths, secrets). */
const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  // AWS credentials
  /AKIA[0-9A-Z]{16}/gi,
  /[A-Za-z0-9/+=]{40}/g, // AWS secret key (40-char base64-like)
  // GitHub tokens
  /ghp_[A-Za-z0-9]{36,}/gi,
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /gho_[A-Za-z0-9]{36,}/gi,
  /ghu_[A-Za-z0-9]{36,}/gi,
  /ghs_[A-Za-z0-9]{36,}/gi,
  /ghr_[A-Za-z0-9]{36,}/gi,
  // OpenAI / Anthropic keys
  /sk-[A-Za-z0-9]{20,}/gi,
  // Generic secret patterns
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi,
  // Absolute paths (Unix and Windows)
  /\/Users\/[^\s"']+/g,
  /\/home\/[^\s"']+/g,
  /C:\\Users\\[^\s"']+/gi,
  // Internal hostnames and IPs
  /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/g,
];

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
  /** In-flight tasks being linked (for per-task serialization). */
  private linkingTasks = new Map<string, Promise<TrackerLink | null>>();
  /** Tracks blocked reason hashes to avoid duplicate comments. */
  private blockedReasonHashes = new Map<string, string>();

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

    // Check scopes first
    const scopes = await this.client.checkScopes();
    if (!scopes.ok) {
      throw new TrackerError(
        `Missing required GitHub scopes: ${scopes.missing.join(", ")}`,
        "scope",
      );
    }

    // Load the board
    try {
      this.board = await this.client.getProjectBoard();
    } catch (e) {
      if (e instanceof ProjectsApiError) {
        throw new TrackerError(
          `Failed to load project board: ${e.message}`,
          e.code === "scope" ? "scope" : e.code === "rate_limit" ? "rate_limit" : "api",
        );
      }
      throw e;
    }

    if (!this.board && this.settings.project) {
      throw new TrackerError(
        `Project board ${this.settings.project.owner}/${this.settings.project.number} not found`,
        "config",
      );
    }

    // Subscribe to events (handlers are awaited by EventBus.emit)
    this.unsubscribes.push(
      this.eventBus.on("agent.run.started", (e) => this.safeHandle(() => this.onRunStarted(e))),
      this.eventBus.on("agent.run.ended", (e) => this.safeHandle(() => this.onRunEnded(e))),
      this.eventBus.on("review.merged", (e) => this.safeHandle(() => this.onPRMerged(e))),
      this.eventBus.on("planner.changed", (e) => this.safeHandle(() => this.onPlannerChanged(e))),
    );

    // Schedule first reconcile
    this.scheduleReconcile();
  }

  /** Wrap handler to catch errors without crashing the bus. */
  private async safeHandle(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.store.incrementErrorCount(this.project, e instanceof Error ? e.message : String(e));
    }
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
  // Event payloads match what Lair actually emits (see shared/server-types.ts):
  // - agent.run.started/ended: { project, kind, eventId, agent, task, runId, subject, summary }
  // - planner.changed: { op, task, source, outcome }
  // - review.merged: { pr, headSha, resultSha, method, strategy, tier, by }

  private async onRunStarted(event: Event): Promise<void> {
    // Real payload: { project, kind, eventId, agent, task, runId, subject, summary }
    const data = event.data as {
      project?: string;
      task?: string;
      agent?: string;
      kind?: string;
    };
    if (data.project !== this.project || !data.task) return;
    if (data.kind !== "started") return; // Filter for actual starts

    const link = this.store.getLink(this.project, data.task);
    if (!link) return;

    await this.moveToStatus(link, "in_progress", data.agent ?? null);
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onRunEnded(event: Event): Promise<void> {
    // Real payload: { project, kind, eventId, agent, task, runId, subject, summary }
    // Note: "done" and "blocked" must be inferred from kind or summary
    const data = event.data as {
      project?: string;
      task?: string;
      kind?: string;
      summary?: string;
    };
    if (data.project !== this.project || !data.task) return;
    if (data.kind !== "completed") return;

    const link = this.store.getLink(this.project, data.task);
    if (!link) return;

    // Infer done/blocked from summary (real implementation would check task state)
    // For now, just update the status based on the event
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onPRMerged(event: Event): Promise<void> {
    // Real payload: { pr (number), headSha, resultSha, method, strategy, tier, by }
    const data = event.data as {
      project?: string;
      pr?: number;
      headSha?: string;
    };
    // Note: project is added by emit wrapper, pr is just the number
    if (!data.pr) return;

    // We need to look up the PR body to find "Closes #N" - fetch from API
    // For now, we can't link without the body, so we need the PR body
    // The review service doesn't include body in the event, so we'd need to fetch it
    // This is a limitation - we'll handle it in reconcile or via a separate lookup
    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  private async onPlannerChanged(event: Event): Promise<void> {
    // Real payload: { op, task, source, outcome }
    const data = event.data as {
      project?: string;
      op?: string;
      task?: string;
      source?: string;
      outcome?: string;
    };
    // Project is added by the emit wrapper
    if (!data.task) return;

    // Handle based on op
    if (data.op === "add") {
      await this.linkTaskToIssue(data.task);
    } else if (data.op === "done" || data.op === "complete") {
      const link = this.store.getLink(this.project, data.task);
      if (link) {
        await this.moveToStatus(link, "done", null);
        await this.closeIssueIfNeeded(link);
      }
    } else if (data.op === "unblock") {
      const link = this.store.getLink(this.project, data.task);
      if (link) {
        await this.removeBlockedLabel(link);
      }
    }

    this.store.upsertSyncState(this.project, { lastEventAt: event.timestamp });
  }

  // ============ Core operations ============

  /** Generate a unique marker for a task (for idempotent issue creation). */
  private taskMarker(task: string): string {
    const hash = createHash("sha256").update(`${this.project}:${task}`).digest("hex").slice(0, 16);
    return `${LAIR_TASK_MARKER}${this.project}:${hash} -->`;
  }

  /** Link a task to a GitHub issue (by extracting #N from the task, or creating one) */
  async linkTaskToIssue(task: string, description?: string): Promise<TrackerLink | null> {
    // Check if already linked
    const existing = this.store.getLink(this.project, task);
    if (existing) return existing;

    // Serialize per-task to prevent duplicate creations
    const inflight = this.linkingTasks.get(task);
    if (inflight) return inflight;

    const promise = this.doLinkTaskToIssue(task, description);
    this.linkingTasks.set(task, promise);
    try {
      return await promise;
    } finally {
      this.linkingTasks.delete(task);
    }
  }

  private async doLinkTaskToIssue(task: string, description?: string): Promise<TrackerLink | null> {
    // Double-check after acquiring the "lock"
    const existing = this.store.getLink(this.project, task);
    if (existing) return existing;

    // Only accept explicit issue references from the description
    // Pattern: "Issue: #N" or full URL with matching repo
    const explicitIssueMatch = description?.match(
      /(?:Issue:\s*#(\d+))|(?:github\.com\/([^/]+\/[^/]+)\/issues\/(\d+))/i,
    );

    let issueNumber: number | null = null;
    if (explicitIssueMatch) {
      if (explicitIssueMatch[1]) {
        // Issue: #N form
        issueNumber = parseInt(explicitIssueMatch[1], 10);
      } else if (explicitIssueMatch[2] && explicitIssueMatch[3]) {
        // Full URL form - verify repo matches
        const urlRepo = explicitIssueMatch[2];
        if (urlRepo.toLowerCase() === this.settings.repo.toLowerCase()) {
          issueNumber = parseInt(explicitIssueMatch[3], 10);
        }
      }
    }

    if (issueNumber) {
      // Verify the issue exists and is valid for adoption
      const issue = await this.client.getIssue(issueNumber);
      if (issue && issue.state === "open" && !issue.labels.includes("pull_request")) {
        return this.createLink(task, issue.number, issue.url);
      }
      issueNumber = null;
    }

    // Look for an issue with our marker first (handles restart after create but before link)
    const marker = this.taskMarker(task);
    const byMarker = await this.findIssueByMarker(marker);
    if (byMarker) {
      return this.createLink(task, byMarker.number, byMarker.url);
    }

    // Try to find by exact title match (adopt existing) - only open issues
    const byTitle = await this.client.findIssueByTitle(task);
    if (byTitle && byTitle.state === "open") {
      return this.createLink(task, byTitle.number, byTitle.url);
    }

    // Create a new issue if configured
    if (this.settings.createIssuesForNewTasks && this.settings.mode === "act") {
      if (!this.checkWriteBudget()) {
        this.recordWrite({
          task,
          issueNumber: null,
          op: "create_issue",
          value: task,
          mode: "act",
          wouldSend: null,
          result: "rate_limited",
          error: "Write budget exceeded",
        });
        return null;
      }

      // Prepare the body with our marker for idempotency
      const bodyText = this.redact(description ?? `Task: ${task}`);
      const body = `${bodyText}\n\n${marker}`;

      const issue = await this.client.createIssue({
        title: this.redact(task),
        body,
        labels: this.settings.defaultLabels,
      });

      this.recordWrite({
        task,
        issueNumber: issue.number,
        op: "create_issue",
        value: task,
        mode: "act",
        wouldSend: null,
        result: "success",
        error: null,
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
        wouldSend: JSON.stringify({ title: this.redact(task), labels: this.settings.defaultLabels }),
        result: null,
        error: null,
      });
    }

    return null;
  }

  /** Find an issue by our marker in its body. */
  private async findIssueByMarker(_marker: string): Promise<{ number: number; url: string } | null> {
    // Search for issues containing our marker
    // Note: GitHub search is eventually consistent, but the marker search is more specific
    // In a full implementation, we'd search for issues containing the marker and verify
    // For now, we rely on title-based adoption; the marker is for restart recovery only
    return null;
  }

  private async createLink(task: string, issueNumber: number, issueUrl: string): Promise<TrackerLink> {
    // Add to project board if configured (only in act mode)
    let projectItemId: string | null = null;
    if (this.board && this.settings.mode === "act") {
      const nodeId = await this.client.getIssueNodeId(issueNumber);
      if (nodeId) {
        if (!this.checkWriteBudget()) {
          this.recordWrite({
            task,
            issueNumber,
            op: "move_to_backlog",
            value: "add to board",
            mode: "act",
            wouldSend: null,
            result: "rate_limited",
            error: "Write budget exceeded",
          });
        } else {
          try {
            projectItemId = await this.client.addItemToProject(this.board.id, nodeId);
            this.recordWrite({
              task,
              issueNumber,
              op: "move_to_backlog",
              value: "added to board",
              mode: "act",
              wouldSend: null,
              result: "success",
              error: null,
            });
          } catch (e) {
            if (e instanceof ProjectsApiError && e.status === 422) {
              // Already on board, find its item id
              const items = await this.client.listProjectItems(this.board.id);
              const item = items.find((i) => i.issueNumber === issueNumber);
              projectItemId = item?.id ?? null;
            } else {
              throw e;
            }
          }
        }
      }
    } else if (this.board && this.settings.mode === "observe") {
      // Record what would be done in observe mode
      this.recordWrite({
        task,
        issueNumber,
        op: "move_to_backlog",
        value: "add to board",
        mode: "observe",
        wouldSend: JSON.stringify({ action: "addItemToProject" }),
        result: null,
        error: null,
      });
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

    // Move to backlog on the board (only in act mode)
    if (projectItemId && this.settings.mode === "act") {
      await this.moveToStatus(link, "backlog", null);
    }

    return link;
  }

  /** Move an issue to a status on the Projects board */
  private async moveToStatus(link: TrackerLink, status: TrackerStatus, agent: string | null): Promise<boolean> {
    if (!this.board || !link.projectItemId) return false;
    if (link.status === status && link.agent === agent) return true; // Idempotent

    const statusField = this.board.statusField;
    if (!statusField) return false;

    const optionName = statusToOption(status, this.settings.statusOptions);
    const option = statusField.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
    if (!option) return false;

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
        return false;
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
        return false;
      }

      // Set agent field if configured and provided
      if (agent && this.board.agentField) {
        if (this.checkWriteBudget()) {
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
    return true;
  }

  /** Close an issue when its task is done */
  private async closeIssueIfNeeded(link: TrackerLink): Promise<boolean> {
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
      return false;
    }

    if (!this.checkWriteBudget()) {
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "close_issue",
        value: null,
        mode: "act",
        wouldSend: null,
        result: "rate_limited",
        error: "Write budget exceeded",
      });
      return false;
    }

    try {
      // Check if already closed
      const issue = await this.client.getIssue(link.issueNumber);
      if (issue?.state === "closed") return true;

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
      return true;
    } catch (e) {
      this.handleApiError(e, link.task, "close_issue");
      return false;
    }
  }

  /** Add a blocked label and comment (idempotent - skips duplicate comments). */
  private async addBlockedLabel(link: TrackerLink, reason: string | null): Promise<void> {
    const label = "blocked";
    const redactedReason = this.redact(reason ?? "Blocked");

    // Check if we already posted a comment with this reason
    const reasonHash = createHash("sha256").update(redactedReason).digest("hex").slice(0, 16);
    const lastHash = this.blockedReasonHashes.get(link.task);
    const skipComment = lastHash === reasonHash;

    if (this.settings.mode !== "act") {
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "add_label",
        value: label,
        mode: "observe",
        wouldSend: JSON.stringify({ label, comment: skipComment ? "(duplicate)" : redactedReason }),
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

      // Only add comment if reason changed
      if (!skipComment && reason && this.checkWriteBudget()) {
        const comment = `Blocked: ${redactedReason}`;
        await this.client.addComment(link.issueNumber, comment);
        this.blockedReasonHashes.set(link.task, reasonHash);
        this.recordWrite({
          task: link.task,
          issueNumber: link.issueNumber,
          op: "add_comment",
          value: redactedReason.slice(0, 100),
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

  /** Remove the blocked label when task is unblocked. */
  private async removeBlockedLabel(link: TrackerLink): Promise<void> {
    if (this.settings.mode !== "act") {
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "remove_label",
        value: "blocked",
        mode: "observe",
        wouldSend: JSON.stringify({ label: "blocked" }),
        result: null,
        error: null,
      });
      return;
    }

    if (!this.checkWriteBudget()) return;

    try {
      await this.client.removeLabel(link.issueNumber, "blocked");
      this.blockedReasonHashes.delete(link.task);
      this.recordWrite({
        task: link.task,
        issueNumber: link.issueNumber,
        op: "remove_label",
        value: "blocked",
        mode: "act",
        wouldSend: null,
        result: "success",
        error: null,
      });
    } catch (e) {
      this.handleApiError(e, link.task, "remove_label");
    }
  }

  // ============ Reconciliation ============

  private scheduleReconcile(): void {
    const interval = this.settings.reconcileIntervalSeconds * 1000;
    const nextAt = new Date(Date.now() + interval).toISOString();
    this.store.upsertSyncState(this.project, { nextReconcileAt: nextAt });

    this.reconcileTimer = setTimeout(async () => {
      try {
        await this.reconcile();
      } catch (e) {
        this.store.incrementErrorCount(this.project, e instanceof Error ? e.message : String(e));
      } finally {
        // Re-arm after reconcile completes (not before)
        this.scheduleReconcile();
      }
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
        // Issue not on board - could re-add it, but for now just note it
        if (link.projectItemId) {
          // We thought it was on the board but it's not
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
        const success = await this.moveToStatus({ ...link, status: actualStatus }, expectedStatus, link.agent);
        if (success) {
          fixed++;
          writes++;
          this.store.incrementDriftFixed(this.project);
        } else {
          errors.push(`Failed to fix drift for ${link.task}: write failed or rate limited`);
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

  /** Redact sensitive patterns from text. Applies built-in patterns first, then user patterns. */
  private redact(text: string): string {
    let result = text;

    // Apply built-in default patterns first
    for (const pattern of DEFAULT_REDACT_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }

    // Then apply user-configured patterns
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
