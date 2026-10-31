/**
 * GitHub Projects v2 API client for the tracker module.
 * Uses GraphQL for Projects v2 (which has no REST API).
 * The token needs `repo` + `project` scopes.
 */
import type { TokenSource } from "../review/github.js";

/** The default timeout for all GitHub API requests (15 seconds). */
const REQUEST_TIMEOUT_MS = 15_000;

export class ProjectsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: "rate_limit" | "scope" | "timeout" | "network",
  ) {
    super(message);
    this.name = "ProjectsApiError";
  }
}

/** A minimal fetch-like interface that also accepts an abort signal. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get?(name: string): string | null } }>;

/** Parse Retry-After header value (seconds or HTTP-date). */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = parseInt(value, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  // Try HTTP-date
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Parse X-RateLimit-Reset header (Unix timestamp seconds). */
function parseRateLimitReset(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = parseInt(value, 10);
  if (!Number.isNaN(timestamp) && timestamp > 0) {
    return Math.max(0, timestamp * 1000 - Date.now());
  }
  return null;
}

/** A single-select field on a Projects v2 board */
export interface ProjectField {
  id: string;
  name: string;
  options: { id: string; name: string }[];
}

/** A text field on a Projects v2 board */
export interface ProjectTextField {
  id: string;
  name: string;
}

/** A Projects v2 board with its fields */
export interface ProjectBoard {
  id: string;
  title: string;
  url: string;
  statusField: ProjectField | null;
  agentField: ProjectTextField | null;
}

/** An item on the board (linked to an issue or PR) */
export interface ProjectItem {
  id: string;
  contentId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  issueNumber: number | null;
  status: string | null;
  agent: string | null;
}

/** A GitHub issue as seen by the tracker */
export interface TrackerIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  milestoneNumber: number | null;
  projectItemId: string | null;
}

/** A GitHub milestone */
export interface TrackerMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  description: string | null;
}

export interface GitHubProjectsOptions {
  /** owner/repo */
  repo: string;
  /** The project owner (user or org) and number */
  project: { owner: string; number: number } | null;
  /** e.g. https://api.github.com */
  apiUrl: string;
  token: TokenSource;
  fetch?: FetchLike;
  /** The name of the Status field to look for */
  statusFieldName: string;
  /** The name of the Agent field to look for (optional) */
  agentFieldName: string | null;
}

export class GitHubProjectsClient {
  private readonly api: string;
  private readonly fetchFn: FetchLike;
  /** Rate limit reset time (Unix ms). Requests should wait until then. */
  private rateLimitResetAt = 0;
  /** When set, the last error was a missing scope (permanent). */
  private scopeError: string | null = null;

