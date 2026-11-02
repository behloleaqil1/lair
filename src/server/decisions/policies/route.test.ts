/**
 * mountDecisionPolicies, as src/server/index.ts calls it: off unless data/server.yaml sets
 * decision_policies.enabled, and GET /api/owner/decision-policies, the owner's read of the table and the agreement.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../../human-auth/index.js";
import { parseServerConfig } from "../../restart/server-config.js";
import { DecisionInbox } from "../service.js";
import { DecisionStore } from "../store.js";
import { MemorySecretStore } from "../secrets.js";
import type { RaiseDecisionInput } from "../types.js";
import { mountDecisionPolicies, parseDecisionPoliciesConfig } from "./index.js";

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const ON = "decision_policies:\n  enabled: true\n";
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const stores: DecisionStore[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function limit(key: string): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "escalation",
    title: "Every profile is rate limited",
    context: "Rate limited.",
    options: [
      { id: "wait", label: "Wait", consequences: "Waits.", effect: "reversible" },
      { id: "stop", label: "Stop", consequences: "Stops.", effect: "frees_task" },
    ],
    recommended: { optionId: "wait", reasoning: "It clears by itself." },
    source: { module: "agents", ref: "chain:1" },
    key,
    class: "agents.provider_limit",
    evidence: { code: "provider_rate_limit", facts: { agent: "agent-a" }, cause_cleared: false, linked_issue: null },
  };
}

/** `serverYaml`: data/server.yaml (undefined: no file). `before`: decisions raised before the mount. */
async function server(options: { serverYaml?: string; policiesYaml?: string; before?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lair-policies-route-"));
  dirs.push(dir);
  const policiesPath = join(dir, "policies.yaml");
  if (options.policiesYaml !== undefined) writeFileSync(policiesPath, options.policiesYaml);
  const configPath = join(dir, "server.yaml");
  if (options.serverYaml !== undefined) {
    writeFileSync(configPath, options.serverYaml);
    chmodSync(configPath, 0o600);
  }
  const events = new EventBus();
  const store = new DecisionStore(":memory:");
  stores.push(store);
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events });
  for (let i = 0; i < (options.before ?? 0); i++) await inbox.raise(limit(`before-${i}`));
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const evidence: boolean[] = [];
  const logs: string[] = [];
  const policies = await mountDecisionPolicies(app, {
    configPath,
    policiesPath,
    inbox,
    events,
    humanAuth: auth,
    evidenceProducers: [{ useEvidenceUpdates: (on) => evidence.push(on) }],
    log: (line) => logs.push(line),
  });
  await app.ready();
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
  const get = async () => (await app.inject({ url: "/api/owner/decision-policies", headers: owner })).json().data;
  return { app, owner, inbox, policies, evidence, logs, get };
}

describe("decision policies: off by default", () => {
  for (const [name, yaml] of [
    ["without data/server.yaml", undefined],
    ["without the section", "server: {}\n"],
    ["with the section disabled", "decision_policies:\n  enabled: false\n"],
    ["with a refused section", "decision_policies:\n  enabled: yes please\n"],
  ] as const) {
    it(`${name}: no proposal is traced, none at start, no evidence updates, and the route says it is off`, async () => {
      const h = await server({ serverYaml: yaml, before: 2 });
      expect(await h.policies.caughtUp).toBe(0);
      await h.inbox.raise(limit("after"));
      expect(h.inbox.policyTraces()).toEqual([]);
      expect(h.evidence).toEqual([]);
      const data = await h.get();
      expect(data).toMatchObject({ enabled: false, source: "built-in", agreement: [] });
      expect(data.policies).toHaveLength(5);
      if (yaml?.includes("yes please")) {
        expect(data.errors.join(" ")).toContain("decision_policies.enabled");
        expect(h.logs.join(" ")).toContain("decision policies off");
      } else {
        expect(data.errors).toEqual([]);
      }
    });
  }

  it("on: traces each raised decision, catches up on those raised before, and turns evidence updates on until close", async () => {
    const h = await server({ serverYaml: ON, before: 2 });
    expect(await h.policies.caughtUp).toBe(2);
    await h.inbox.raise(limit("after"));
    expect(h.inbox.policyTraces().map((t) => t.policy)).toEqual(["c1-wait", "c1-wait", "c1-wait"]);
    expect(h.evidence).toEqual([true]);
    const data = await h.get();
    expect(data).toMatchObject({ enabled: true, errors: [] });
    expect(data.agreement).toMatchObject([{ class: "agents.provider_limit", traced: 3, pending: 3 }]);
    await h.app.close();
    apps.splice(apps.indexOf(h.app), 1);
    expect(h.evidence).toEqual([true, false]);
    // closed: a decision raised now is not traced
    await h.inbox.raise(limit("closed"));
    expect(h.inbox.policyTraces()).toHaveLength(3);
  });

  it("parses the section; the restart's own reading of data/server.yaml accepts it", () => {
    expect(parseDecisionPoliciesConfig({})).toEqual({ ok: true, settings: { enabled: false } });
    expect(parseDecisionPoliciesConfig({ decision_policies: null })).toEqual({ ok: true, settings: { enabled: false } });
    expect(parseDecisionPoliciesConfig({ decision_policies: {} })).toEqual({ ok: true, settings: { enabled: false } });
    expect(parseDecisionPoliciesConfig({ decision_policies: { enabled: true } })).toEqual({ ok: true, settings: { enabled: true } });
    expect(parseDecisionPoliciesConfig({ decision_policies: { enabled: true, mode: "act" } })).toMatchObject({ ok: false, settings: { enabled: false } });
    expect(parseServerConfig({ server: {}, decision_policies: { enabled: true } }).ok).toBe(true);
  });
});

describe("decision policies route", () => {
  it("is the owner's: anyone else gets 403", async () => {
    const { app } = await server({ serverYaml: ON });
    expect((await app.inject({ url: "/api/owner/decision-policies", headers: BROWSER })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/owner/decision-policies" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("shows the built-in table, in shadow, with no agreement before anything is traced", async () => {
    const { app, owner } = await server({ serverYaml: ON });
    const res = await app.inject({ url: "/api/owner/decision-policies", headers: owner });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.enabled).toBe(true);
    expect(data.source).toBe("built-in");
    expect(data.errors).toEqual([]);
    expect(data.policies.map((p: { id: string }) => p.id)).toEqual(["c1-wait", "c2-noted", "c3-stand-down", "c4-stand-down", "c11-keep-held"]);
    expect(data.policies.every((p: { state: string }) => p.state === "shadow")).toBe(true);
    expect(data.agreement).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a bad file shows its errors and proposes nothing", async () => {
    const h = await server({
      serverYaml: ON,
      policiesYaml: "version: 1\npolicies:\n  - id: x\n    class: nope.nope\n    answer: a\n    reason_code: r\n    state: act\n    max_tier: 1\n",
    });
    await h.inbox.raise(limit("a"));
    const data = await h.get();
    expect(data.source).toBe("file");
    expect(data.policies).toEqual([]);
    expect(data.errors).toHaveLength(1);
    expect(h.inbox.policyTraces()).toEqual([]);
  });

  it("there is no route that changes anything", async () => {
    const { app, owner } = await server({ serverYaml: ON });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/api/owner/decision-policies", headers: owner, payload: {} })).statusCode).toBe(404);
    }
  });
});
