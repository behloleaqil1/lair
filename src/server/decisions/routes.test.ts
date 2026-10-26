/**
 * The Decision Inbox routes behind the root guards, as in src/server/index.ts:
 * validated ids and queries, origin checks, confirmation for spend, and no
 * secret in any response.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRootGuards } from "../root-guards.js";
import { registerDecisionRoutes } from "./routes.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import { MemorySecretStore } from "./secrets.js";
import type { DecisionResolution } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SECRET = "example-token-value-0c4e2b9d";
const UNKNOWN_ID = "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b";

let app: FastifyInstance | null = null;
let store: DecisionStore | null = null;

afterEach(async () => {
  await app?.close();
  store?.close();
  app = null;
  store = null;
});

async function build() {
  store = new DecisionStore(":memory:");
  const clock = { t: NOW, now: (): number => clock.t };
  const secrets = new MemorySecretStore();
  const inbox = new DecisionInbox({ store, secrets, clock });
  app = Fastify();
  registerRootGuards(app);
  await registerDecisionRoutes(app, inbox, () => "example");
  await app.ready();
  return { app, inbox, clock, secrets };
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

describe("decision routes", () => {
  it("raise, list open first, detail with audit, answer; the producer resumes", async () => {
    const { app, inbox } = await build();
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
    await post(app, `/api/decisions/${otherId}/answer`, { optionId: "decline" });

    const list = (await app.inject({ url: "/api/decisions" })).json();
    expect(list.data.map((d: { id: string }) => d.id)).toEqual([id, otherId]);
    expect(list.data[0].audit).toBeUndefined();

    const detail = (await app.inject({ url: `/api/decisions/${id}` })).json();
    expect(detail.data.audit.map((a: { action: string }) => a.action)).toEqual(["raised"]);

    const answer = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true, note: "ok" });
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
    const { app } = await build();
    const id = (await post(app, "/api/decisions", budget)).json().data.decision.id;
    const unconfirmed = await post(app, `/api/decisions/${id}/answer`, { optionId: "approve" });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe("confirm: answering a spend decision needs confirm: true");
    expect((await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true })).statusCode).toBe(
      200,
    );
    expect((await post(app, `/api/decisions/${id}/answer`, { optionId: "decline", confirm: true })).statusCode).toBe(
      409,
    );
  });

  it("never returns the secret of a credentials answer", async () => {
    const { app, secrets } = await build();
    const id = (await post(app, "/api/decisions", token)).json().data.decision.id;
    const answered = await post(app, `/api/decisions/${id}/answer`, { optionId: "supply", secret: SECRET });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().data.answer).toEqual({ optionId: "supply", secretSupplied: true });
    expect(await secrets.get("GIT_HOST_TOKEN")).toBe(SECRET);
    for (const url of ["/api/decisions", `/api/decisions/${id}`, "/api/decisions/summary"]) {
      expect((await app.inject({ url })).body).not.toContain(SECRET);
    }
    expect(answered.body).not.toContain(SECRET);

    const id2 = (await post(app, "/api/decisions", { ...token, key: "second" })).json().data.decision.id;
    const misplaced = await post(app, `/api/decisions/${id2}/answer`, { optionId: "later", secret: SECRET });
    expect(misplaced.statusCode).toBe(400);
    expect(misplaced.body).not.toContain(SECRET);
    const typo = await post(app, `/api/decisions/${id2}/answer`, { optionId: "supply", secrets: SECRET });
    expect(typo.statusCode).toBe(400);
    expect(typo.body).not.toContain(SECRET);
  });

  it("withdraws only for the module that raised it", async () => {
    const { app } = await build();
    const id = (await post(app, "/api/decisions", budget)).json().data.decision.id;
    const wrong = await post(app, `/api/decisions/${id}/withdraw`, { module: "planner", reason: "not mine" });
    expect(wrong.statusCode).toBe(403);
    const ok = await post(app, `/api/decisions/${id}/withdraw`, { module: "delivery", reason: "done another way" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ status: "withdrawn", withdrawnReason: "done another way" });
    expect((await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true })).statusCode).toBe(
      409,
    );
    expect((await post(app, `/api/decisions/${id}/withdraw`, { module: "delivery" })).statusCode).toBe(400);
  });

  it("validates ids, queries and bodies", async () => {
    const { app } = await build();
    expect((await app.inject({ url: "/api/decisions/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/decisions/${UNKNOWN_ID}` })).statusCode).toBe(404);
    expect((await post(app, "/api/decisions/..%2F..%2Fetc/answer", { optionId: "x" })).statusCode).toBe(400);
    expect((await post(app, `/api/decisions/${UNKNOWN_ID}/answer`, { optionId: "x" })).statusCode).toBe(404);
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

  it("refuses cross-site requests with 403 before anything else", async () => {
    const { app, inbox } = await build();
    const id = (await post(app, "/api/decisions", budget)).json().data.decision.id;
    const evil = { origin: "http://attacker.example" };
    expect((await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true }, evil)).statusCode).toBe(
      403,
    );
    expect((await post(app, "/api/decisions", { ...budget, key: "x" }, evil)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/decisions", headers: evil })).statusCode).toBe(403);
    expect(inbox.get(id)?.status).toBe("open");
    const local = { origin: "http://localhost:5173" };
    expect((await post(app, `/api/decisions/${id}/answer`, { optionId: "approve", confirm: true }, local)).statusCode).toBe(
      200,
    );
  });

  it("summarises open and overdue decisions and names the secret store", async () => {
    const { app, clock } = await build();
    await post(app, "/api/decisions", { ...budget, expiresAt: "2026-03-02T13:00:00Z" });
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
  });
});
