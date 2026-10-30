/**
 * Acceptance (docs/design/deploy-aws.md §2.2 and §7.7): the plan runs with the
 * read-only plan role and cannot read a secret; it runs only after the policy
 * scan passes, on a locked provider set, with egress limited to the configured
 * hosts. Entry points: PlanSandboxManager.plan (what the OpenTofu runner calls)
 * and the HTTP routes, over real directories, the real policy scan and the real
 * lock-file check. Fakes only at the two boundaries: the token service
 * (PlanCredentialIssuer) and the isolated process runner (SandboxSpawner).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { InfraPolicy, InfraPolicyManager } from "../infra-policy/index.js";
import { PlanSandboxManager, registerPlanSandboxRoutes } from "./index.js";
import type { PlanCredentialIssuer, SandboxResult, SandboxSpawner, SandboxSpec } from "./types.js";

const PROJECT = "example"; // shipped in projects/, so the root ?project= guard knows it
const BROWSER = { host: "127.0.0.1:4777", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
const ROLE = "arn:aws:iam::123456789012:role/lair-plan";
const AWS = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`;
const LOCK = `provider "registry.opentofu.org/hashicorp/aws" {\n  version = "5.40.0"\n  hashes = [\n    "h1:abcdefghijklmnopqrstuv=",\n    "zh:0123456789abcdef0123",\n  ]\n}\n`;
const CREDS = { accessKeyId: "ASIAPLANROLEKEY", secretAccessKey: "plan-role-secret-value", sessionToken: "plan-role-session-token", expiresAt: "2026-10-30T12:15:00.000Z" };

class FakeIssuer implements PlanCredentialIssuer {
  requests: Parameters<PlanCredentialIssuer["issue"]>[0][] = [];
  fail = false;
  async issue(req: Parameters<PlanCredentialIssuer["issue"]>[0]) {
    this.requests.push(req);
    if (this.fail) throw new Error("denied");
    return CREDS;
  }
}

class FakeSpawner implements SandboxSpawner {
  specs: SandboxSpec[] = [];
  /** The files the copy had when each step started */
  seen: string[][] = [];
  results: SandboxResult[] = [];
  async run(spec: SandboxSpec): Promise<SandboxResult> {
    this.specs.push(spec);
    this.seen.push(readdirSync(spec.workdir));
    return this.results.shift() ?? { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
  }
}

