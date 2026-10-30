/**
 * Acceptance (docs/design/deploy-aws.md §7.1): a change with an external data
 * source is refused before plan. Entry points: InfraPolicy.guardPlan (what the
 * OpenTofu runner calls) and the HTTP routes, over real directories. The only
 * fake is the plan runner, the boundary to the tool that does not exist yet.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
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
    expect(m.status(PROJECT)).toEqual({ enabled: false, errors: [] });
  });

  it("reports an invalid block and stays off", () => {
    const m = manager("/srv/x", { enabled: true, typo: 1 });
    expect(m.get(PROJECT)).toBeUndefined();
    expect(m.status(PROJECT)).toMatchObject({ enabled: false, errors: [expect.stringContaining("infra_policy")] });
  });
});

describe("routes", () => {
  async function serve(m: InfraPolicyManager): Promise<FastifyInstance> {
    const fastify = Fastify();
    await registerRootGuards(fastify);
    await registerInfraPolicyRoutes(fastify, m, () => PROJECT);
    await fastify.ready();
    app = fastify;
    return fastify;
  }

  it("scan answers the violations of a configured root", async () => {
    const path = root(AWS + `data "http" "ip" {\n  url = "https://example.com"\n}\n`);
    const m = manager(path, { enabled: true, allowed_providers: ["hashicorp/aws", "hashicorp/http"] });
    const res = await (await serve(m)).inject({
      method: "GET",
      url: `/api/infra-policy/scan?project=${PROJECT}&root=${encodeURIComponent(path)}`,
      headers: BROWSER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.roots[0]).toMatchObject({ root: path, ok: false, violations: [{ rule: "denied-http-data", address: "data.http.ip" }] });
  });

  it("refuses a root that is not configured, and answers 404 when the scan is off", async () => {
    const path = root(AWS);
    const on = await serve(manager(path));
    const unknown = await on.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}&root=/etc`, headers: BROWSER });
    expect(unknown.statusCode).toBe(400);
    await on.close();

    const off = await serve(manager(path, {}));
    const res = await off.inject({ method: "GET", url: `/api/infra-policy/scan?project=${PROJECT}`, headers: BROWSER });
    expect(res.statusCode).toBe(404);
    const status = await off.inject({ method: "GET", url: `/api/infra-policy/status?project=${PROJECT}`, headers: BROWSER });
    expect(status.json().data).toEqual({ enabled: false, errors: [] });
  });
});