  constructor(private readonly options: GitHubProjectsOptions) {
    this.api = options.apiUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Returns true if rate-limited and sets `rateLimitResetMs` appropriately. */
  private checkRateLimitWait(): number | null {
    const now = Date.now();
    if (this.rateLimitResetAt > now) {
      return this.rateLimitResetAt - now;
    }
    return null;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    // Block if rate limited
    const wait = this.checkRateLimitWait();
    if (wait !== null) {
      throw new ProjectsApiError(
        `Rate limited: wait ${Math.ceil(wait / 1000)}s`,
        429,
        "rate_limit",
      );
    }
    if (this.scopeError) {
      throw new ProjectsApiError(this.scopeError, 403, "scope");
    }

    const token = await this.options.token();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lair-tracker",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await this.fetchFn(`${this.api}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new ProjectsApiError(
          `GitHub ${method} ${path.split("?")[0]}: request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
          "timeout",
        );
      }
      if (e instanceof Error && (e.name === "AbortError" || e.message.includes("abort"))) {
        throw new ProjectsApiError(
          `GitHub ${method} ${path.split("?")[0]}: request aborted`,
          0,
          "network",
        );
      }
      throw e;
    }

    const text = await response.text();

    // Handle rate limiting (403 or 429)
    if (response.status === 403 || response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers?.get?.("Retry-After"));
      const resetHeader = parseRateLimitReset(response.headers?.get?.("X-RateLimit-Reset"));
      const waitMs = retryAfter ?? resetHeader ?? 60_000;
      this.rateLimitResetAt = Date.now() + waitMs;

      // Check if this is a scope error rather than a rate limit
      const isScope = text.includes("scope") || text.includes("permission") || text.includes("INSUFFICIENT");
      if (isScope && response.status === 403) {
        this.scopeError = `GitHub ${method} ${path.split("?")[0]}: missing required scope`;
        throw new ProjectsApiError(this.scopeError, 403, "scope");
      }

      throw new ProjectsApiError(
        `GitHub ${method} ${path.split("?")[0]}: rate limited, retry after ${Math.ceil(waitMs / 1000)}s`,
        response.status,
        "rate_limit",
      );
    }

    if (!response.ok) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        /* ignore parse errors */
      }
      throw new ProjectsApiError(
        `GitHub ${method} ${path.split("?")[0]}: ${response.status} ${message}`,
        response.status,
      );
    }
    return { status: response.status, text };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // Block if rate limited
    const wait = this.checkRateLimitWait();
    if (wait !== null) {
      throw new ProjectsApiError(
        `Rate limited: wait ${Math.ceil(wait / 1000)}s`,
        429,
        "rate_limit",
      );
    }
    if (this.scopeError) {
      throw new ProjectsApiError(this.scopeError, 403, "scope");
    }

    const token = await this.options.token();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "lair-tracker",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await this.fetchFn(`${this.api}/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new ProjectsApiError(
          `GitHub GraphQL: request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
          "timeout",
        );
      }
      if (e instanceof Error && (e.name === "AbortError" || e.message.includes("abort"))) {
        throw new ProjectsApiError(`GitHub GraphQL: request aborted`, 0, "network");
      }
      throw e;
    }

    const text = await response.text();

    // Check rate limit headers even on success
    const resetHeader = parseRateLimitReset(response.headers?.get?.("X-RateLimit-Reset"));
    const remaining = response.headers?.get?.("X-RateLimit-Remaining");
    if (remaining === "0" && resetHeader) {
      this.rateLimitResetAt = Date.now() + resetHeader;
    }

    if (!response.ok) {
      // Handle rate limiting
      if (response.status === 403 || response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers?.get?.("Retry-After"));
        const waitMs = retryAfter ?? resetHeader ?? 60_000;
        this.rateLimitResetAt = Date.now() + waitMs;

        const isScope = text.includes("scope") || text.includes("permission") || text.includes("INSUFFICIENT");
        if (isScope && response.status === 403) {
          this.scopeError = `GitHub GraphQL: missing required scope`;
          throw new ProjectsApiError(this.scopeError, 403, "scope");
        }

        throw new ProjectsApiError(
          `GitHub GraphQL: rate limited, retry after ${Math.ceil(waitMs / 1000)}s`,
          response.status,
          "rate_limit",
        );
      }
      throw new ProjectsApiError(`GitHub GraphQL: ${response.status} ${text.slice(0, 200)}`, response.status);
    }

    const result = JSON.parse(text) as { data?: T; errors?: { type?: string; message: string }[] };
    if (result.errors && result.errors.length > 0) {
      const msg = result.errors.map((e) => e.message).join("; ");

      // Check for GraphQL rate limit error (HTTP 200 but errors array)
      const isRateLimited = result.errors.some(
        (e) => e.type === "RATE_LIMITED" || e.message.includes("rate limit"),
      );
      if (isRateLimited) {
        this.rateLimitResetAt = Date.now() + 60_000;
        throw new ProjectsApiError(`GitHub GraphQL: rate limited`, 429, "rate_limit");
      }

      // Check for scope errors
      if (msg.includes("INSUFFICIENT_SCOPES") || msg.includes("scope")) {
        this.scopeError = `GitHub GraphQL: missing required scope (need repo + project): ${msg}`;
        throw new ProjectsApiError(this.scopeError, 403, "scope");
      }
      throw new ProjectsApiError(`GitHub GraphQL: ${msg}`, 400);
    }
    if (!result.data) {
      throw new ProjectsApiError("GitHub GraphQL: no data returned", 500);
    }
    return result.data;
  }

  /** Clear the scope error (useful for testing or token refresh). */
  clearScopeError(): void {
    this.scopeError = null;
  }

  /** Get the rate limit reset time (ms since epoch), or 0 if not limited. */
  getRateLimitResetAt(): number {
    return this.rateLimitResetAt;
  }

  private repoPath(suffix: string): string {
    return `/repos/${this.options.repo}${suffix}`;
  }

  /** Check if the token has the required scopes */
  async checkScopes(): Promise<{ ok: boolean; missing: string[] }> {
    // Make a simple request and check the X-OAuth-Scopes header
    const token = await this.options.token();
    if (!token) return { ok: false, missing: ["(no token)"] };

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "lair-tracker",
    };
    const response = await this.fetchFn(`${this.api}/user`, { method: "GET", headers });
    // GitHub returns scopes in the response headers
    const scopesHeader = (response as { headers?: { get?: (n: string) => string | null } }).headers?.get?.(
      "X-OAuth-Scopes"
    );
    if (!scopesHeader) {
      // Fine-grained tokens don't have this header, check by trying an operation
      return { ok: true, missing: [] };
    }
    const scopes = scopesHeader.split(",").map((s) => s.trim().toLowerCase());
    const missing: string[] = [];
    if (!scopes.includes("repo")) missing.push("repo");
    if (!scopes.includes("project") && !scopes.includes("read:project") && !scopes.includes("write:project")) {
      missing.push("project");
    }
    return { ok: missing.length === 0, missing };
  }

  /** Get the Projects v2 board with its Status and Agent fields */
  async getProjectBoard(): Promise<ProjectBoard | null> {
    if (!this.options.project) return null;

    const { owner, number } = this.options.project;
    const query = `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            title
            url
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            title
            url
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;
    const data = await this.graphql<{
      user?: { projectV2?: ProjectBoardRaw };
      organization?: { projectV2?: ProjectBoardRaw };
    }>(query, { owner, number });

    const project = data.user?.projectV2 ?? data.organization?.projectV2;
    if (!project) return null;

    // Find the Status field (single-select)
    let statusField: ProjectField | null = null;
    let agentField: ProjectTextField | null = null;

    for (const field of project.fields.nodes) {
      if ("options" in field && field.options && field.name.toLowerCase() === this.options.statusFieldName.toLowerCase()) {
        statusField = { id: field.id, name: field.name, options: field.options ?? [] };
      } else if (
        this.options.agentFieldName &&
        field.name.toLowerCase() === this.options.agentFieldName.toLowerCase() &&
        !("options" in field)
      ) {
        agentField = { id: field.id, name: field.name };
      }
    }

    return {
      id: project.id,
      title: project.title,
      url: project.url,
      statusField,
      agentField,
    };
  }

  /** Get all items on the board */
  async listProjectItems(boardId: string): Promise<ProjectItem[]> {
    interface ProjectItemsResponse {
      node?: {
        items: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ProjectItemRaw[];
        };
      };
    }

    const items: ProjectItem[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const query = `
        query($boardId: ID!, $cursor: String) {
          node(id: $boardId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                      number
                    }
                    ... on PullRequest {
                      id
                      number
                    }
                    ... on DraftIssue {
                      id
                    }
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        field { ... on ProjectV2SingleSelectField { name } }
                        name
                      }
                      ... on ProjectV2ItemFieldTextValue {
                        field { ... on ProjectV2Field { name } }
                        text
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const data: ProjectItemsResponse = await this.graphql<ProjectItemsResponse>(query, { boardId, cursor });

      const itemsData = data.node?.items;
      if (!itemsData) break;

      for (const item of itemsData.nodes) {
        let status: string | null = null;
        let agent: string | null = null;

        for (const fv of item.fieldValues.nodes) {
          if ("name" in fv && fv.field?.name?.toLowerCase() === this.options.statusFieldName.toLowerCase()) {
            status = fv.name ?? null;
          } else if (
            "text" in fv &&
            this.options.agentFieldName &&
            fv.field?.name?.toLowerCase() === this.options.agentFieldName.toLowerCase()
          ) {
            agent = fv.text ?? null;
          }
        }

        const content = item.content;
        items.push({
          id: item.id,
          contentId: content?.id ?? "",
          contentType: content?.number !== undefined ? (content.id?.startsWith("PR_") ? "PullRequest" : "Issue") : "DraftIssue",
          issueNumber: content?.number ?? null,
          status,
          agent,
        });
      }

      if (!itemsData.pageInfo.hasNextPage) break;
      cursor = itemsData.pageInfo.endCursor;
    }

    return items;
  }

  /** Add an issue to the board */
  async addItemToProject(boardId: string, contentId: string): Promise<string> {
    const mutation = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }
    `;
    const data = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(mutation, {
      projectId: boardId,
      contentId,
    });
    return data.addProjectV2ItemById.item.id;
  }

  /** Set a single-select field value (like Status) */
  async setItemSingleSelectField(
    boardId: string,
    itemId: string,
    fieldId: string,
    optionId: string,
  ): Promise<void> {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item { id }
        }
      }
    `;
    await this.graphql(mutation, {
      projectId: boardId,
      itemId,
      fieldId,
      value: { singleSelectOptionId: optionId },
    });
  }

  /** Set a text field value (like Agent) */
  async setItemTextField(boardId: string, itemId: string, fieldId: string, text: string): Promise<void> {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item { id }
        }
      }
    `;
    await this.graphql(mutation, {
      projectId: boardId,
      itemId,
      fieldId,
      value: { text },
    });
  }