const dirs: string[] = [];
let app: FastifyInstance | null = null;
const savedEnv = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, {
    LAIR_SECRET_TOKEN: "control-plane-token",
    AWS_ACCESS_KEY_ID: "AKIAAPPLYROLEKEY",
    AWS_SECRET_ACCESS_KEY: "apply-role-secret",
    DATABASE_URL: "postgres://user:pw@db/app",
  });
});
afterEach(async () => {
  await app?.close();
  app = null;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(code: string, lock: string | null = LOCK, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-sandbox-acc-"));
  dirs.push(dir);
  const stack = join(dir, "stack");
  mkdirSync(stack);
  writeFileSync(join(stack, "main.tf"), code);
  if (lock !== null) writeFileSync(join(stack, ".terraform.lock.hcl"), lock);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(stack, name), content);
  return stack;
}

interface Rig {
  sandbox: PlanSandboxManager;
  issuer: FakeIssuer;
  spawner: FakeSpawner;
  infra: InfraPolicyManager;
}

function rig(path: string, sandboxBlock: Record<string, unknown> | undefined, infra?: InfraPolicyManager): Rig {
  const policy = infra ?? new InfraPolicyManager();
  if (!infra) policy.load([{ name: PROJECT, config: { infra_policy: { enabled: true, roots: [path], allowed_providers: ["hashicorp/aws"] } } }]);
  const issuer = new FakeIssuer();
  const spawner = new FakeSpawner();
  const sandbox = new PlanSandboxManager({ spawner, issuer, infra: policy, now: () => new Date("2026-10-30T12:00:00.000Z") });
  const block = sandboxBlock && {
    enabled: true,
    plan_role_arn: ROLE,
    external_id: "lair-ext-1",
    image: "plan-runner:1",
    plugin_dir: "/srv/mirror",
    provider_api_hosts: ["*.amazonaws.com"],
    ...sandboxBlock,
  };
  sandbox.load([{ name: PROJECT, config: block ? { plan_sandbox: block } : {} }]);
  return { sandbox, issuer, spawner, infra: policy };
}

describe("the plan runs with the read-only plan role", () => {
  it("assumes only the configured role for 15 minutes and hands the sandbox those credentials", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    const out = await r.sandbox.get(PROJECT)!.plan(path);
    expect(out).toMatchObject({ status: "planned", changes: false, credentialsExpireAt: CREDS.expiresAt });
    expect(r.issuer.requests).toEqual([
      { roleArn: ROLE, externalId: "lair-ext-1", sessionName: "lair-plan-example", seconds: 900, region: "us-east-1" },
    ]);
    expect(r.spawner.specs).toHaveLength(2);
    for (const spec of r.spawner.specs) {
      expect(spec.env.AWS_ACCESS_KEY_ID).toBe(CREDS.accessKeyId);
      expect(spec.env.AWS_SECRET_ACCESS_KEY).toBe(CREDS.secretAccessKey);
      expect(spec.env.AWS_SESSION_TOKEN).toBe(CREDS.sessionToken);
    }
  });

  it("runs init from the mirror with a read-only lock file, then plan without taking a state lock", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    await r.sandbox.get(PROJECT)!.plan(path);
    expect(r.spawner.specs[0]!.argv).toEqual(["tofu", "init", "-input=false", "-no-color", "-lockfile=readonly", "-plugin-dir=/plugins"]);
    expect(r.spawner.specs[0]!.pluginDir).toBe("/srv/mirror");
    expect(r.spawner.specs[1]!.argv).toEqual(["tofu", "plan", "-input=false", "-no-color", "-lock=false", "-detailed-exitcode"]);
  });

  it("reports changes (exit 2) and a failed plan (exit 1)", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    r.spawner.results.push({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, { exitCode: 2, stdout: "Plan: 1 to add", stderr: "", timedOut: false });
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "planned", changes: true, output: "Plan: 1 to add" });
    r.spawner.results.push({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, { exitCode: 1, stdout: "", stderr: "Error: nope", timedOut: false });
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "failed", reason: "plan" });
  });

  it("limits every step to the role's remaining life", async () => {
    const path = root(AWS);
    const r = rig(path, { timeout_seconds: 900 });
    await r.sandbox.get(PROJECT)!.plan(path);
    // now is 12:00:00 and the credentials end at 12:15:00: 900 s at most
    expect(r.spawner.specs.every((s) => s.timeoutMs <= 900_000)).toBe(true);
    const short = rig(path, { timeout_seconds: 60 });
    await short.sandbox.get(PROJECT)!.plan(path);
    expect(short.spawner.specs.every((s) => s.timeoutMs === 60_000)).toBe(true);
  });

  it("fails without running anything when the role cannot be assumed", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    r.issuer.fail = true;
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "failed", reason: "credentials" });
    expect(r.spawner.specs).toHaveLength(0);
  });
});

