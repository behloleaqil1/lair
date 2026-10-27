/**
 * Reviews and policy merge over HTTP: the real routes, ReviewManager, GitHub
 * provider, policy and local merge executor. Only the git host's HTTP API,
 * the git process calls and the clock are stand-ins (testing/fakes.ts), and
 * the assertions are on what changed: the branch on the "host", the PR's
 * state, the stored merge record and the events published.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig, PullRequest } from "../../shared/types.js";
import { ReviewManager } from "./service.js";
import { registerReviewRoutes } from "./routes.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { signIn } from "../../client/owner-session";
import { mergePr, prStatus, releaseHold, resolveFinding, submitOwnerReview } from "../../client/review-api";
import { readinessOf } from "../../client/pr-readiness";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const OWNER: Person = { name: "Example Owner", email: "owner@example.com" };
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const PRIVATE: Person = { name: "Someone", email: "someone@private.example" };

const FEATURE: FakeFile = {
  filename: "src/feature.ts",
  status: "added",
  additions: 3,
  deletions: 0,
  patch: "@@ -0,0 +1,3 @@\n+export function double(n: number): number {\n+  return n * 2;\n+}",
};

const FEATURE_TEST_SOURCE = [
  'import { describe, expect, it } from "vitest";',
  'import { double } from "./feature";',
  "",
  'describe("double", () => {',
  '  it("doubles", () => {',
  "    expect(double(21)).toBe(42);",
  "  });",
  "});",
].join("\n");

const FEATURE_TEST: FakeFile = {
  filename: "src/feature.test.ts",
  status: "added",
  additions: 8,
  deletions: 0,
  patch: `@@ -0,0 +1,8 @@\n${FEATURE_TEST_SOURCE.split("\n").map((l) => `+${l}`).join("\n")}`,
  content: FEATURE_TEST_SOURCE,
};

let app: FastifyInstance | null = null;
let manager: ReviewManager | null = null;
let dir: string | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  manager?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

function projectConfig(name: string, review: Record<string, unknown> | undefined, readOnly = false): ProjectConfig {
  return {
    name,
    repo: "/home/user/demo",
    github: "example-org/demo",
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: readOnly,
    dragons: {
      "worker-a": { name: "A", model: "model-one", machine: "local", instructions: "" },
      "worker-b": { name: "B", model: "model-two", machine: "local", instructions: "" },
    },
    review,
  };
}

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "lair-review-routes-"));
  const remote = new FakeRemote("example-org/demo");
  const base = remote.commit([], OWNER, "initial");
  remote.branches.set("main", base);
  remote.setChecks(base, [["build", "success"]]);
  const head = remote.commit([base], AGENT, "feat: double numbers");
  remote.openPull({
    number: 7,
    title: "Double numbers",
    headRef: "agent/worker-a/double",
    headSha: head,
    files: [FEATURE, FEATURE_TEST],
  });
  remote.setChecks(head, [["build", "success"]]);

  const events = new EventBus();
  const seen: Event[] = [];
  events.on("*", (event) => {
    seen.push(event);
  });
  const review = {
    enabled: true,
    authors: { branch_pattern: "agent/{agent}/**" },
    merge: {
      gate: { source: "checks", required: ["build"] },
      allowed_emails: ["*@users.noreply.github.com", "owner@example.com"],
      work_dir: join(dir, "work"),
    },
  };
  const git = new FakeGit(remote);
  manager = new ReviewManager({
    dbPath: ":memory:",
    events,
    clock: new FakeClock(NOW),
    git,
    fetch: fakeGitHubApi(remote),
    env: {},
    cwd: dir,
  });
  manager.load([
    { name: "demo", config: projectConfig("demo", review) },
    { name: "frozen", config: projectConfig("frozen", review, true) },
    { name: "plain", config: projectConfig("plain", undefined) },
    { name: "broken", config: projectConfig("broken", { enabled: true, merge: { gate: { source: "nightly" } } }) },
  ]);
  const server = Fastify();
  app = server;
  // The owner's credential, as src/server/index.ts wires it; fastify.close() closes it
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(server, auth);
  await registerReviewRoutes(server, manager, () => "demo", auth);
  await server.ready();
  const ownerToken = readFileSync(tokenPath, "utf-8").trim();
  /** A browser on the dashboard signed in as the owner */
  const owner = {
    origin: "http://localhost:4777",
    "sec-fetch-site": "same-origin",
    [OWNER_SESSION_HEADER]: auth.createSession(ownerToken)!.session,
  };
  /** The owner asks for the missing reviews; returns the token the assigner would hand to the reviewer agent. */
  const assign = async (pr: number, project = "demo"): Promise<string> => {
    const before = seen.length;
    const res = await server.inject({
      method: "POST",
      url: `/api/review/prs/${pr}/request-reviews?project=${project}`,
      headers: owner,
    });
    if (res.statusCode !== 200) throw new Error(res.body);
    const event = seen.slice(before).find((e) => e.type === "review.assignment_requested");
    if (!event) throw new Error(`no agent assignment for PR ${pr}: ${res.body}`);
    return String(event.data.token);
  };
  return { app: server, remote, base, head, seen, assign, owner, ownerToken };
}