  // ============ REST API for issues and milestones ============

  /** Get an issue by number */
  async getIssue(number: number): Promise<TrackerIssue | null> {
    try {
      const { text } = await this.request("GET", this.repoPath(`/issues/${number}`));
      const issue = JSON.parse(text) as GhIssue;
      return mapIssue(issue);
    } catch (e) {
      if (e instanceof ProjectsApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Search for an issue by exact title match */
  async findIssueByTitle(title: string): Promise<TrackerIssue | null> {
    const query = encodeURIComponent(`repo:${this.options.repo} is:issue in:title "${title}"`);
    const { text } = await this.request("GET", `/search/issues?q=${query}&per_page=5`);
    const result = JSON.parse(text) as { items: GhIssue[] };
    // Exact title match (case-insensitive)
    const match = result.items.find((i) => i.title.toLowerCase() === title.toLowerCase());
    return match ? mapIssue(match) : null;
  }

  /** Create an issue */
  async createIssue(options: {
    title: string;
    body: string;
    labels?: string[];
    milestone?: number;
  }): Promise<TrackerIssue> {
    const { text } = await this.request("POST", this.repoPath("/issues"), {
      title: options.title,
      body: options.body,
      labels: options.labels,
      milestone: options.milestone,
    });
    return mapIssue(JSON.parse(text) as GhIssue);
  }

  /** Close an issue */
  async closeIssue(number: number, reason?: string): Promise<void> {
    await this.request("PATCH", this.repoPath(`/issues/${number}`), {
      state: "closed",
      state_reason: reason ?? "completed",
    });
  }

  /** Reopen an issue */
  async reopenIssue(number: number): Promise<void> {
    await this.request("PATCH", this.repoPath(`/issues/${number}`), { state: "open" });
  }

  /** Add a label to an issue */
  async addLabel(number: number, label: string): Promise<void> {
    await this.request("POST", this.repoPath(`/issues/${number}/labels`), { labels: [label] });
  }

  /** Remove a label from an issue */
  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`));
    } catch (e) {
      // Ignore if label not present
      if (e instanceof ProjectsApiError && e.status === 404) return;
      throw e;
    }
  }

  /** Add a comment to an issue */
  async addComment(number: number, body: string): Promise<void> {
    await this.request("POST", this.repoPath(`/issues/${number}/comments`), { body });
  }

  /** Get the node ID of an issue (needed to add to project) */
  async getIssueNodeId(number: number): Promise<string | null> {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }
    `;
    const [owner, repo] = this.options.repo.split("/");
    const data = await this.graphql<{ repository?: { issue?: { id: string } } }>(query, {
      owner,
      repo,
      number,
    });
    return data.repository?.issue?.id ?? null;
  }

  // ============ Milestones ============

  /** List milestones */
  async listMilestones(state: "open" | "closed" | "all" = "all"): Promise<TrackerMilestone[]> {
    const { text } = await this.request("GET", this.repoPath(`/milestones?state=${state}&per_page=100`));
    return (JSON.parse(text) as GhMilestone[]).map(mapMilestone);
  }

  /** Get a milestone by number */
  async getMilestone(number: number): Promise<TrackerMilestone | null> {
    try {
      const { text } = await this.request("GET", this.repoPath(`/milestones/${number}`));
      return mapMilestone(JSON.parse(text) as GhMilestone);
    } catch (e) {
      if (e instanceof ProjectsApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Close a milestone */
  async closeMilestone(number: number): Promise<void> {
    await this.request("PATCH", this.repoPath(`/milestones/${number}`), { state: "closed" });
  }

  /** Reopen a milestone */
  async reopenMilestone(number: number): Promise<void> {
    await this.request("PATCH", this.repoPath(`/milestones/${number}`), { state: "open" });
  }
}

// ============ Internal types ============

interface ProjectBoardRaw {
  id: string;
  title: string;
  url: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      options?: { id: string; name: string }[];
    }>;
  };
}

interface ProjectItemRaw {
  id: string;
  content?: { id: string; number?: number };
  fieldValues: {
    nodes: Array<{
      field?: { name?: string };
      name?: string;
      text?: string;
    }>;
  };
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: { name: string }[];
  milestone?: { number: number } | null;
  node_id?: string;
}

interface GhMilestone {
  number: number;
  title: string;
  state: string;
  open_issues: number;
  closed_issues: number;
  due_on: string | null;
  description: string | null;
}

function mapIssue(i: GhIssue): TrackerIssue {
  return {
    number: i.number,
    title: i.title,
    state: i.state === "open" ? "open" : "closed",
    url: i.html_url,
    labels: i.labels.map((l) => l.name),
    milestoneNumber: i.milestone?.number ?? null,
    projectItemId: null, // Set by listProjectItems
  };
}

function mapMilestone(m: GhMilestone): TrackerMilestone {
  return {
    number: m.number,
    title: m.title,
    state: m.state === "open" ? "open" : "closed",
    openIssues: m.open_issues,
    closedIssues: m.closed_issues,
    dueOn: m.due_on,
    description: m.description,
  };
}