describe("the plan cannot read a secret", () => {
  it("gets an environment of the plan role and fixed settings only, none of Lair's own", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    await r.sandbox.get(PROJECT)!.plan(path);
    for (const spec of r.spawner.specs) {
      expect(Object.keys(spec.env).sort()).toEqual([
        "AWS_ACCESS_KEY_ID", "AWS_EC2_METADATA_DISABLED", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
        "CHECKPOINT_DISABLE", "HOME", "PATH", "TF_INPUT", "TF_IN_AUTOMATION",
      ]);
      const everything = JSON.stringify(spec);
      for (const secret of ["control-plane-token", "AKIAAPPLYROLEKEY", "apply-role-secret", "postgres://user:pw@db/app"]) {
        expect(everything).not.toContain(secret);
      }
      expect(spec.env.AWS_ACCESS_KEY_ID).not.toBe("AKIAAPPLYROLEKEY");
    }
  });

  it("copies the code without state files, .env files, .git or .terraform", async () => {
    const path = root(AWS, LOCK, { "terraform.tfstate": '{"secret":"x"}', ".env": "TOKEN=1", ".env.production": "TOKEN=2", "terraform.tfstate.backup": "{}" });
    mkdirSync(join(path, ".git"));
    writeFileSync(join(path, ".git", "config"), "x");
    mkdirSync(join(path, ".terraform"));
    const r = rig(path, {});
    await r.sandbox.get(PROJECT)!.plan(path);
    expect(r.spawner.seen[0]!.sort()).toEqual([".terraform.lock.hcl", "main.tf"]);
    expect(r.spawner.specs[0]!.workdir).not.toBe(path);
  });

  it("removes the private copy when the run ends, also when the plan fails", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    r.spawner.results.push({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false });
    await r.sandbox.get(PROJECT)!.plan(path);
    expect(existsSync(r.spawner.specs[0]!.workdir)).toBe(false);
  });

  it("never shows the plan role's credentials in the output", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    r.spawner.results.push({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, { exitCode: 0, stdout: `token ${CREDS.sessionToken} key ${CREDS.accessKeyId}`, stderr: `secret ${CREDS.secretAccessKey}`, timedOut: false });
    const out = await r.sandbox.get(PROJECT)!.plan(path);
    expect(JSON.stringify(out)).not.toContain(CREDS.sessionToken);
    expect(JSON.stringify(out)).not.toContain(CREDS.secretAccessKey);
    expect(JSON.stringify(out)).not.toContain(CREDS.accessKeyId);
    expect(out).toMatchObject({ status: "planned", output: expect.stringContaining("[redacted]") });
  });

  it("cuts a long output", async () => {
    const path = root(AWS);
    const r = rig(path, { max_output_bytes: 1024 });
    r.spawner.results.push({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, { exitCode: 0, stdout: "x".repeat(5000), stderr: "", timedOut: false });
    const out = await r.sandbox.get(PROJECT)!.plan(path);
    expect(out).toMatchObject({ status: "planned" });
    expect((out as { output: string }).output.length).toBeLessThan(1100);
  });
});

describe("network egress is limited to the configured hosts", () => {
  it("passes the provider API and registry hosts, and the egress network, to the runner", async () => {
    const path = root(AWS);
    const r = rig(path, { registry_hosts: ["registry.opentofu.org"], egress_network: "plan-egress" });
    await r.sandbox.get(PROJECT)!.plan(path);
    expect(r.spawner.specs[0]!.egress).toEqual({ hosts: ["*.amazonaws.com", "registry.opentofu.org"], network: "plan-egress" });
  });

  it("gives the runner no network when none is configured", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    await r.sandbox.get(PROJECT)!.plan(path);
    expect(r.spawner.specs[0]!.egress.network).toBeUndefined();
  });
});

