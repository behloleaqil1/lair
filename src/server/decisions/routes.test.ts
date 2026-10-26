/**
 * The Decision Inbox routes behind the root guards, as in src/server/index.ts:
 * answering only from the dashboard with the answer session, validated ids
 * and queries, origin checks, confirmation for spend, the open-decision cap,
 * and no secret in any response.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { AnswerCredential } from "./answer-auth.js";
import { registerDecisionRoutes } from "./routes.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import type { DecisionResolution } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SECRET = "example-token-value-0c4e2b9d";
const UNKNOWN_ID = "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b";
/** What a browser on the dashboard sends with a same-origin request */
const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

let app: FastifyInstance | null = null;
let store: DecisionStore | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  store = null;
  dir = null;
});

async function build(options: { maxOpenPerSource?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "lair-decision-routes-"));
  const tokenPath = join(dir, "decisions.answer-token");
  const credential = AnswerCredential.loadOrCreate(tokenPath);
  store = new DecisionStore(":memory:");
  const clock = { t: NOW, now: (): number => clock.t };
  const secrets = new MemorySecretStore();
  const inbox = new DecisionInbox({ store, secrets, clock, maxOpenPerSource: options.maxOpenPerSource });
  app = Fastify();
  registerRootGuards(app);
  await registerDecisionRoutes(app, inbox, () => "example", credential);
  await app.ready();
  const answerToken = readFileSync(tokenPath, "utf-8").trim();
  return { app, inbox, clock, secrets, answerToken };
}

/** Unlock answering the way the Decisions view does; returns the browser's headers with the session cookie. */
async function unlock(a: FastifyInstance, answerToken: string): Promise<Record<string, string>> {
  const res = await a.inject({ method: "POST", url: "/api/decisions/session", payload: { token: answerToken }, headers: DASHBOARD });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  return { ...DASHBOARD, cookie };
}

const budget = {
  kind: "spend",
  title: "Raise the monthly hosting budget",
  context: "The staging deploy needs a larger database plan.",
  options: [
    { id: "approve", label: "Approve", consequences: "Costs more; the deploy goes ahead." },
    { id: "decline", label: "Decline", consequences: "The deploy stays blocked." },
  ],
  recommended: { optionId: "approve", reasoning: "Staging can't start otherwise." },
  source: { module: "delivery", ref: "env:staging" },
  key: "budget:staging",
  blocks: ["deploy:staging"],
};

const token = {
  kind: "credentials",
  title: "Connect the git host",
  context: "Opening pull requests needs a token.",
  options: [
    { id: "supply", label: "Enter the token", consequences: "Lair can open pull requests.", suppliesSecret: true },
    { id: "later", label: "Not now", consequences: "Pull requests stay blocked." },
  ],
  recommended: { optionId: "supply", reasoning: "Nothing merges without it." },
  source: { module: "delivery", ref: "git-host" },
  key: "git-host-token",
  secretName: "GIT_HOST_TOKEN",
};

function post(a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return a.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers });
}

