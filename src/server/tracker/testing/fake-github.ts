/**
 * GitHub, as the tracker's client sees it over HTTP: the REST issues, pulls,
 * labels, comments, milestones and search endpoints, and the GraphQL
 * Projects (v2) queries and mutations it sends. The only stand-in in the
 * tracker's tests: the client, the service, the manager, the store and the
 * routes are the production ones.
 *
 * Every request is recorded (method, path, body, whether it carried an
 * AbortSignal), so a test can show what was sent and what never was.
 * `intercept` can answer a request differently: a status, a hang (it ends
 * only when the request's signal aborts), or "lose the answer" (the change
 * is made, then the connection drops before the answer arrives).
 */
import type { FetchLike } from "../github-projects.js";

export interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  milestone: number | null;
  nodeId: string;
  isPull: boolean;
  comments: string[];
  /** Made through the API by the tracker (search lags behind these when searchLag is on) */
  viaApi: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FakePull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  body: string;
  headRef: string;
}

export interface FakeMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
  dueOn: string | null;
  description: string | null;
}

export interface FakeItem {
  id: string;
  contentNodeId: string;
  status: string | null;
  agent: string | null;
}

export interface FakeBoard {
  id: string;
  owner: string;
  number: number;
  title: string;
  url: string;
  statusFieldId: string;
  options: { id: string; name: string }[];
  agentFieldId: string | null;
  items: FakeItem[];
}

/** A request body as the client sends it: the fields the fake reads */
export interface FakeBody {
  query?: string;
  variables?: Record<string, unknown>;
  title?: string;
  body?: string;
  labels?: string[];
  milestone?: number | null;
  state?: "open" | "closed";
  state_reason?: string | null;
  due_on?: string | null;
  description?: string | null;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: FakeBody | undefined;
  /** GraphQL: the operation's first field (repositoryOwner, node, addProjectV2ItemById, updateProjectV2ItemFieldValue) */
  graphql: string | null;
  /** A REST write or a GraphQL mutation */
  write: boolean;
  hadSignal: boolean;
  auth: string | null;
}

export type Intercept = { status: number; body?: unknown; headers?: Record<string, string> } | "hang" | "lose-answer";

interface RepoState {
  name: string;
  issues: Map<number, FakeIssue>;
  pulls: Map<number, FakePull>;
  milestones: Map<number, FakeMilestone>;
  next: number;
  nextMilestone: number;
}

export const STATUS_OPTIONS = ["Backlog", "Ready", "In progress", "In review", "Done"];

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  };
}

export class FakeGitHub {
  /** X-OAuth-Scopes of GET /user; null: the header is absent (a fine-grained token) */
  scopes: string | null = "repo, project, read:org";
  readonly requests: FakeRequest[] = [];
  readonly boards = new Map<string, FakeBoard>();
  /** Search sees none of the issues created through the API (it lags behind them) */
  searchLag = false;
  intercept: ((req: FakeRequest) => Intercept | undefined) | null = null;
  private readonly repos = new Map<string, RepoState>();
  private itemCount = 0;
  private clock = 0;

  constructor(readonly api = "https://api.github.test") {}

  repo(name: string): RepoState {
    const key = name.toLowerCase();
    let state = this.repos.get(key);
    if (!state) {
      state = { name, issues: new Map(), pulls: new Map(), milestones: new Map(), next: 1, nextMilestone: 1 };
      this.repos.set(key, state);
    }
    return state;
  }

