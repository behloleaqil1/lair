/**
 * Reviews and policy merge over HTTP: the real routes, ReviewManager, GitHub
 * provider, policy and local merge executor. Only the git host's HTTP API,
 * the git process calls and the clock are stand-ins (testing/fakes.ts), and
 * the assertions are on what changed: the branch on the "host", the PR's
 * state, the stored merge record and the events published.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewManager } from "./service.js";
import { registerReviewRoutes } from "./routes.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

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
  await registerReviewRoutes(server, manager, () => "demo");
  await server.ready();
  /** Ask for the missing reviews; returns the token the assigner would hand to the reviewer agent. */
  const assign = async (pr: number, project = "demo"): Promise<string> => {
    const before = seen.length;
    const res = await server.inject({ method: "POST", url: `/api/review/prs/${pr}/request-reviews?project=${project}` });
    if (res.statusCode !== 200) throw new Error(res.body);
    const event = seen.slice(before).find((e) => e.type === "review.assignment_requested");
    if (!event) throw new Error(`no agent assignment for PR ${pr}: ${res.body}`);
    return String(event.data.token);
  };
  return { app: server, remote, base, head, seen, assign };
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
    const { app, remote, base, head, seen, assign } = await boot();

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
    // The first use bound the assignment to worker-b
    const reused = await review(app, 7, { id: "worker-c", kind: "agent" }, head, "approve", [], "demo", token);
    expect(reused.statusCode).toBe(403);
    expect(reused.json().error).toContain("for worker-b");
    const ready = await status(app, 7);
    expect(ready.data.canMerge).toBe(true);
    expect(ready.data.reasons).toEqual([]);
    expect(ready.data.slots[0].satisfiedBy.reviewer.id).toBe("worker-b");
    expect(ready.data.conditions.every((c: { ok: boolean }) => c.ok)).toBe(true);

    // Without confirmation nothing happens
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
      payload: { head_sha: head },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toContain("confirm");
    expect(remote.branches.get("main")).toBe(base);

    const merged = await app.inject({
      method: "POST",
      url: "/api/review/prs/7/merge",
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
    const { app, remote, base, seen, assign } = await boot();
    const leaked = remote.commit([base], PRIVATE, "fix: tidy up");
    remote.openPull({ number: 8, title: "Tidy up", headRef: "agent/worker-a/tidy", headSha: leaked, files: [FEATURE] });
    remote.setChecks(leaked, [["build", "success"]]);

    await review(app, 8, { id: "worker-b", kind: "agent" }, leaked, "approve", [], "demo", await assign(8));
    expect((await status(app, 8)).data.canMerge).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/review/prs/8/merge",
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
    const { app, remote, head, seen, assign } = await boot();
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
      payload: { confirm: true, head_sha: head },
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().data.reasons[0]).toContain(`The head is now ${pushed.slice(0, 7)}`);
    expect(remote.branches.get("main")).not.toBe(pushed);

    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("blocks on open blocking findings until the reviewer resolves them; the author can't", async () => {
    const { app, head, assign } = await boot();
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

    const byAuthor = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      payload: { by: { id: "worker-a", kind: "agent" }, note: "fixed it" },
    });
    expect(byAuthor.statusCode).toBe(403);

    const byReviewer = await app.inject({
      method: "POST",
      url: `/api/review/findings/${finding.id}/resolve`,
      payload: { by: { id: "worker-b", kind: "agent" }, note: "Bounded in the caller" },
    });
    expect(byReviewer.statusCode).toBe(200);
    expect(byReviewer.json().data).toMatchObject({ status: "resolved", resolvedBy: "worker-b", resolution: "Bounded in the caller" });

    const stillObjecting = await status(app, 7);
    expect(stillObjecting.data.conditions.find((c: { id: string }) => c.id === "findings")).toMatchObject({ ok: true });
    expect(stillObjecting.data.canMerge).toBe(false);

    await review(app, 7, { id: "worker-b", kind: "agent" }, head, "approve", [], "demo", token);
    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("holds stop a merge until released", async () => {
    const { app, head, assign } = await boot();
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
      payload: { confirm: true, head_sha: head },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("Release freeze");

    const released = await app.inject({
      method: "POST",
      url: `/api/review/holds/${hold.json().data.id}/release`,
      payload: { by: "owner" },
    });
    expect(released.statusCode).toBe(200);
    expect((await status(app, 7)).data.canMerge).toBe(true);
  });

  it("validates input and reports projects without reviews", async () => {
    const { app, head, assign } = await boot();
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
      payload: { confirm: true, head_sha: head },
    });
    expect(merge.statusCode).toBe(403);
  });
});