describe("answering is for the owner in the Decisions view only", () => {
  it("refuses an answer without the session cookie, without an Origin, or with a forged Sec-Fetch-Site (403, still open)", async () => {
    const { app, inbox, answerToken } = await build();
    const id = (await post(app, "/api/decisions", { ...budget, kind: "other" })).json().data.decision.id;
    const browser = await unlock(app, answerToken);
    const answer = { optionId: "approve" };

    // A local process: no Origin, no cookie (curl, a script, an agent)
    const bare = await post(app, `/api/decisions/${id}/answer`, answer);
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toContain("no Origin header");
    // The dashboard's headers, forged, but no session cookie
    const forged = await post(app, `/api/decisions/${id}/answer`, answer, DASHBOARD);
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toContain("answering is not unlocked in this browser");
    // The cookie without a browser Origin
    const noOrigin = await post(app, `/api/decisions/${id}/answer`, answer, { cookie: browser.cookie });
    expect(noOrigin.statusCode).toBe(403);
    // The cookie and Origin, but not a same-origin fetch
    const crossSite = await post(app, `/api/decisions/${id}/answer`, answer, { ...browser, "sec-fetch-site": "none" });
    expect(crossSite.statusCode).toBe(403);
    // A wrong cookie
    const wrong = await post(app, `/api/decisions/${id}/answer`, answer, { ...DASHBOARD, cookie: "lair_decisions=guess" });
    expect(wrong.statusCode).toBe(403);

    expect(inbox.get(id)).toMatchObject({ status: "open" });
    expect(inbox.get(id)?.audit?.map((a) => a.action)).toEqual(["raised"]);

    const ok = await post(app, `/api/decisions/${id}/answer`, answer, { ...browser, "user-agent": "ExampleBrowser/1.0" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ status: "answered", answeredBy: "owner" });
    expect(ok.json().data.audit[1].detail).toBe("chose approve (Approve); from 127.0.0.1 (ExampleBrowser/1.0)");
  });

  it("unlocks only with the token, from the dashboard, with an httpOnly SameSite=Strict cookie", async () => {
    const { app, answerToken } = await build();
    expect((await app.inject({ url: "/api/decisions/session" })).json().data).toEqual({ answering: false });

    const noBrowser = await post(app, "/api/decisions/session", { token: answerToken });
    expect(noBrowser.statusCode).toBe(403);
    expect(noBrowser.headers["set-cookie"]).toBeUndefined();
    const wrongToken = await post(app, "/api/decisions/session", { token: "x".repeat(43) }, DASHBOARD);
    expect(wrongToken.statusCode).toBe(403);
    expect(wrongToken.headers["set-cookie"]).toBeUndefined();

    const res = await post(app, "/api/decisions/session", { token: answerToken }, DASHBOARD);
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^lair_decisions=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/api\/decisions; Max-Age=\d+$/);
    expect(setCookie).not.toContain(answerToken);
    const cookie = setCookie.split(";")[0];
    expect((await app.inject({ url: "/api/decisions/session", headers: { cookie } })).json().data).toEqual({
      answering: true,
    });
  });

  it("takes no answerer from the request, and has no HTTP withdraw", async () => {
    const { app, inbox, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const id = (await post(app, "/api/decisions", { ...budget, kind: "other" })).json().data.decision.id;
    const spoofed = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", by: "someone-else" }, browser);
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json().error).toContain("by");
    const withdraw = await post(app, `/api/decisions/${id}/withdraw`, { module: "delivery", reason: "x" }, browser);
    expect(withdraw.statusCode).toBe(404);
    expect(inbox.get(id)?.status).toBe("open");
  });
});