  /** GitHub's clock: real time, and never the same instant twice */
  private tick(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  addIssue(repo: string, fields: Partial<Omit<FakeIssue, "repo" | "number" | "nodeId">> & { title: string }): FakeIssue {
    const r = this.repo(repo);
    const number = r.next++;
    const at = this.tick();
    const issue: FakeIssue = {
      repo: r.name,
      number,
      title: fields.title,
      body: fields.body ?? "",
      state: fields.state ?? "open",
      stateReason: fields.stateReason ?? null,
      labels: fields.labels ?? [],
      milestone: fields.milestone ?? null,
      nodeId: `I_${r.name.replace(/\W/g, "_")}_${number}`,
      isPull: fields.isPull ?? false,
      comments: fields.comments ?? [],
      viaApi: fields.viaApi ?? false,
      createdAt: at,
      updatedAt: at,
    };
    r.issues.set(number, issue);
    return issue;
  }

  issue(repo: string, number: number): FakeIssue | undefined {
    return this.repo(repo).issues.get(number);
  }

  issues(repo: string): FakeIssue[] {
    return [...this.repo(repo).issues.values()].filter((i) => !i.isPull);
  }

  addPull(repo: string, pull: Partial<FakePull> & { body: string; headRef: string }): FakePull {
    const r = this.repo(repo);
    const number = pull.number ?? r.next++;
    if (number >= r.next) r.next = number + 1;
    const full: FakePull = { number, state: pull.state ?? "open", merged: pull.merged ?? false, body: pull.body, headRef: pull.headRef };
    r.pulls.set(number, full);
    // A PR is an issue too, as GitHub's issues API lists it
    this.repo(repo).issues.set(number, {
      repo: r.name,
      number,
      title: `PR ${number}`,
      body: pull.body,
      state: full.state,
      stateReason: null,
      labels: [],
      milestone: null,
      nodeId: `PR_${number}`,
      isPull: true,
      comments: [],
      viaApi: false,
      createdAt: this.tick(),
      updatedAt: this.clock,
    });
    return full;
  }

  addMilestone(repo: string, fields: Partial<FakeMilestone> & { title: string }): FakeMilestone {
    const r = this.repo(repo);
    const m: FakeMilestone = {
      number: r.nextMilestone++,
      title: fields.title,
      state: fields.state ?? "open",
      dueOn: fields.dueOn ?? null,
      description: fields.description ?? null,
    };
    r.milestones.set(m.number, m);
    return m;
  }

  milestone(repo: string, number: number): FakeMilestone | undefined {
    return this.repo(repo).milestones.get(number);
  }

  addBoard(owner: string, number: number, options: { agentField?: boolean; statusOptions?: string[] } = {}): FakeBoard {
    const id = `PVT_${owner}_${number}`;
    const board: FakeBoard = {
      id,
      owner,
      number,
      title: `${owner} board ${number}`,
      url: `https://github.test/users/${owner}/projects/${number}`,
      statusFieldId: `F_status_${number}`,
      options: (options.statusOptions ?? STATUS_OPTIONS).map((name, i) => ({ id: `opt_${number}_${i}`, name })),
      agentFieldId: options.agentField === false ? null : `F_agent_${number}`,
      items: [],
    };
    this.boards.set(id, board);
    return board;
  }

  /** The card of an issue on a board */
  card(board: FakeBoard, repo: string, number: number): FakeItem | undefined {
    const issue = this.issue(repo, number);
    return issue ? board.items.find((i) => i.contentNodeId === issue.nodeId) : undefined;
  }

  /** Requests that change something: REST writes and GraphQL mutations */
  writes(): FakeRequest[] {
    return this.requests.filter((r) => r.write);
  }

  private findIssueByNode(nodeId: string): FakeIssue | undefined {
    for (const r of this.repos.values()) for (const i of r.issues.values()) if (i.nodeId === nodeId) return i;
    return undefined;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== this.api) throw new TypeError(`fetch failed: unknown host ${u.host}`);
    const body = init.body ? (JSON.parse(init.body) as FakeBody) : undefined;
    const isGraphql = u.pathname === "/graphql";
    const query: string = isGraphql ? String(body?.query ?? "") : "";
    const mutation = isGraphql && /^\s*mutation\b/.test(query);
    const req: FakeRequest = {
      method: init.method,
      path: u.pathname,
      query: u.searchParams,
      body,
      graphql: isGraphql ? (/\{\s*(\w+)/.exec(query.slice(query.indexOf("{")))?.[1] ?? null) : null,
      write: isGraphql ? mutation : init.method !== "GET",
      hadSignal: init.signal instanceof AbortSignal,
      auth: init.headers.Authorization ?? null,
    };
    this.requests.push(req);
    const action = this.intercept?.(req);
    if (action === "hang") {
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    if (action && typeof action === "object") return reply(action.status, action.body ?? { message: "intercepted" }, action.headers);
    const result = isGraphql ? this.graphql(query, body?.variables ?? {}) : this.rest(req);
    if (action === "lose-answer") throw new TypeError("fetch failed: the connection was reset");
    return result;
  };

  // ============ REST ============

  private issueJson(i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      state_reason: i.stateReason,
      html_url: `https://github.test/${i.repo}/issues/${i.number}`,
      node_id: i.nodeId,
      labels: i.labels.map((name) => ({ name })),
      milestone: i.milestone === null ? null : { number: i.milestone },
      ...(i.isPull ? { pull_request: { url: `https://api.github.test/repos/${i.repo}/pulls/${i.number}` } } : {}),
      created_at: new Date(i.createdAt).toISOString(),
      updated_at: new Date(i.updatedAt).toISOString(),
    };
  }

  private milestoneJson(repo: RepoState, m: FakeMilestone) {
    const inIt = [...repo.issues.values()].filter((i) => !i.isPull && i.milestone === m.number);
    return {
      number: m.number,
      title: m.title,
      state: m.state,
      description: m.description,
      due_on: m.dueOn,
      open_issues: inIt.filter((i) => i.state === "open").length,
      closed_issues: inIt.filter((i) => i.state === "closed").length,
    };
  }

  private rest(req: FakeRequest) {
    const { method, path } = req;
    const body: FakeBody = req.body ?? {};
    if (method === "GET" && path === "/user") {
      return reply(200, { login: "example-bot" }, this.scopes === null ? {} : { "X-OAuth-Scopes": this.scopes });
    }
    if (method === "GET" && path === "/search/issues") {
      const q = req.query.get("q") ?? "";
      const repoName = /repo:(\S+)/.exec(q)?.[1] ?? "";
      const phrase = (/in:title "([^"]*)"/.exec(q)?.[1] ?? "").toLowerCase();
      const items = [...this.repo(repoName).issues.values()]
        .filter((i) => !(this.searchLag && i.viaApi))
        .filter((i) => (q.includes("is:issue") ? !i.isPull : true))
        .filter((i) => (q.includes("is:open") ? i.state === "open" : true))
        .filter((i) => i.title.toLowerCase().includes(phrase))
        .map((i) => this.issueJson(i));
      return reply(200, { total_count: items.length, items });
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls|milestones)(?:\/(\d+))?(?:\/(labels|comments))?(?:\/([^/]+))?$/.exec(path);
    if (!m) return reply(404, { message: "Not Found" });
    const repo = this.repo(m[1]);
    const kind = m[2];
    const number = m[3] ? Number(m[3]) : null;
    const sub = m[4];
    if (kind === "issues") {
      if (number === null) {
        if (method === "GET") {
          const since = Date.parse(req.query.get("since") ?? "1970-01-01T00:00:00Z");
          const list = [...repo.issues.values()]
            .filter((i) => i.updatedAt >= since)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, Number(req.query.get("per_page") ?? 30))
            .map((i) => this.issueJson(i));
          return reply(200, list);
        }
        if (method === "POST") {
          const issue = this.addIssue(repo.name, {
            title: body.title ?? "",
            body: body.body ?? "",
            labels: body.labels ?? [],
            milestone: body.milestone ?? null,
            viaApi: true,
          });
          return reply(201, this.issueJson(issue));
        }
      }
      const issue = number !== null ? repo.issues.get(number) : undefined;
      if (!issue) return reply(404, { message: "Not Found" });
      if (!sub) {
        if (method === "GET") return reply(200, this.issueJson(issue));
        if (method === "PATCH") {
          if (body.state) issue.state = body.state;
          if (body.state_reason !== undefined) issue.stateReason = body.state_reason;
          issue.updatedAt = this.tick();
          return reply(200, this.issueJson(issue));
        }
      }
      if (sub === "labels" && method === "POST") {
        for (const label of body.labels ?? []) if (!issue.labels.includes(label)) issue.labels.push(label);
        return reply(200, issue.labels.map((name) => ({ name })));
      }
      if (sub === "labels" && method === "DELETE") {
        const name = decodeURIComponent(m[5] ?? "");
        if (!issue.labels.includes(name)) return reply(404, { message: "Label does not exist" });
        issue.labels = issue.labels.filter((l) => l !== name);
        return reply(200, []);
      }
      if (sub === "comments" && method === "POST") {
        issue.comments.push(body.body ?? "");
        return reply(201, { id: issue.comments.length, body: body.body });
      }
    }
    if (kind === "pulls" && method === "GET") {
      const pullJson = (p: FakePull) => ({ number: p.number, state: p.state, merged: p.merged, body: p.body, head: { ref: p.headRef } });
      if (number === null) return reply(200, [...repo.pulls.values()].filter((p) => p.state === "open").map(pullJson));
      const pull = repo.pulls.get(number);
      return pull ? reply(200, pullJson(pull)) : reply(404, { message: "Not Found" });
    }
    if (kind === "milestones") {
      if (number === null && method === "GET") {
        const state = req.query.get("state") ?? "open";
        return reply(200, [...repo.milestones.values()].filter((ms) => ms.state === state).map((ms) => this.milestoneJson(repo, ms)));
      }
      const ms = number !== null ? repo.milestones.get(number) : undefined;
      if (!ms) return reply(404, { message: "Not Found" });
      if (method === "PATCH") {
        if (body.state) ms.state = body.state;
        if (body.due_on !== undefined) ms.dueOn = body.due_on;
        if (body.title !== undefined) ms.title = body.title;
        if (body.description !== undefined) ms.description = body.description;
        return reply(200, this.milestoneJson(repo, ms));
      }
    }
    return reply(404, { message: "Not Found" });
  }

  // ============ GraphQL ============

  private graphql(query: string, v: Record<string, unknown>) {
    if (query.includes("repositoryOwner(")) {
      const board = [...this.boards.values()].find((b) => b.owner === v.owner && b.number === v.number);
      if (!board) {
        return reply(200, { data: { repositoryOwner: { projectV2: null } }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a ProjectV2 with the number ${v.number}.` }] });
      }
      const fields = [
        { __typename: "ProjectV2Field", id: "F_title", name: "Title", dataType: "TITLE" },
        { __typename: "ProjectV2SingleSelectField", id: board.statusFieldId, name: "Status", options: board.options },
        ...(board.agentFieldId ? [{ __typename: "ProjectV2Field", id: board.agentFieldId, name: "Agent", dataType: "TEXT" }] : []),
      ];
      return reply(200, { data: { repositoryOwner: { projectV2: { id: board.id, title: board.title, url: board.url, fields: { nodes: fields } } } } });
    }
    if (query.includes("items(first")) {
      const board = this.boards.get(String(v.board));
      if (!board) return reply(200, { data: { node: null } });
      const nodes = board.items.map((item) => {
        const issue = this.findIssueByNode(item.contentNodeId);
        const values: unknown[] = [{ __typename: "ProjectV2ItemFieldTextValue", text: issue?.title ?? "", field: { name: "Title" } }];
        if (item.status !== null) values.push({ __typename: "ProjectV2ItemFieldSingleSelectValue", name: item.status, field: { name: "Status" } });
        if (item.agent !== null) values.push({ __typename: "ProjectV2ItemFieldTextValue", text: item.agent, field: { name: "Agent" } });
        return {
          id: item.id,
          content: issue ? { __typename: issue.isPull ? "PullRequest" : "Issue", number: issue.number, repository: { nameWithOwner: issue.repo } } : { __typename: "DraftIssue" },
          fieldValues: { nodes: values },
        };
      });
      return reply(200, { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    if (query.includes("addProjectV2ItemById")) {
      const board = this.boards.get(String(v.board));
      const issue = this.findIssueByNode(String(v.content));
      if (!board || !issue) return reply(200, { data: null, errors: [{ type: "NOT_FOUND", message: "not found" }] });
      let item = board.items.find((i) => i.contentNodeId === issue.nodeId);
      if (!item) {
        item = { id: `PVTI_${++this.itemCount}`, contentNodeId: issue.nodeId, status: null, agent: null };
        board.items.push(item);
      }
      return reply(200, { data: { addProjectV2ItemById: { item: { id: item.id } } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const board = this.boards.get(String(v.board));
      const item = board?.items.find((i) => i.id === v.item);
      if (!board || !item) return reply(200, { data: null, errors: [{ type: "NOT_FOUND", message: "not found" }] });
      if (v.field === board.statusFieldId) item.status = board.options.find((o) => o.id === v.option)?.name ?? null;
      else if (v.field === board.agentFieldId) item.agent = String(v.text);
      return reply(200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
    }
    return reply(200, { data: null, errors: [{ message: "unknown query" }] });
  }
}