async function review(
  server: FastifyInstance,
  pr: number,
  reviewer: { id: string; kind: "human" | "agent" },
  headSha: string,
  verdict: "approve" | "request_changes" = "approve",
  findings: unknown[] = [],
  project = "demo",
  token: string | null = null,
) {
  return server.inject({
    method: "POST",
    url: `/api/review/prs/${pr}/reviews?project=${project}`,
    payload: {
      reviewer,
      head_sha: headSha,
      verdict,
      summary: `${verdict} by ${reviewer.id}`,
      findings,
      ...(token ? { assignment_token: token } : {}),
    },
  });
}

async function status(server: FastifyInstance, pr: number, project = "demo") {
  const res = await server.inject({ url: `/api/review/prs/${pr}?project=${project}` });
  return res.json();
}

describe("review routes: review, policy, merge", () => {
  it("drives a review to a satisfied policy and merges locally (ff-only) over HTTP", async () => {
    const { app, remote, base, head, seen, assign, owner } = await boot();

    const list = (await app.inject({ url: "/api/review/prs" })).json();
    expect(list.data).toEqual([expect.objectContaining({ number: 7, headSha: head, tier: null, canMerge: null })]);

    const before = await status(app, 7);
    expect(before.success).toBe(true);
    expect(before.data.risk.tier).toBe("amber");
    expect(before.data.author).toEqual({ id: "worker-a", kind: "agent", model: "model-one" });
    expect(before.data.authorSource).toBe("branch");
    expect(before.data.gate).toEqual([expect.objectContaining({ name: "build", status: "passed", sha: head })]);
    expect(before.data.plan).toMatchObject({ method: "local", strategy: "ff-only" });
    expect(before.data.plan.reason).toContain("host_email_private");
    // The test integrity check ran at the head: a real test of real code, no findings
    expect(before.data.reviews).toEqual([
      expect.objectContaining({ reviewer: { id: "lair:test-integrity", kind: "check" }, headSha: head, verdict: "approve" }),
    ]);
    expect(before.data.canMerge).toBe(false);
    expect(before.data.conditions.find((c: { id: string }) => c.id === "reviews")).toMatchObject({ ok: false });
    expect(before.data.reasons.join("\n")).toContain("Required reviews: 0/1");

    // The PR's author is never set over HTTP
    const setAuthor = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/author",
      payload: { id: "worker-c", kind: "agent" },
    });
    expect(setAuthor.statusCode).toBe(404);

    // An agent can't review without an assignment
    const unassigned = await review(app, 7, { id: "worker-b", kind: "agent" }, head);
    expect(unassigned.statusCode).toBe(403);
    expect(unassigned.json().error).toContain("assignment_token");

    // Lair asks for the peer review; the token goes to the assignee, and the author can't use it
    const token = await assign(7);
    const byAuthor = await review(app, 7, { id: "worker-a", kind: "agent" }, head, "approve", [], "demo", token);
    expect(byAuthor.statusCode).toBe(403);
    expect(byAuthor.json().error).toContain("the PR's author");
    const forged = await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", "x".repeat(32));
    expect(forged.statusCode).toBe(403);

    // A peer's approval at the head, with the token, fills the slot
    const peer = await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", token);
    expect(peer.statusCode).toBe(200);
    expect(peer.json().data).toMatchObject({
      stale: false,
      review: { reviewer: { id: "worker-b", model: "model-two" }, client: { address: "127.0.0.1" } },
    });
    // The first use bound the assignment to worker-b, and used it up
    const reused = await review(app, 7, { id: "worker-c", kind: "agent" }, head, "approve", [], "demo", token);
    expect(reused.statusCode).toBe(403);
    expect(reused.json().error).toContain("for worker-b");
    const again = await review(app, 7, { id: "worker-b", kind: "agent" }, head, "request_changes", [], "demo", token);
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toContain("already used (by worker-b)");
    // Asking for reviews is the owner's: without its session the request is refused
    const anonymous = await app.inject({ method: "POST", url: "/api/review/prs/7/request-reviews?project=demo" });
    expect(anonymous.statusCode).toBe(403);
    const ready = await status(app, 7);
    expect(ready.data.canMerge).toBe(true);
    expect(ready.data.reasons).toEqual([]);
    expect(ready.data.slots[0].satisfiedBy.reviewer.id).toBe("worker-b");
    expect(ready.data.conditions.every((c: { ok: boolean }) => c.ok)).toBe(true);

    // Only the owner merges: an agent (no session) is refused, and nothing is pushed
    const byAgent = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      payload: { confirm: true, head_sha: head },
    });
    expect(byAgent.statusCode).toBe(403);
    expect(byAgent.json().error).toContain("Only the owner");
    expect(remote.branches.get("main")).toBe(base);

    // Without confirmation nothing happens
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: owner,
      payload: { head_sha: head },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toContain("confirm");
    expect(remote.branches.get("main")).toBe(base);

    // lair:policy is what an automatic merge is recorded as: the owner's route can't record one under it
    const posing = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: owner,
      payload: { confirm: true, head_sha: head, by: "lair:policy" },
    });
    expect(posing.statusCode).toBe(400);
    expect(posing.json().error).toContain("names starting with lair: are Lair's own");
    expect(remote.branches.get("main")).toBe(base);

    // Nor anything else under Lair's names: a review, a hold, a release or a resolution
    const posingAsLair: [string, Record<string, unknown>, Record<string, string>][] = [
      ["/api/review/prs/7/owner-review", { reviewer: "lair:test-integrity", head_sha: head, verdict: "approve" }, owner],
      [
        "/api/review/prs/7/reviews",
        { reviewer: { id: "LAIR:policy", kind: "agent" }, head_sha: head, verdict: "approve", assignment_token: "t".repeat(32) },
        {},
      ],
      ["/api/review/holds", { reason: "freeze", by: "lair:policy" }, {}],
      ["/api/review/holds/hold-1/release", { by: "lair:policy" }, owner],
      ["/api/review/findings/f-1/resolve", { by: "lair:policy", note: "fixed" }, owner],
    ];
    for (const [url, payload, headers] of posingAsLair) {
      const res = await app.inject({ method: "POST", url, headers, payload });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toContain("names starting with lair: are Lair's own");
    }
    expect((await app.inject({ url: "/api/review/holds" })).json().data).toEqual([]);

    const merged = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: owner,
      payload: { confirm: true, head_sha: head, by: "owner" },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data).toMatchObject({
      merged: true,
      reasons: [],
      record: {
        pr: 7,
        headSha: head,
        method: "local",
        strategy: "ff-only",
        resultSha: head,
        initiatedBy: "owner",
        commitsChecked: 1,
        client: { address: "127.0.0.1" },
      },
    });
    // The default branch on the host now is the reviewed head, and the host sees the PR merged
    expect(remote.branches.get("main")).toBe(head);
    expect(remote.pulls.get(7)).toMatchObject({ state: "closed", merged: true });
    // ...without the host's own merge button
    expect(remote.requests.some((r) => r.method === "PUT")).toBe(false);

    const merges = (await app.inject({ url: "/api/review/merges" })).json();
    expect(merges.data).toEqual([expect.objectContaining({ pr: 7, resultSha: head, method: "local" })]);
    const types = seen.map((e) => e.type);
    expect(types).toContain("review.submitted");
    expect(seen.find((e) => e.type === "review.merged")?.data).toMatchObject({ project: "demo", pr: 7, resultSha: head });
  });

  it("refuses a merge whose commits carry an email outside the allow-list, before pushing", async () => {
    const { app, remote, base, seen, assign, owner } = await boot();
    const leaked = remote.commit([base], PRIVATE, "fix: tidy up");
    remote.openPull({ number: 8, title: "Tidy up", headRef: "agent/worker-a/tidy", headSha: leaked, files: [FEATURE] });
    remote.setChecks(leaked, [["build", "success"]]);

    await review(app, 8, { id: "worker-b", kind: "agent" }, leaked, "approve", [], "demo", await assign(8));
    expect((await status(app, 8)).data.canMerge).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/review/prs/8/merge",
      headers: owner,
      payload: { confirm: true, head_sha: leaked },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.data.merged).toBe(false);
    expect(body.data.reasons).toEqual([
      `commit ${leaked.slice(0, 7)}: author email s***@private.example, which is not in review.merge.allowed_emails`,
      `commit ${leaked.slice(0, 7)}: committer email s***@private.example, which is not in review.merge.allowed_emails`,
    ]);
    // The address itself is not repeated in the response
    expect(JSON.stringify(body)).not.toContain(PRIVATE.email);
    // Nothing was published, and the PR is still open
    expect(remote.branches.get("main")).toBe(base);
    expect(remote.pulls.get(8)).toMatchObject({ state: "open", merged: false });
    expect((await app.inject({ url: "/api/review/merges" })).json().data).toEqual([]);
    // The human gets a security decision; the refusal is an event
    expect(seen.find((e) => e.type === "review.decision_requested")?.data).toMatchObject({
      project: "demo",
      kind: "security",
      reversible: false,
    });
    expect(seen.some((e) => e.type === "review.merge_refused")).toBe(true);
  });

  it("binds approvals to the head: a new push makes them stale, and a merge confirmed at the old head is refused", async () => {
    const { app, remote, head, seen, assign, owner } = await boot();
    const first = await assign(7);
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", first);
    expect((await status(app, 7)).data.canMerge).toBe(true);

    const pushed = remote.commit([head], AGENT, "feat: handle negatives");
    remote.pushToPull(7, pushed);

    const after = await status(app, 7);
    expect(after.data.headSha).toBe(pushed);
    expect(after.data.canMerge).toBe(false);
    expect(after.data.reviews.find((r: { reviewer: { id: string } }) => r.reviewer.id === "worker-b")).toMatchObject({
      headSha: head,
      stale: true,
    });
    expect(after.data.slots[0].detail).toContain(`needs an approval at ${pushed.slice(0, 7)}`);
    // The gate that passed at the old head doesn't count either
    expect(after.data.gate).toEqual([expect.objectContaining({ status: "missing", sha: pushed })]);
    expect(seen.find((e) => e.type === "review.invalidated")?.data).toMatchObject({
      pr: 7,
      previousHead: head,
      headSha: pushed,
      staleReviews: 1,
    });

    remote.setChecks(pushed, [["build", "success"]]);
    // The old assignment was for the old head
    const oldToken = await review(app, 7, { id: "worker-b", kind: "agent" }, pushed, "approve", [], "demo", first);
    expect(oldToken.statusCode).toBe(403);
    expect(oldToken.json().error).toContain(`for head ${head.slice(0, 7)}`);
    // A merge confirmed at the old head is refused even though the new head would pass
    await review(app, 7, { id: "worker-b", kind: "agent" }, pushed, "approve", [], "demo", await assign(7));
    const old = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: owner,
      payload: { confirm: true, head_sha: head },
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().data.reasons[0]).toContain(`The head is now ${pushed.slice(0, 7)}`);
    expect(remote.branches.get("main")).not.toBe(pushed);

    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("blocks on open blocking findings until the owner resolves them; an agent or the author can't", async () => {
    const { app, head, assign, owner } = await boot();
    const token = await assign(7);
    const contradictory = await review(
      app,
      7,
      { id: "worker-b", kind: "agent" },
      head,
      "approve",
      [{ severity: "high", file: "src/feature.ts", line: 2, text: "Overflows", blocking: true }],
      "demo",
      token,
    );
    expect(contradictory.statusCode).toBe(400);

    await review(
      app,
      7,
      { id: "worker-b", kind: "agent" },
      head,
      "request_changes",
      [
        { severity: "high", file: "src/feature.ts", line: 2, text: "Overflows for large inputs", blocking: true },
        { severity: "low", file: null, line: null, text: "Consider a doc comment", blocking: false },
      ],
      "demo",
      token,
    );
    const blocked = await status(app, 7);
    expect(blocked.data.canMerge).toBe(false);
    const findings = blocked.data.conditions.find((c: { id: string }) => c.id === "findings");
    expect(findings).toMatchObject({ ok: false });
    expect(findings.detail).toContain("src/feature.ts:2 Overflows for large inputs (worker-b)");
    expect(blocked.data.conditions.find((c: { id: string }) => c.id === "changes_requested")).toMatchObject({ ok: false });
    const finding = blocked.data.findings.find((f: { blocking: boolean }) => f.blocking);

    // Without the owner's session (an agent, a script) it is refused before the body is read
    const byAgent = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      payload: { by: "worker-b", note: "fixed it" },
    });
    expect(byAgent.statusCode).toBe(403);
    // The owner can't resolve it in the author's name either
    const asAuthor = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      headers: owner,
      payload: { by: "worker-a", note: "fixed it" },
    });
    expect(asAuthor.statusCode).toBe(403);

    const byOwner = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      headers: owner,
      payload: { by: "owner", note: "Bounded in the caller" },
    });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().data).toMatchObject({
      status: "resolved",
      resolvedBy: "owner",
      resolution: "Bounded in the caller",
      resolvedClient: { address: "127.0.0.1" },
    });
    expect(byOwner.json().data.resolvedClient.ownerSession).toEqual(expect.any(String));

    const stillObjecting = await status(app, 7);
    expect(stillObjecting.data.conditions.find((c: { id: string }) => c.id === "findings")).toMatchObject({ ok: true });
    expect(stillObjecting.data.canMerge).toBe(false);

    // The used token doesn't count again: the reviewer approves under a new assignment
    const reused = await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", token);
    expect(reused.statusCode).toBe(403);
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", await assign(7));
    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("holds stop a merge until released", async () => {
    const { app, head, assign, owner } = await boot();
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", await assign(7));
    const hold = await app.inject({
      method: "POST",
      url: "/api/review/holds",
      payload: { reason: "Release freeze", by: "owner" },
    });
    expect(hold.statusCode).toBe(200);
    const held = await status(app, 7);
    expect(held.data.canMerge).toBe(false);
    expect(held.data.reasons).toEqual([expect.stringContaining("No hold: Release freeze")]);
    const refused = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: owner,
      payload: { confirm: true, head_sha: head },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("Release freeze");

    const released = await app.inject({
      method: "POST",
      url: `/api/review/holds/${hold.json().data.id}/release`,
      headers: owner,
      payload: { by: "owner" },
    });
    expect(released.statusCode).toBe(200);
    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("validates input and reports projects without reviews", async () => {
    const { app, head, assign, owner } = await boot();
    expect((await app.inject({ url: "/api/review/prs/0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/review/prs/abc" })).statusCode).toBe(400);
    // An approval must name the full head sha
    expect((await review(app, 7, { id: "worker-b", kind: "agent" }, head.slice(0, 7))).statusCode).toBe(400);
    const asCheck = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/reviews",
      payload: { reviewer: { id: "lair:test-integrity", kind: "check" }, head_sha: head, verdict: "approve" },
    });
    expect(asCheck.statusCode).toBe(400);

    const plain = await app.inject({ url: "/api/review/prs/7?project=plain" });
    expect(plain.statusCode).toBe(404);
    expect(plain.json().error).toContain("review.enabled");
    expect((await app.inject({ url: "/api/review/status?project=plain" })).json().data).toMatchObject({
      enabled: false,
      errors: [],
    });
    const broken = (await app.inject({ url: "/api/review/status?project=broken" })).json().data;
    expect(broken.enabled).toBe(false);
    expect(broken.errors[0]).toContain("review.merge.gate");

    // A read-only project shows why it can't merge, and refuses to
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "frozen", await assign(7, "frozen"));
    const frozen = await status(app, 7, "frozen");
    expect(frozen.data.canMerge).toBe(false);
    expect(frozen.data.reasons).toEqual([expect.stringContaining("Read-only")]);
    const merge = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge?project=frozen",
      headers: owner,
      payload: { confirm: true, head_sha: head },
    });
    expect(merge.statusCode).toBe(403);
  });

  it("refuses human reviews, resolutions, hold releases and merges without the owner's session", async () => {
    const { app, remote, base, head, assign, owner } = await boot();
    const humanReview = { reviewer: "owner", head_sha: head, verdict: "approve" };
    const dashboardOnly = { origin: owner.origin, "sec-fetch-site": owner["sec-fetch-site"] };

    // A human-kind review through the agents' route is refused: humans review as the owner
    const viaAgentRoute = await review(app, 7, { id: "owner", kind: "human" }, head);
    expect(viaAgentRoute.statusCode).toBe(403);
    expect(viaAgentRoute.json().error).toContain("owner-review");
    // ...and the owner route needs the session, from the dashboard
    for (const headers of [{}, dashboardOnly, { [OWNER_SESSION_HEADER]: owner[OWNER_SESSION_HEADER] }]) {
      const res = await app.inject({ method: "POST", url: "/api/review/prs/7/owner-review", headers, payload: humanReview });
      expect(res.statusCode).toBe(403);
    }

    const token = await assign(7);
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "request_changes", [
      { severity: "high", file: "src/feature.ts", line: 2, text: "Overflows", blocking: true },
    ], "demo", token);
    const finding = (await status(app, 7)).data.findings.find((f: { blocking: boolean }) => f.blocking);
    const resolve = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      headers: dashboardOnly,
      payload: { by: "owner", note: "fine" },
    });
    expect(resolve.statusCode).toBe(403);

    // Anyone may add a hold; only the owner releases one
    const hold = await app.inject({ method: "POST", url: "/api/review/holds", payload: { reason: "Freeze", by: "worker-b" } });
    expect(hold.statusCode).toBe(200);
    const release = await app.inject({
      method: "POST",
      url: `/api/review/holds/${hold.json().data.id}/release`,
      payload: { by: "worker-b" },
    });
    expect(release.statusCode).toBe(403);

    const merge = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      headers: dashboardOnly,
      payload: { confirm: true, head_sha: head },
    });
    expect(merge.statusCode).toBe(403);

    const after = await status(app, 7);
    expect(after.data.reviews.map((r: { reviewer: { id: string } }) => r.reviewer.id)).toEqual(["lair:test-integrity", "worker-b"]);
    expect(after.data.findings.find((f: { id: string }) => f.id === finding.id).status).toBe("open");
    expect(after.data.holds).toHaveLength(1);
    expect(remote.branches.get("main")).toBe(base);
  });

  it("a hold from anyone but the owner's browser is a notice, whatever `by` says; one item per PR however many holds", async () => {
    const { app, owner } = await boot();
    const store = new DecisionStore(":memory:");
    const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: { now: () => NOW } });
    try {
      await manager!.useDecisions(inbox);
      const hold = (pr: number, by: string, headers: Record<string, string> = {}) =>
        app.inject({ method: "POST", url: "/api/review/holds", headers, payload: { reason: "wait", pr, by } });

      // An agent (or any local process) claiming to be the owner: a notice, never counted or pushed
      for (let i = 0; i < 50; i++) expect((await hold(7, "owner")).statusCode).toBe(200);
      let open = inbox.list({ project: "demo", status: "open" });
      expect(open.map((d) => [d.source.ref, d.attention])).toEqual([["pr:7", "notice"]]);
      expect(inbox.counts()).toMatchObject({ action: 0, notices: 1 });

      // The owner's own hold, from their signed-in browser: an action item
      expect((await hold(8, "owner", owner)).statusCode).toBe(200);
      open = inbox.list({ project: "demo", status: "open" });
      expect(open.find((d) => d.source.ref === "pr:8")).toMatchObject({ attention: "action", title: "PR #8 can't merge: it is held by owner" });
      expect(inbox.counts()).toMatchObject({ action: 1, notices: 1 });
    } finally {
      manager!.get("demo")?.stopDecisions();
      store.close();
    }
  });

  it("lets the owner review, resolve, release and merge through the dashboard's client helpers", async () => {
    const { app, remote, head, ownerToken } = await boot();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", browserFetch(app));

    // Not signed in yet: the helpers send no session and the server refuses
    await expect(mergePr("demo", 7, head, "owner")).rejects.toThrow("not signed in as the owner");

    await signIn(ownerToken);
    const draft = { reviewer: "owner", headSha: head, summary: "" };
    const objection = await submitOwnerReview("demo", 7, {
      ...draft,
      verdict: "request_changes",
      findings: [{ severity: "high", file: "src/feature.ts", line: 2, text: "Check overflow", blocking: true }],
    });
    expect(objection.review).toMatchObject({ reviewer: { id: "owner", kind: "human" }, verdict: "request_changes" });
    expect(objection.review.client?.ownerSession).toEqual(expect.any(String));
    const resolved = await resolveFinding("demo", objection.review.findings[0].id, { by: "owner", note: "Checked" });
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "owner" });
    await submitOwnerReview("demo", 7, { ...draft, verdict: "approve", findings: [] });

    const hold = await app.inject({ method: "POST", url: "/api/review/holds", payload: { reason: "Freeze", by: "owner" } });
    expect((await status(app, 7)).data.canMerge).toBe(false);
    expect(await releaseHold("demo", hold.json().data.id, "owner")).toMatchObject({ releasedBy: "owner" });

    // The owner fills the amber tier's peer slot, so it can merge
    const ready = await status(app, 7);
    expect(ready.data.slots[0].satisfiedBy.reviewer).toEqual({ id: "owner", kind: "human" });
    const merged = await mergePr("demo", 7, head, "owner");
    expect(merged).toMatchObject({ merged: true, record: { pr: 7, resultSha: head, initiatedBy: "owner" } });
    expect(merged.record?.client?.ownerSession).toEqual(objection.review.client?.ownerSession);
    expect(remote.branches.get("main")).toBe(head);
  });

  it("gives the PRs view its readiness: a passed gate with changes requested waits, and is merge ready once the policy allows it", async () => {
    const { app, head, assign, owner } = await boot();
    vi.stubGlobal("fetch", browserFetch(app));
    // The PR as /api/prs lists it: a gate passed at the head (all the view used to look at)
    const listed: PullRequest = {
      number: 7,
      title: "Double numbers",
      headRefName: "agent/worker-a/double",
      headRefOid: head,
      mergeable: "MERGEABLE",
      updatedAt: new Date(NOW).toISOString(),
      mergeReady: true,
    };
    const token = await assign(7);
    await review(
      app,
      7,
      { id: "worker-b", kind: "agent" },
      head,
      "request_changes",
      [{ severity: "high", file: "src/feature.ts", line: 2, text: "Overflows for large inputs", blocking: true }],
      "demo",
      token,
    );

    // What the PRs view asks for, with the dashboard's helper: the review module's own status for the PR
    const rejected = await prStatus("demo", 7);
    expect(rejected.canMerge).toBe(false);
    expect(rejected.reasons.length).toBeGreaterThan(0);
    expect(readinessOf(listed, true, { headSha: head, checkedAt: NOW, status: rejected, error: null })).toEqual({
      group: "waiting",
      label: `Waiting: ${rejected.reasons[0]}`,
      tier: rejected.risk.tier,
      checkedAt: NOW,
    });
    // Without the review module the same PR only counts as a passed gate
    expect(readinessOf(listed, false)).toMatchObject({ group: "ready", label: "Gate passed" });

    // The owner resolves the blocking finding and the reviewer approves at the head
    const finding = rejected.findings.find((f) => f.blocking);
    const resolved = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding?.id}/resolve`,
      headers: owner,
      payload: { by: "owner", note: "Bounded in the caller" },
    });
    expect(resolved.statusCode).toBe(200);
    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", await assign(7));
    const allowed = await prStatus("demo", 7);
    expect(allowed.canMerge).toBe(true);
    expect(readinessOf(listed, true, { headSha: head, checkedAt: NOW, status: allowed, error: null })).toEqual({
      group: "ready",
      label: "Merge ready",
      tier: allowed.risk.tier,
      checkedAt: NOW,
    });
  });
});

/** localStorage for one origin. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };
}

/**
 * A browser on the dashboard (origin http://127.0.0.1:4777) as the client
 * helpers' fetch: it resolves relative URLs, adds Origin to non-GET requests
 * and Sec-Fetch-Site: same-origin to all, and goes to the test server.
 */
function browserFetch(server: FastifyInstance) {
  const origin = "http://127.0.0.1:4777";
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), origin);
    const method = (init.method ?? "GET").toUpperCase() as "GET" | "POST";
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      "sec-fetch-site": "same-origin",
    };
    if (method !== "GET") headers.origin = origin;
    const res = await server.inject({
      method,
      url: url.pathname + url.search,
      headers,
      payload: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
  };
}
