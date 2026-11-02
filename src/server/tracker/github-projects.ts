/**
 * The tracker's GitHub client: REST for issues, pull requests, labels,
 * comments and milestones, GraphQL for Projects (v2) boards, which have no
 * REST API. One client per project (one token), for all its repositories.
 *
 * - Every request carries an AbortSignal: the request timeout, and the
 *   tracker's stop signal, so a hung connection never holds anything up.
 * - A read-only client (observe mode) refuses every write before anything is
 *   sent: a REST method other than GET, or a GraphQL mutation.
 * - Rate limits: a 429, a 403 that GitHub marks as a rate limit
 *   (Retry-After, X-RateLimit-Remaining: 0, or the message), and a GraphQL
 *   RATE_LIMITED error set a wait (Retry-After, else X-RateLimit-Reset, else
 *   60 s); no request is sent before it ends. Any other 403 is "forbidden"
 *   (a missing scope or permission), a 401 "auth": neither is retried by the
 *   client, the tracker stops its writes until the owner fixes the token.
 */
import type { TokenSource } from "../review/github.js";

/** fetch, as the client uses it (tests pass GitHub's stand-in) */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

export type GitHubErrorCode = "rate_limit" | "auth" | "forbidden" | "not_found" | "invalid" | "timeout" | "network" | "read_only" | "other";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GitHubErrorCode,
    /** rate_limit: no request before this time (ms) */
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** A Projects v2 board with the fields the tracker sets */
export interface Board {
  id: string;
  title: string;
  url: string;
  statusField: { id: string; name: string; options: { id: string; name: string }[] } | null;
  agentField: { id: string; name: string } | null;
}

/** An item on a board */
export interface BoardItem {
  id: string;
  kind: "Issue" | "PullRequest" | "DraftIssue" | "Other";
  /** owner/name of the issue's repository (null for a draft) */
  repo: string | null;
  number: number | null;
  status: string | null;
  agent: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  nodeId: string;
  labels: string[];
  milestone: number | null;
  isPullRequest: boolean;
}

export interface Pull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  body: string;
  headRef: string;
}

export interface Milestone {
  number: number;
  title: string;
  state: "open" | "closed";
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
}

export interface GitHubClientOptions {
  /** e.g. https://api.github.com (GitHub Enterprise: https://host/api/v3) */
  apiUrl: string;
  token: TokenSource;
  fetch?: FetchLike;
  timeoutMs: number;
  /** observe mode: every write is refused before it is sent */
  readOnly: boolean;
  /** Aborted when the tracker stops: requests in flight end at once */
  stopSignal?: AbortSignal;
  now?: () => number;
}

const DEFAULT_WAIT_MS = 60_000;
/** Board items read per reconcile: 10 pages of 100 */
const MAX_ITEM_PAGES = 10;

interface Response {
  status: number;
  text: string;
  headers: { get(name: string): string | null };
}

function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)} s`;
}

/** The time a rate limit ends, from Retry-After (seconds or a date), else X-RateLimit-Reset (epoch seconds). */
export function retryAtOf(headers: { get(name: string): string | null }, now: number): number | null {
  const after = headers.get("retry-after");
  if (after) {
    const s = Number(after);
    if (Number.isFinite(s) && s >= 0) return now + s * 1000;
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(now, date);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(now, reset * 1000);
  return null;
}

function messageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

/** Quotes and backslashes would end the phrase of a search query early. */
function searchPhrase(text: string): string {
  return `"${text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  node_id: string;
  labels?: ({ name?: string } | string)[];
  milestone?: { number: number } | null;
  pull_request?: unknown;
}

function issueOf(i: GhIssue): Issue {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    state: i.state === "open" ? "open" : "closed",
    url: i.html_url,
    nodeId: i.node_id,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    milestone: i.milestone?.number ?? null,
    isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
  };
}