describe("decision routes", () => {
  it("raise, list open first, detail with audit, answer; the producer resumes", async () => {
    const { app, inbox, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("delivery", (r) => {
      resumed.push(r);
    });

    const raised = await post(app, "/api/decisions?project=example", budget);
    expect(raised.statusCode).toBe(201);
    const id = raised.json().data.decision.id as string;
    expect(raised.json().data).toMatchObject({ created: true, decision: { project: "example", status: "open" } });

    const again = await post(app, "/api/decisions", budget);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ created: false, decision: { id } });

    const other = await post(app, "/api/decisions", { ...budget, kind: "other", key: "other", title: "Other" });
    const otherId = other.json().data.decision.id as string;
    await post(app, `/api/decisions/${otherId}/answer`, { optionId: "decline" }, browser);

    const list = (await app.inject({ url: "/api/decisions" })).json();
    expect(list.data.map((d: { id: string }) => d.id)).toEqual([id, otherId]);
    expect(list.data[0].audit).toBeUndefined();

    const detail = (await app.inject({ url: `/api/decisions/${id}` })).json();
    expect(detail.data.audit.map((a: { action: string }) => a.action)).toEqual(["raised"]);

    const answer = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true, note: "ok" }, browser);
    expect(answer.statusCode).toBe(200);
    expect(answer.json().data).toMatchObject({
      status: "answered",
      answer: { optionId: "approve", note: "ok" },
      answeredBy: "owner",
    });
    expect(resumed.map((r) => [r.decision.id, r.optionId])).toEqual([
      [otherId, "decline"],
      [id, "approve"],
    ]);
    expect(inbox.blockedOn("deploy:staging")).toBeNull();

    const open = (await app.inject({ url: "/api/decisions?status=open" })).json();
    expect(open.data).toEqual([]);
    const closed = (await app.inject({ url: "/api/decisions?status=closed&project=example" })).json();
    expect(closed.data).toHaveLength(2);
  });

  it("needs confirm: true to answer a spend decision", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const id = (await post(app, "/api/decisions", budget)).json().data.decision.id;
    const unconfirmed = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve" }, browser);
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe("confirm: answering a spend decision needs confirm: true");
    const confirmed = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true }, browser);
    expect(confirmed.statusCode).toBe(200);
    const twice = await post(app, `/api/decisions/${id}/answer`, { optionId: "decline", confirm: true }, browser);
    expect(twice.statusCode).toBe(409);
  });

  it("never returns the secret of a credentials answer", async () => {
    const { app, secrets, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const id = (await post(app, "/api/decisions", token)).json().data.decision.id;
    const answered = await post(app, `/api/decisions/${id}/answer`, { optionId: "supply", secret: SECRET }, browser);
    expect(answered.statusCode).toBe(200);
    expect(answered.json().data.answer).toEqual({ optionId: "supply", secretSupplied: true });
    expect(await secrets.get("GIT_HOST_TOKEN")).toBe(SECRET);
    for (const url of ["/api/decisions", `/api/decisions/${id}`, "/api/decisions/summary"]) {
      expect((await app.inject({ url })).body).not.toContain(SECRET);
    }
    expect(answered.body).not.toContain(SECRET);

    const id2 = (await post(app, "/api/decisions", { ...token, key: "second" })).json().data.decision.id;
    const misplaced = await post(app, `/api/decisions/${id2}/answer`, { optionId: "later", secret: SECRET }, browser);
    expect(misplaced.statusCode).toBe(400);
    expect(misplaced.body).not.toContain(SECRET);
    const typo = await post(app, `/api/decisions/${id2}/answer`, { optionId: "supply", secrets: SECRET }, browser);
    expect(typo.statusCode).toBe(400);
    expect(typo.body).not.toContain(SECRET);
    const withNote = await post(app, `/api/decisions/${id2}/answer`, { optionId: "later", note: "soon" }, browser);
    expect(withNote.statusCode).toBe(400);
  });

  it("validates ids, queries and bodies", async () => {
    const { app, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    expect((await app.inject({ url: "/api/decisions/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/decisions/${UNKNOWN_ID}` })).statusCode).toBe(404);
    expect((await post(app, "/api/decisions/..%2F..%2Fetc/answer", { optionId: "x" }, browser)).statusCode).toBe(400);
    expect((await post(app, `/api/decisions/${UNKNOWN_ID}/answer`, { optionId: "x" }, browser)).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/decisions?status=bogus" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/decisions?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/decisions?project=../etc" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/decisions?project=no-such-project" })).statusCode).toBe(400);

    const inBody = await post(app, "/api/decisions", { ...budget, project: "example" });
    expect(inBody.statusCode).toBe(400);
    expect(inBody.json().error).toBe("Invalid decision: pass the project as ?project=, not in the body");
    const badKind = await post(app, "/api/decisions", { ...budget, kind: "whatever" });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error).toMatch(/^Invalid decision: kind: /);
    expect((await post(app, "/api/decisions", [budget])).statusCode).toBe(400);
  });

  it("answers 429 once a module has the maximum number of open decisions", async () => {
    const { app } = await build({ maxOpenPerSource: 1 });
    expect((await post(app, "/api/decisions", budget)).statusCode).toBe(201);
    const capped = await post(app, "/api/decisions", { ...budget, key: "another" });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error).toContain("the limit is 1");
    expect((await post(app, "/api/decisions", budget)).statusCode).toBe(200);
  });

  it("refuses cross-site requests with 403 before anything else", async () => {
    const { app, inbox, answerToken } = await build();
    const browser = await unlock(app, answerToken);
    const id = (await post(app, "/api/decisions", budget)).json().data.decision.id;
    const evil = { ...browser, origin: "http://attacker.example", "sec-fetch-site": "cross-site" };
    const answer = { optionId: "approve", confirm: true };
    expect((await post(app, `/api/decisions/${id}/answer`, answer, evil)).statusCode).toBe(403);
    expect((await post(app, "/api/decisions", { ...budget, key: "x" }, evil)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/decisions", headers: evil })).statusCode).toBe(403);
    expect(inbox.get(id)?.status).toBe("open");
    const local = { ...browser, origin: "http://localhost:5173" };
    expect((await post(app, `/api/decisions/${id}/answer`, answer, local)).statusCode).toBe(200);
  });

  it("summarises open and overdue decisions without changing them, and names the secret store", async () => {
    const { app, clock, inbox } = await build();
    const expiring = await post(app, "/api/decisions", { ...budget, expiresAt: "2026-03-02T13:00:00Z" });
    await post(app, "/api/decisions", { ...budget, key: "later" });
    clock.t += 2 * 60 * 60 * 1000;
    const summary = (await app.inject({ url: "/api/decisions/summary" })).json();
    expect(summary.data).toEqual({
      open: 2,
      overdue: 1,
      secretStore: "server memory only (never written to disk; asked again after a restart)",
    });
    const list = (await app.inject({ url: "/api/decisions" })).json();
    expect(list.data[0]).toMatchObject({ overdue: true, status: "open" });
    // Reads leave expiry to the sweep: no overdue mark in the audit trail yet
    const id = expiring.json().data.decision.id;
    expect(inbox.get(id)?.audit?.map((a) => a.action)).toEqual(["raised"]);
    await inbox.sweep();
    expect(inbox.get(id)?.audit?.map((a) => a.action)).toEqual(["raised", "overdue"]);
  });
});
