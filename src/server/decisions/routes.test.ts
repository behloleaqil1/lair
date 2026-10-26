/**
 * The Decision Inbox routes behind the root guards, as in src/server/index.ts:
 * answering only with an owner session in its header, from the dashboard
 * (never a cookie); validated ids and queries, origin checks, confirmation
 * for spend, the open-decision caps, and no secret in any response.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
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

async function build(options: { maxOpenPerSource?: number; maxOpenHttpPerProject?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "lair-decision-routes-"));
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  store = new DecisionStore(":memory:");
  const clock = { t: NOW, now: (): number => clock.t };
  const secrets = new MemorySecretStore();
  const inbox = new DecisionInbox({ store, secrets, clock, ...options });
  app = Fastify();
  registerRootGuards(app);
  await registerOwnerRoutes(app, auth);
  await registerDecisionRoutes(app, inbox, () => "example", auth);
  await app.ready();
  const answerToken = readFileSync(tokenPath, "utf-8").trim();
  return { app, inbox, clock, secrets, auth, answerToken };
}

/** Sign in the way the Decisions view does; returns the browser's headers with its owner session. */
async function unlock(a: FastifyInstance, answerToken: string): Promise<Record<string, string>> {
  const res = await a.inject({ method: "POST", url: "/api/owner/sessions", payload: { token: answerToken }, headers: DASHBOARD });
  expect(res.statusCode).toBe(201);
  expect(res.headers["set-cookie"]).toBeUndefined();
  return { ...DASHBOARD, [OWNER_SESSION_HEADER]: res.json().data.session as string };
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
  it("refuses an answer that is cookie-only, from another origin, without an Origin, or with a forged Sec-Fetch-Site (403, still open)", async () => {
    const { app, inbox, answerToken } = await build();
    const id = (await post(app, "/api/decisions", { ...budget, kind: "other" })).json().data.decision.id;
    const browser = await unlock(app, answerToken);
    const session = browser[OWNER_SESSION_HEADER];
    const answer = { optionId: "approve" };
    const tries = {
      // A local process: no Origin, no session (curl, a script, an agent)
      bare: {},
      // The session as a cookie (what another local listener could get from a port-blind cookie)
      cookieOnly: { ...DASHBOARD, cookie: `lair_owner_session=${session}; ${OWNER_SESSION_HEADER}=${session}` },
      // The dashboard's headers, forged, without a session
      forged: DASHBOARD,
      // The session from another local origin (the app under test, a dev server)
      otherOrigin: { ...browser, origin: "http://localhost:3000" },
      otherPort: { ...browser, origin: "http://localhost:9999" },
      // The session without a browser Origin
      noOrigin: { [OWNER_SESSION_HEADER]: session },
      // A cross-site browser request
      crossSite: { ...browser, "sec-fetch-site": "cross-site" },
      // A guessed session
      guessed: { ...DASHBOARD, [OWNER_SESSION_HEADER]: "g".repeat(43) },
    };
    for (const [name, headers] of Object.entries(tries)) {
      const res = await post(app, `/api/decisions/${id}/answer`, answer, headers as Record<string, string>);
      expect([name, res.statusCode]).toEqual([name, 403]);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(inbox.get(id)).toMatchObject({ status: "open" });
    expect(inbox.get(id)?.audit?.map((a) => a.action)).toEqual(["raised"]);

    const ok = await post(app, `/api/decisions/${id}/answer`, answer, { ...browser, "user-agent": "ExampleBrowser/1.0" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toBeUndefined();
    expect(ok.json().data).toMatchObject({ status: "answered", answeredBy: "owner" });
    expect(ok.json().data.audit[1].detail).toBe("chose approve (Approve); from 127.0.0.1 (ExampleBrowser/1.0)");
  });

  it("refuses a revoked session", async () => {
    const { app, inbox, auth, answerToken } = await build();
    const id = (await post(app, "/api/decisions", { ...budget, kind: "other" })).json().data.decision.id;
    const browser = await unlock(app, answerToken);
    const [session] = auth.listSessions();
    const signOut = await post(app, `/api/owner/sessions/${session.id}/revoke`, undefined, browser);
    expect(signOut.statusCode).toBe(200);
    const res = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve" }, browser);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("not valid");
    expect(inbox.get(id)?.status).toBe("open");
  });

  it("refuses an answer before reading its body", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: `/api/decisions/${UNKNOWN_ID}/answer`,
      payload: "{not json",
      headers: { ...DASHBOARD, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
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

describe("raising over HTTP", () => {
  it("caps open HTTP-raised decisions per project, whatever module they name (429)", async () => {
    const { app, inbox } = await build({ maxOpenHttpPerProject: 2 });
    const as = (module: string, key: string) => ({ ...budget, key, source: { module, ref: "r" } });
    expect((await post(app, "/api/decisions", as("one", "a"))).statusCode).toBe(201);
    expect((await post(app, "/api/decisions", as("two", "b"))).statusCode).toBe(201);
    const capped = await post(app, "/api/decisions", as("three", "c"));
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error).toBe(
      "HTTP callers already have 2 open decisions in example (the limit is 2): wait for answers or withdraw some first",
    );
    // An open key is still answered with its decision; producers inside the server don't count
    expect((await post(app, "/api/decisions", as("one", "a"))).statusCode).toBe(200);
    expect((await inbox.raise({ ...as("watchdog", "inside"), project: "example" } as never)).created).toBe(true);
    expect(inbox.list({ status: "open" }).map((d) => d.raisedVia).sort()).toEqual(["http", "http", "server"]);
  });

  it("refuses links to this machine or a private network", async () => {
    const { app } = await build();
    const res = await post(app, "/api/decisions", {
      ...budget,
      links: [{ label: "Plan", url: "http://localhost:9999/plan" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("links.0.url: must not point at this machine or a private network");
    const ok = await post(app, "/api/decisions", { ...budget, links: [{ label: "Plan", url: "https://example.com/plan" }] });
    expect(ok.statusCode).toBe(201);
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