export class GitHubTrackerClient {
  private readonly api: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  /** No request before this time (ms): GitHub's rate limit */
  private waitUntil = 0;

  constructor(private readonly options: GitHubClientOptions) {
    this.api = options.apiUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  get readOnly(): boolean {
    return this.options.readOnly;
  }

  /** The end of the current rate-limit wait (ms), or 0 */
  get rateLimitedUntil(): number {
    return this.waitUntil > this.now() ? this.waitUntil : 0;
  }

  /** A wait recorded before a restart (the tracker's store keeps it) */
  restoreRateLimit(until: number): void {
    if (until > this.now()) this.waitUntil = until;
  }

  private signal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    return this.options.stopSignal ? AbortSignal.any([timeout, this.options.stopSignal]) : timeout;
  }

  private async send(method: string, path: string, body: unknown, what: string): Promise<Response> {
    if (this.options.stopSignal?.aborted) throw new GitHubError(`${what}: the tracker is stopping`, 0, "network");
    const wait = this.waitUntil - this.now();
    if (wait > 0) throw new GitHubError(`${what}: GitHub's rate limit: waiting ${seconds(wait)}`, 429, "rate_limit", this.waitUntil);
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
        signal: this.signal(),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError") throw new GitHubError(`${what}: no answer in ${seconds(this.options.timeoutMs)}`, 0, "timeout");
      if (name === "AbortError") throw new GitHubError(`${what}: cut short (the tracker is stopping)`, 0, "network");
      throw new GitHubError(`${what}: ${e instanceof Error ? e.message : String(e)}`, 0, "network");
    }
    const text = await response.text();
    const result: Response = { status: response.status, text, headers: response.headers };
    const now = this.now();
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      // The last request of the window: none more until it resets
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) this.waitUntil = Math.max(this.waitUntil, reset * 1000);
    }
    if (response.ok) return result;
    const message = messageOf(text);
    if (response.status === 429 || (response.status === 403 && this.isRateLimit(response.headers, message))) {
      const retryAt = retryAtOf(response.headers, now) ?? now + DEFAULT_WAIT_MS;
      this.waitUntil = Math.max(this.waitUntil, retryAt);
      throw new GitHubError(`${what}: GitHub's rate limit (retry in ${seconds(retryAt - now)})`, response.status, "rate_limit", retryAt);
    }
    if (response.status === 401) throw new GitHubError(`${what}: the token was refused (401 ${message})`, 401, "auth");
    if (response.status === 403) {
      const needs = response.headers.get("x-accepted-oauth-scopes");
      throw new GitHubError(`${what}: forbidden (403 ${message})${needs ? `; it needs the scopes: ${needs}` : ""}`, 403, "forbidden");
    }
    if (response.status === 404 || response.status === 410) throw new GitHubError(`${what}: not found (${response.status})`, response.status, "not_found");
    if (response.status === 422) throw new GitHubError(`${what}: refused (422 ${message})`, 422, "invalid");
    throw new GitHubError(`${what}: ${response.status} ${message}`, response.status, "other");
  }

  private isRateLimit(headers: { get(name: string): string | null }, message: string): boolean {
    return headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message);
  }

  private async rest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const what = `GitHub ${method} ${path.split("?")[0]}`;
    if (method !== "GET" && this.options.readOnly) throw new GitHubError(`${what}: refused in observe mode (nothing is sent)`, 0, "read_only");
    const res = await this.send(method, path, body, what);
    return (res.text ? JSON.parse(res.text) : null) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const mutation = /^\s*mutation\b/.test(query);
    const what = `GitHub GraphQL ${mutation ? "mutation" : "query"}`;
    if (mutation && this.options.readOnly) throw new GitHubError(`${what}: refused in observe mode (nothing is sent)`, 0, "read_only");
    const res = await this.send("POST", "/graphql", { query, variables }, what);
    const parsed = JSON.parse(res.text) as { data?: T | null; errors?: { type?: string; message?: string }[] };
    const errors = parsed.errors ?? [];
    if (errors.length > 0) {
      const message = errors.map((e) => e.message ?? e.type ?? "error").join("; ").slice(0, 300);
      const types = new Set(errors.map((e) => e.type));
      if (types.has("RATE_LIMITED")) {
        const now = this.now();
        const retryAt = retryAtOf(res.headers, now) ?? now + DEFAULT_WAIT_MS;
        this.waitUntil = Math.max(this.waitUntil, retryAt);
        throw new GitHubError(`${what}: GitHub's rate limit (retry in ${seconds(retryAt - now)})`, 200, "rate_limit", retryAt);
      }
      if (types.has("INSUFFICIENT_SCOPES")) throw new GitHubError(`${what}: the token lacks a scope (${message})`, 200, "forbidden");
      if (types.has("FORBIDDEN")) throw new GitHubError(`${what}: forbidden (${message})`, 200, "forbidden");
      if (types.has("NOT_FOUND")) throw new GitHubError(`${what}: not found (${message})`, 200, "not_found");
      throw new GitHubError(`${what}: ${message}`, 200, "other");
    }
    if (!parsed.data) throw new GitHubError(`${what}: no data in the answer`, 200, "other");
    return parsed.data;
  }

  // ============ Token ============

  /** The token's classic OAuth scopes; null when GitHub reports none (a fine-grained token or an app token). */
  async scopes(): Promise<{ token: boolean; scopes: string[] | null }> {
    if (!(await this.options.token())) return { token: false, scopes: null };
    const res = await this.send("GET", "/user", undefined, "GitHub GET /user");
    const header = res.headers.get("x-oauth-scopes");
    if (header === null) return { token: true, scopes: null };
    return {
      token: true,
      scopes: header
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    };
  }

  // ============ Projects (GraphQL) ============

  async getBoard(owner: string, number: number, statusFieldName: string, agentFieldName: string | null): Promise<Board | null> {
    const fields = `id title url fields(first: 50) { nodes { __typename ... on ProjectV2SingleSelectField { id name options { id name } } ... on ProjectV2Field { id name dataType } } }`;
    const data = await this.graphql<{
      repositoryOwner: { projectV2?: BoardRaw | null } | null;
    }>(
      `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { ... on User { projectV2(number: $number) { ${fields} } } ... on Organization { projectV2(number: $number) { ${fields} } } } }`,
      { owner, number },
    );
    const raw = data.repositoryOwner?.projectV2;
    if (!raw) return null;
    let statusField: Board["statusField"] = null;
    let agentField: Board["agentField"] = null;
    for (const f of raw.fields.nodes) {
      if (!f?.name) continue;
      if (f.__typename === "ProjectV2SingleSelectField" && f.name.toLowerCase() === statusFieldName.toLowerCase()) {
        statusField = { id: f.id, name: f.name, options: f.options ?? [] };
      } else if (agentFieldName && f.__typename === "ProjectV2Field" && f.dataType === "TEXT" && f.name.toLowerCase() === agentFieldName.toLowerCase()) {
        agentField = { id: f.id, name: f.name };
      }
    }
    return { id: raw.id, title: raw.title, url: raw.url, statusField, agentField };
  }

  async listBoardItems(boardId: string, statusFieldName: string, agentFieldName: string | null): Promise<BoardItem[]> {
    const items: BoardItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_ITEM_PAGES; page++) {
      const data: { node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ItemRaw[] } } | null } =
        await this.graphql(
          `query($board: ID!, $cursor: String) { node(id: $board) { ... on ProjectV2 { items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id content { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } fieldValues(first: 30) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } } } } } } }`,
          { board: boardId, cursor },
        );
      const page_ = data.node?.items;
      if (!page_) break;
      for (const node of page_.nodes) {
        let status: string | null = null;
        let agent: string | null = null;
        for (const v of node.fieldValues?.nodes ?? []) {
          const field = v?.field?.name?.toLowerCase();
          if (!v || !field) continue;
          if (v.__typename === "ProjectV2ItemFieldSingleSelectValue" && field === statusFieldName.toLowerCase()) status = v.name ?? null;
          if (v.__typename === "ProjectV2ItemFieldTextValue" && agentFieldName && field === agentFieldName.toLowerCase()) agent = v.text ?? null;
        }
        const type = node.content?.__typename;
        items.push({
          id: node.id,
          kind: type === "Issue" || type === "PullRequest" || type === "DraftIssue" ? type : "Other",
          repo: node.content?.repository?.nameWithOwner ?? null,
          number: node.content?.number ?? null,
          status,
          agent,
        });
      }
      if (!page_.pageInfo.hasNextPage) break;
      cursor = page_.pageInfo.endCursor;
    }
    return items;
  }

  /** Adds the issue to the board; GitHub answers with the existing item when it is on it already. */
  async addToBoard(boardId: string, contentId: string): Promise<string> {
    const data = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($board: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $board, contentId: $content }) { item { id } } }`,
      { board: boardId, content: contentId },
    );
    return data.addProjectV2ItemById.item.id;
  }

  async setSingleSelect(boardId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await this.graphql(
      `mutation($board: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $board, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
      { board: boardId, item: itemId, field: fieldId, option: optionId },
    );
  }

  async setText(boardId: string, itemId: string, fieldId: string, text: string): Promise<void> {
    await this.graphql(
      `mutation($board: ID!, $item: ID!, $field: ID!, $text: String!) { updateProjectV2ItemFieldValue(input: { projectId: $board, itemId: $item, fieldId: $field, value: { text: $text } }) { projectV2Item { id } } }`,
      { board: boardId, item: itemId, field: fieldId, text },
    );
  }

  // ============ Issues (REST) ============

  async getIssue(repo: string, number: number): Promise<Issue | null> {
    try {
      return issueOf(await this.rest<GhIssue>("GET", `/repos/${repo}/issues/${number}`));
    } catch (e) {
      if (e instanceof GitHubError && e.code === "not_found") return null;
      throw e;
    }
  }

  /**
   * Open issues (not pull requests) whose title is exactly one of `titles`
   * (case-insensitive), searched by `phrase` in titles. Search may lag
   * behind a create: it is never the guard against a second create.
   */
  async findOpenIssuesByTitle(repo: string, phrase: string, titles: string[]): Promise<Issue[]> {
    const wanted = new Set(titles.map((t) => t.trim().toLowerCase()).filter(Boolean));
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title ${searchPhrase(phrase)}`);
    const result = await this.rest<{ items?: GhIssue[] }>("GET", `/search/issues?q=${q}&per_page=30`);
    return (result.items ?? [])
      .map(issueOf)
      .filter((issue) => !issue.isPullRequest && issue.state === "open" && wanted.has(issue.title.trim().toLowerCase()))
      .sort((a, b) => a.number - b.number);
  }

  /** The open issues (not pull requests), the most recently updated first: one page of `perPage` */
  async listOpenIssues(repo: string, perPage: number): Promise<Issue[]> {
    const list = await this.rest<GhIssue[]>("GET", `/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${perPage}`);
    return (list ?? []).map(issueOf).filter((issue) => !issue.isPullRequest && issue.state === "open");
  }

  /**
   * The issue whose body carries `marker`, among the issues created or
   * changed since `since` (the issues list, which never lags behind a
   * create the way search does).
   */
  async findIssueByMarker(repo: string, marker: string, since: string): Promise<Issue | null> {
    const list = await this.rest<GhIssue[]>(
      "GET",
      `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&since=${encodeURIComponent(since)}`,
    );
    for (const raw of list ?? []) {
      if (raw.pull_request) continue;
      if ((raw.body ?? "").includes(marker)) return issueOf(raw);
    }
    return null;
  }

  async createIssue(repo: string, issue: { title: string; body: string; labels: string[]; milestone: number | null }): Promise<Issue> {
    const body: Record<string, unknown> = { title: issue.title, body: issue.body };
    if (issue.labels.length > 0) body.labels = issue.labels;
    if (issue.milestone !== null) body.milestone = issue.milestone;
    return issueOf(await this.rest<GhIssue>("POST", `/repos/${repo}/issues`, body));
  }

  async closeIssue(repo: string, number: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.rest("PATCH", `/repos/${repo}/issues/${number}`, { state: "closed", state_reason: reason });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.rest("POST", `/repos/${repo}/issues/${number}/labels`, { labels });
  }

  /** Removes the label; an issue without it is fine. */
  async removeLabel(repo: string, number: number, label: string): Promise<void> {
    try {
      await this.rest("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (e instanceof GitHubError && e.code === "not_found") return;
      throw e;
    }
  }

  async addComment(repo: string, number: number, body: string): Promise<void> {
    await this.rest("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  // ============ Pull requests (REST) ============

  async getPull(repo: string, number: number): Promise<Pull | null> {
    try {
      const raw = await this.rest<GhPull>("GET", `/repos/${repo}/pulls/${number}`);
      return pullOf(raw);
    } catch (e) {
      if (e instanceof GitHubError && e.code === "not_found") return null;
      throw e;
    }
  }

  /** The open pull requests (the newest 100) */
  async listOpenPulls(repo: string): Promise<Pull[]> {
    const list = await this.rest<GhPull[]>("GET", `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
    return (list ?? []).map(pullOf);
  }

  /**
   * The closed pull requests, the most recently updated first (one page of
   * `perPage`): a merge made outside Lair's review module shows here. A
   * listed PR carries `merged_at`, not `merged`.
   */
  async listClosedPulls(repo: string, perPage: number): Promise<Pull[]> {
    const list = await this.rest<GhPull[]>("GET", `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}`);
    return (list ?? []).map(pullOf);
  }

  // ============ Milestones (REST) ============

  async listMilestones(repo: string, state: "open" | "closed"): Promise<Milestone[]> {
    const list = await this.rest<GhMilestone[]>("GET", `/repos/${repo}/milestones?state=${state}&per_page=100`);
    return (list ?? []).map((m) => ({
      number: m.number,
      title: m.title,
      state: m.state === "open" ? "open" : "closed",
      openIssues: m.open_issues,
      closedIssues: m.closed_issues,
      dueOn: m.due_on ?? null,
    }));
  }

  /** Opens or closes a milestone. Only its state is sent: its title, description and due date are the owner's. */
  async setMilestoneState(repo: string, number: number, state: "open" | "closed"): Promise<void> {
    await this.rest("PATCH", `/repos/${repo}/milestones/${number}`, { state });
  }
}

interface BoardRaw {
  id: string;
  title: string;
  url: string;
  fields: { nodes: ({ __typename?: string; id: string; name: string; dataType?: string; options?: { id: string; name: string }[] } | null)[] };
}

interface ItemRaw {
  id: string;
  content: { __typename?: string; number?: number; repository?: { nameWithOwner?: string } } | null;
  fieldValues?: { nodes: ({ __typename?: string; name?: string; text?: string; field?: { name?: string } } | null)[] };
}

interface GhPull {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  body?: string | null;
  head?: { ref?: string };
}

interface GhMilestone {
  number: number;
  title: string;
  state: string;
  open_issues: number;
  closed_issues: number;
  due_on?: string | null;
}

function pullOf(raw: GhPull): Pull {
  return {
    number: raw.number,
    state: raw.state === "open" ? "open" : "closed",
    merged: raw.merged === true || Boolean(raw.merged_at),
    body: raw.body ?? "",
    headRef: raw.head?.ref ?? "",
  };
}