describe("the plan runs only after the policy scan passes", () => {
  it("refuses an external data source before any credential is issued or any process starts", async () => {
    const path = root(AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`);
    const infra = new InfraPolicyManager();
    infra.load([{ name: PROJECT, config: { infra_policy: { enabled: true, roots: [path], allowed_providers: ["hashicorp/aws", "hashicorp/external"] } } }]);
    const r = rig(path, {}, infra);
    const out = await r.sandbox.get(PROJECT)!.plan(path);
    expect(out).toMatchObject({ status: "refused", reason: "policy", message: "policy violation: denied-external-data" });
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("refuses when the project has no policy scan", async () => {
    const path = root(AWS);
    const r = rig(path, {}, new InfraPolicyManager());
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "scan-required" });
    expect(r.issuer.requests).toHaveLength(0);
  });

  it("refuses when the code changed between the copy and the end of the scan", async () => {
    const path = root(AWS);
    class Racing extends InfraPolicyManager {
      override get(project: string) {
        const base = super.get(project) as InfraPolicy;
        let done = false;
        // the scan's own clock is where the code changes under it
        return new InfraPolicy(project, base.settings, undefined, {
          now: () => {
            if (!done) {
              done = true;
              writeFileSync(join(path, "main.tf"), AWS + "# edited while the scan runs\n");
            }
            return Date.now();
          },
        });
      }
    }
    const infra = new Racing();
    infra.load([{ name: PROJECT, config: { infra_policy: { enabled: true, roots: [path], allowed_providers: ["hashicorp/aws"] } } }]);
    const r = rig(path, {}, infra);
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "changed" });
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("only plans configured roots", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    await expect(r.sandbox.get(PROJECT)!.plan("/tmp")).rejects.toThrow("not a configured root");
  });
});

describe("providers are locked", () => {
  it("refuses a root without a lock file, before any credential is issued", async () => {
    const path = root(AWS, null);
    const r = rig(path, {});
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "lock-missing" });
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("refuses a locked provider without verified hashes", async () => {
    const path = root(AWS, `provider "registry.opentofu.org/hashicorp/aws" {\n  version = "5.40.0"\n}\n`);
    const r = rig(path, {});
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "lock-unpinned" });
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("refuses a locked provider that is not on the allowed list", async () => {
    const path = root(AWS, LOCK + `provider "registry.opentofu.org/someone/evil" {\n  version = "1.0.0"\n  hashes = [\n    "h1:abcdefghijklmnopqrstuv=",\n  ]\n}\n`);
    const r = rig(path, {});
    const out = await r.sandbox.get(PROJECT)!.plan(path);
    expect(out).toMatchObject({ status: "refused", reason: "provider-not-allowed", detail: [expect.stringContaining("someone/evil")] });
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("refuses an empty lock file", async () => {
    const path = root(AWS, "# nothing\n");
    const r = rig(path, {});
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "lock-missing" });
  });
});

describe("a failed or slow run", () => {
  it("reports an init failure and a timeout", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    r.spawner.results.push({ exitCode: 1, stdout: "", stderr: "init broke", timedOut: false });
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "failed", reason: "init" });
    expect(r.spawner.specs).toHaveLength(1);
    r.spawner.results.push({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, { exitCode: 1, stdout: "", stderr: "", timedOut: true });
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "failed", reason: "timeout" });
  });
});

describe("off by default", () => {
  it("has no sandbox unless enabled", () => {
    const path = root(AWS);
    expect(rig(path, undefined).sandbox.get(PROJECT)).toBeUndefined();
    expect(rig(path, undefined).sandbox.status(PROJECT)).toEqual({ enabled: false, errors: [] });
  });

  it("is off when the block says enabled: false, even with other errors", () => {
    const m = new PlanSandboxManager({ spawner: new FakeSpawner(), issuer: new FakeIssuer(), infra: new InfraPolicyManager() });
    m.load([{ name: PROJECT, config: { plan_sandbox: { enabled: false, typo: 1 } } }]);
    expect(m.get(PROJECT)).toBeUndefined();
  });

  it.each([
    ["a typo key", { typo: 1 }],
    ["enabled without a role", { plan_role_arn: undefined }],
    ["a role that is not an ARN", { plan_role_arn: "admin" }],
    ["enabled without a provider mirror", { plugin_dir: undefined }],
    ["a relative provider mirror", { plugin_dir: "mirror" }],
    ["a timeout longer than the role's life", { timeout_seconds: 901 }],
    ["a bad host", { provider_api_hosts: ["https://api.example.com/"] }],
  ])("an invalid block (%s) refuses every plan and starts nothing", async (_name, block) => {
    const path = root(AWS);
    const r = rig(path, block);
    expect(r.sandbox.status(PROJECT)).toMatchObject({ enabled: true, blocked: true, errors: [expect.stringContaining("plan_sandbox")] });
    expect(await r.sandbox.get(PROJECT)!.plan(path)).toMatchObject({ status: "refused", reason: "invalid-config" });
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.spawner.specs).toHaveLength(0);
  });
});

describe("routes (owner only)", () => {
  async function serve(r: Rig): Promise<{ app: FastifyInstance; owner: Record<string, string> }> {
    const fastify = Fastify();
    await registerRootGuards(fastify);
    const dir = mkdtempSync(join(tmpdir(), "plan-sandbox-auth-"));
    dirs.push(dir);
    const tokenPath = join(dir, "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    await registerOwnerRoutes(fastify, auth);
    await registerPlanSandboxRoutes(fastify, r.sandbox, () => PROJECT, auth);
    await fastify.ready();
    app = fastify;
    const signIn = await fastify.inject({ method: "POST", url: "/api/owner/sessions", headers: BROWSER, payload: { token: readFileSync(tokenPath, "utf-8").trim() } });
    expect(signIn.statusCode).toBe(201);
    return { app: fastify, owner: { ...BROWSER, [OWNER_SESSION_HEADER]: signIn.json().data.session as string } };
  }

  it("plans a configured root for the owner", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    const { app: a, owner } = await serve(r);
    const res = await a.inject({ method: "POST", url: `/api/plan-sandbox/plan?project=${PROJECT}&root=${encodeURIComponent(path)}`, headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "planned" });
    expect(r.issuer.requests).toHaveLength(1);
  });

  it("refuses a caller without the owner session on both routes, and runs nothing", async () => {
    const path = root(AWS);
    const r = rig(path, {});
    const { app: a } = await serve(r);
    const plan = await a.inject({ method: "POST", url: `/api/plan-sandbox/plan?project=${PROJECT}&root=${encodeURIComponent(path)}`, headers: BROWSER });
    const status = await a.inject({ method: "GET", url: `/api/plan-sandbox/status?project=${PROJECT}`, headers: BROWSER });
    expect(plan.statusCode).toBe(403);
    expect(status.statusCode).toBe(403);
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.spawner.specs).toHaveLength(0);
  });

  it("refuses a root that is not configured, needs a root, and answers 404 when off", async () => {
    const path = root(AWS);
    const on = await serve(rig(path, {}));
    const unknown = await on.app.inject({ method: "POST", url: `/api/plan-sandbox/plan?project=${PROJECT}&root=/etc`, headers: on.owner });
    expect(unknown.statusCode).toBe(400);
    const none = await on.app.inject({ method: "POST", url: `/api/plan-sandbox/plan?project=${PROJECT}`, headers: on.owner });
    expect(none.statusCode).toBe(400);
    await on.app.close();
    const off = await serve(rig(path, undefined));
    const res = await off.app.inject({ method: "POST", url: `/api/plan-sandbox/plan?project=${PROJECT}&root=${encodeURIComponent(path)}`, headers: off.owner });
    expect(res.statusCode).toBe(404);
    const status = await off.app.inject({ method: "GET", url: `/api/plan-sandbox/status?project=${PROJECT}`, headers: off.owner });
    expect(status.json().data).toEqual({ enabled: false, errors: [] });
  });

  it("shows the role, hosts and limits on status, and no credential", async () => {
    const path = root(AWS);
    const { app: a, owner } = await serve(rig(path, { egress_network: "plan-egress" }));
    const res = await a.inject({ method: "GET", url: `/api/plan-sandbox/status?project=${PROJECT}`, headers: owner });
    expect(res.json().data).toMatchObject({ enabled: true, blocked: false, planRoleArn: ROLE, credentialSeconds: 900, egressNetwork: "plan-egress", egressHosts: ["*.amazonaws.com", "registry.opentofu.org"] });
    expect(res.body).not.toContain("lair-ext-1");
  });
});
