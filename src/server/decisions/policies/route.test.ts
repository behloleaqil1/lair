/** GET /api/owner/decision-policies: the owner's, and a read of the table and the agreement. */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../../human-auth/index.js";
import { DecisionInbox } from "../service.js";
import { DecisionStore } from "../store.js";
import { MemorySecretStore } from "../secrets.js";
import { mountDecisionPolicies } from "./index.js";

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const stores: DecisionStore[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(policiesYaml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "lair-policies-route-"));
  dirs.push(dir);
  const policiesPath = join(dir, "policies.yaml");
  if (policiesYaml !== undefined) writeFileSync(policiesPath, policiesYaml);
  const events = new EventBus();
  const store = new DecisionStore(":memory:");
  stores.push(store);
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events });
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await mountDecisionPolicies(app, { policiesPath, inbox, events, humanAuth: auth });
  await app.ready();
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
  return { app, owner };
}

describe("decision policies route", () => {
  it("is the owner's: anyone else gets 403", async () => {
    const { app } = await server();
    expect((await app.inject({ url: "/api/owner/decision-policies", headers: BROWSER })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/owner/decision-policies" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("shows the built-in table, in shadow, with no agreement before anything is traced", async () => {
    const { app, owner } = await server();
    const res = await app.inject({ url: "/api/owner/decision-policies", headers: owner });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.source).toBe("built-in");
    expect(data.errors).toEqual([]);
    expect(data.policies.map((p: { id: string }) => p.id)).toEqual(["c1-wait", "c2-noted", "c3-stand-down", "c4-stand-down", "c11-keep-held"]);
    expect(data.policies.every((p: { state: string }) => p.state === "shadow")).toBe(true);
    expect(data.agreement).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a bad file shows its errors and proposes nothing", async () => {
    const { app, owner } = await server("version: 1\npolicies:\n  - id: x\n    class: nope.nope\n    answer: a\n    reason_code: r\n    state: act\n    max_tier: 1\n");
    const data = (await app.inject({ url: "/api/owner/decision-policies", headers: owner })).json().data;
    expect(data.source).toBe("file");
    expect(data.policies).toEqual([]);
    expect(data.errors).toHaveLength(1);
  });

  it("there is no route that changes anything", async () => {
    const { app, owner } = await server();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/api/owner/decision-policies", headers: owner, payload: {} })).statusCode).toBe(404);
    }
  });
});
