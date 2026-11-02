/**
 * Acceptance (docs/design/deploy-aws.md §7.1): a change with an external data
 * source is refused before plan. Entry points: the manager's guardPlan (what
 * the OpenTofu runner calls) and the HTTP routes, over real directories. The
 * only fake is the plan runner, the boundary to the tool that does not exist yet.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { InfraPolicyManager } from "./service.js";
import { registerInfraPolicyRoutes } from "./routes.js";

const PROJECT = "example"; // shipped in projects/, so the root ?project= guard knows it
const BROWSER = { host: "127.0.0.1:4777", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
const AWS = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\n`;

const dirs: string[] = [];
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "infra-policy-acc-"));
  dirs.push(dir);
  mkdirSync(join(dir, "stack"));
  writeFileSync(join(dir, "stack", "main.tf"), code);
  return join(dir, "stack");
}

function manager(path: string, extra: Record<string, unknown> = { enabled: true }): InfraPolicyManager {
  const m = new InfraPolicyManager();
  m.load([
    {
      name: PROJECT,
      config: { infra_policy: { roots: [path], allowed_providers: ["hashicorp/aws"], ...extra } },
    },
  ]);
  return m;
}

describe("a change is scanned before plan", () => {
  it("refuses an external data source and never starts the plan", async () => {
    const path = root(AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`);
    let planned = 0;
    const m = manager(path, { enabled: true, allowed_providers: ["hashicorp/aws", "hashicorp/external"] });
    const out = await m.get(PROJECT)!.guardPlan(path, async () => ++planned);
    expect(planned).toBe(0);
    expect(out).toMatchObject({ status: "refused", message: "policy violation: denied-external-data" });
  });

  it("refuses an external data source written with an escape, before plan", async () => {
    const path = root(`data "\\u0065xternal" "token" {\n  program = ["sh", "-c", "env"]\n}\n`);
    let planned = 0;
    const m = manager(path, { enabled: true, allowed_providers: ["hashicorp/aws", "hashicorp/external"] });
    const out = await m.get(PROJECT)!.guardPlan(path, async () => ++planned);
    expect(planned).toBe(0);
    expect(out).toMatchObject({ status: "refused", message: "policy violation: denied-external-data" });
  });

  it("refuses an unlocked provider source before plan", async () => {
    const path = root(`terraform {\n  required_providers {\n    evil = { source = "someone/evil" }\n  }\n}\n`);
    let planned = 0;
    const out = await manager(path).get(PROJECT)!.guardPlan(path, async () => ++planned);
    expect(planned).toBe(0);
    expect(out).toMatchObject({ status: "refused", message: "policy violation: provider-not-allowed" });
  });

  it("runs the plan for code that passes", async () => {
    const path = root(AWS + `resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`);
    const out = await manager(path).get(PROJECT)!.guardPlan(path, async () => "planned");
    expect(out).toMatchObject({ status: "planned", result: "planned" });
  });

  it("only scans configured roots", async () => {
    const path = root(AWS);
    await expect(manager(path).get(PROJECT)!.guardPlan("/tmp", async () => 1)).rejects.toThrow("not a configured root");
  });

  it("is off by default: no policy exists unless enabled", () => {
    const path = root(AWS);
    const m = manager(path, {});
    expect(m.get(PROJECT)).toBeUndefined();
    expect(m.requires(PROJECT)).toBe(false);
    expect(m.status(PROJECT)).toEqual({ enabled: false, errors: [] });
  });

  it("is off when the block says enabled: false, even with other errors", () => {
    const m = manager("/srv/x", { enabled: false, typo: 1 });
    expect(m.get(PROJECT)).toBeUndefined();
    expect(m.requires(PROJECT)).toBe(false);
  });
});

describe("an invalid infra_policy block never turns the scan off", () => {
  it.each([
    ["a typo key", { enabled: true, allowed_provider: ["hashicorp/aws"] }],
    ["a typo in enabled", { enable: true }],
    ["a relative root", { enabled: true, roots: ["infra"] }],
    ["enabled without roots", { enabled: true, roots: [] }],
    ["a bad allow entry", { enabled: true, allow: ["data.http.health"] }],
  ])("%s: every plan is refused and never started", async (_name, block) => {
    const path = root(AWS + `resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`);
    const m = new InfraPolicyManager();
    m.load([{ name: PROJECT, config: { infra_policy: { roots: [path], ...block } } }]);
    expect(m.requires(PROJECT)).toBe(true);
    let planned = 0;
    const out = await m.get(PROJECT)!.guardPlan(path, async () => ++planned);
    expect(planned).toBe(0);
    expect(out).toMatchObject({ status: "refused", message: "policy violation: invalid-config" });
    expect(m.status(PROJECT)).toMatchObject({ enabled: true, blocked: true, errors: [expect.stringContaining("infra_policy")] });
  });

  it("an infra_policy that is not an object blocks too", async () => {
    const m = new InfraPolicyManager();
    m.load([{ name: PROJECT, config: { infra_policy: "yes" as unknown as Record<string, unknown> } }]);
    expect(m.requires(PROJECT)).toBe(true);
    expect(await m.get(PROJECT)!.guardPlan("/x", async () => 1)).toMatchObject({ status: "refused" });
  });
});

describe("routes (owner only)", () => {
  /** The routes as src/server/index.ts mounts them, with the owner credential; returns the owner's headers */
  async function serve(m: InfraPolicyManager): Promise<{ app: FastifyInstance; owner: Record<string, string> }> {
    const fastify = Fastify();
    await registerRootGuards(fastify);
    const dir = mkdtempSync(join(tmpdir(), "infra-policy-auth-"));
    dirs.push(dir);
    const tokenPath = join(dir, "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    await registerOwnerRoutes(fastify, auth);
    await registerInfraPolicyRoutes(fastify, m, () => PROJECT, auth);
    await fastify.ready();
    app = fastify;
    const signIn = await fastify.inject({
      method: "POST",
      url: "/api/owner/sessions",
      headers: BROWSER,
      payload: { token: readFileSync(tokenPath, "utf-8").trim() },
    });
    expect(signIn.statusCode).toBe(201);
    return { app: fastify, owner: { ...BROWSER, [OWNER_SESSION_HEADER]: signIn.json().data.session as string } };
  }

  it("scan answers the violations of a configured root to the owner", async () => {
    const path = root(AWS + `data "http" "ip" {\n  url = "https://example.com"\n}\n`);
    const m = manager(path, { enabled: true, allowed_providers: ["hashicorp/aws", "hashicorp/http"] });
    const { app: a, owner } = await serve(m);
    const res = await a.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}&root=${encodeURIComponent(path)}`, headers: owner });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.roots[0]).toMatchObject({ root: path, ok: false, violations: [{ rule: "denied-http-data", address: "data.http.ip" }] });
    expect(body.data.roots[0].violations[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a caller without the owner session, on scan and on status", async () => {
    const path = root(AWS + `data "http" "ip" {\n  url = "https://example.com"\n}\n`);
    const { app: a } = await serve(manager(path));
    for (const url of [`/api/infra-policy/scan?project=${PROJECT}`, `/api/infra-policy/status?project=${PROJECT}`]) {
      const res = await a.inject({ method: "GET", url, headers: BROWSER });
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain("main.tf");
    }
  });

  it("refuses a root that is not configured, and answers 404 when the scan is off", async () => {
    const path = root(AWS);
    const on = await serve(manager(path));
    const unknown = await on.app.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}&root=/etc`, headers: on.owner });
    expect(unknown.statusCode).toBe(400);
    await on.app.close();

    const off = await serve(manager(path, {}));
    const res = await off.app.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}`, headers: off.owner });
    expect(res.statusCode).toBe(404);
    const status = await off.app.inject({ method: "GET", url: `/api/infra-policy/status?project=${PROJECT}`, headers: off.owner });
    expect(status.json().data).toEqual({ enabled: false, errors: [] });
  });

  it("answers 409 on scan, and the errors on status, for a blocked project", async () => {
    const path = root(AWS);
    const { app: a, owner } = await serve(manager(path, { enabled: true, typo: 1 }));
    const scan = await a.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}`, headers: owner });
    expect(scan.statusCode).toBe(409);
    const status = await a.inject({ method: "GET", url: `/api/infra-policy/status?project=${PROJECT}`, headers: owner });
    expect(status.json().data).toMatchObject({ enabled: true, blocked: true, errors: [expect.stringContaining("typo")] });
  });
});
