/**
 * Acceptance (docs/design/deploy-aws.md §2.6, §7.2, §7.3, §7.7): apply runs only
 * the approved plan file, with the apply role; an approval for plan A cannot
 * apply plan B; a stale plan is refused; a failed apply is not rolled back but
 * re-planned. Entry points: TofuRunnerManager (plan, apply) and the HTTP routes,
 * over real directories, the real policy scan, the real lock-file check, the real
 * plan sandbox and the real plan store. Fakes only at the two cloud boundaries:
 * the token service (PlanCredentialIssuer) and the isolated process runner
 * (SandboxSpawner), which stands in for `tofu` by writing and reading the plan
 * file the way `tofu plan -out` and `tofu apply <file>` do.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { InfraPolicyManager } from "../infra-policy/index.js";
import { PlanSandboxManager } from "../plan-sandbox/index.js";
import type { PlanCredentialIssuer, SandboxResult, SandboxSpawner, SandboxSpec } from "../plan-sandbox/types.js";
import { registerTofuRunnerRoutes, sha256, TofuRunnerManager, type BlockedTofuRunner } from "./index.js";

const PROJECT = "example"; // shipped in projects/, so the root ?project= guard knows it
const BROWSER = { host: "127.0.0.1:4777", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
const PLAN_ROLE = "arn:aws:iam::123456789012:role/lair-plan";
const APPLY_ROLE = "arn:aws:iam::123456789012:role/lair-apply";
const AWS = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`;
const LOCK = `provider "registry.opentofu.org/hashicorp/aws" {\n  version = "5.40.0"\n  hashes = [\n    "h1:abcdefghijklmnopqrstuv=",\n    "zh:0123456789abcdef0123",\n  ]\n}\n`;
const PLAN_CREDS = { accessKeyId: "ASIAPLANROLEKEY", secretAccessKey: "plan-role-secret-value", sessionToken: "plan-role-session-token", expiresAt: "2026-10-30T12:15:00.000Z" };
const APPLY_CREDS = { accessKeyId: "ASIAAPPLYROLEKEY", secretAccessKey: "apply-role-secret-value", sessionToken: "apply-role-session-token", expiresAt: "2026-10-30T13:00:00.000Z" };
const NOW = "2026-10-30T12:00:00.000Z";

class FakeIssuer implements PlanCredentialIssuer {
  requests: Parameters<PlanCredentialIssuer["issue"]>[0][] = [];
  async issue(req: Parameters<PlanCredentialIssuer["issue"]>[0]) {
    this.requests.push(req);
    return req.roleArn === APPLY_ROLE ? APPLY_CREDS : PLAN_CREDS;
  }
}

/** Stands in for the `tofu` binary in the container */
class FakeTofu implements SandboxSpawner {
  specs: SandboxSpec[] = [];
  /** What `tofu plan -out` writes; change it between plans to make a different plan */
  planContent = "plan-file-v1";
  planExit = 2;
  /** What `tofu show -json` reports for the plan: each resource and what the plan does to it */
  resourceChanges: { address: string; actions: string[] }[] = [{ address: "aws_s3_bucket.logs", actions: ["create"] }];
  showExit = 0;
  showStdout: string | undefined;
  /** Exit and stderr of `tofu apply` */
  applyExit = 0;
  applyStderr = "";
  /** What `tofu apply` found in its working directory */
  applied: string[] = [];
  async run(spec: SandboxSpec): Promise<SandboxResult> {
    this.specs.push(spec);
    const [, verb] = spec.argv;
    const ok = (exitCode = 0, stderr = ""): SandboxResult => ({ exitCode, stdout: "", stderr, timedOut: false });
    if (verb === "plan") {
      const out = spec.argv.find((a) => a.startsWith("-out="));
      if (out && this.planExit === 2) writeFileSync(join(spec.workdir, out.slice(5)), this.planContent);
      return { exitCode: this.planExit, stdout: this.planExit === 2 ? "Plan: 1 to add" : "No changes", stderr: "", timedOut: false };
    }
    if (verb === "show") {
      const stdout = this.showStdout ?? JSON.stringify({ format_version: "1.2", resource_changes: this.resourceChanges.map((c) => ({ address: c.address, change: { actions: c.actions } })) });
      return { exitCode: this.showExit, stdout: this.showExit === 0 ? stdout : "", stderr: this.showExit === 0 ? "" : "Error: unreadable plan", timedOut: false };
    }
    if (verb === "apply") {
      await new Promise((r) => setTimeout(r, 5));
      this.applied.push(readFileSync(join(spec.workdir, spec.argv[spec.argv.length - 1]!), "utf8"));
      return ok(this.applyExit, this.applyStderr);
    }
    return ok();
  }
  verbs(): string[] {
    return this.specs.map((s) => s.argv[1]!);
  }
}

const dirs: string[] = [];
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function root(code = AWS): string {
  const stack = join(tmp("tofu-runner-acc-"), "stack");
  mkdirSync(stack);
  writeFileSync(join(stack, "main.tf"), code);
  writeFileSync(join(stack, ".terraform.lock.hcl"), LOCK);
  return stack;
}

interface Rig {
  runner: TofuRunnerManager;
  issuer: FakeIssuer;
  tofu: FakeTofu;
  planDir: string;
}

function rig(path: string, runnerBlock: Record<string, unknown> | undefined, opts: { sandbox?: boolean } = {}): Rig {
  const planDir = join(tmp("tofu-runner-plans-"), "plans");
  const infra = new InfraPolicyManager();
  infra.load([{ name: PROJECT, config: { infra_policy: { enabled: true, roots: [path], allowed_providers: ["hashicorp/aws"] } } }]);
  const issuer = new FakeIssuer();
  const tofu = new FakeTofu();
  const sandbox = new PlanSandboxManager({ spawner: tofu, issuer, infra, now: () => new Date(NOW) });
  const sandboxBlock = opts.sandbox === false ? {} : { plan_sandbox: { enabled: true, plan_role_arn: PLAN_ROLE, external_id: "lair-ext-1", image: "plan-runner:1", plugin_dir: "/srv/mirror" } };
  const config = { ...sandboxBlock, ...(runnerBlock ? { tofu_runner: { enabled: true, mode: "act", apply_role_arn: APPLY_ROLE, external_id: "lair-apply-ext", state_bucket: "lair-state-123456789012", environments: ["staging", "production"], plan_dir: planDir, ...runnerBlock } } : {}) };
  sandbox.load([{ name: PROJECT, config }]);
  const runner = new TofuRunnerManager({ sandbox, now: () => new Date(NOW) });
  runner.load([{ name: PROJECT, config }]);
  return { runner, issuer, tofu, planDir };
}

function get(r: Rig) {
  const runner = r.runner.get(PROJECT);
  if (!runner) throw new Error("no runner");
  return runner;
}

async function serveRoutes(r: Rig): Promise<{ app: FastifyInstance; owner: Record<string, string> }> {
  const fastify = Fastify();
  await registerRootGuards(fastify);
  const tokenPath = join(tmp("tofu-runner-auth-"), "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(fastify, auth);
  await registerTofuRunnerRoutes(fastify, r.runner, () => PROJECT, auth);
  await fastify.ready();
  app = fastify;
  const signIn = await fastify.inject({ method: "POST", url: "/api/owner/sessions", headers: BROWSER, payload: { token: readFileSync(tokenPath, "utf-8").trim() } });
  expect(signIn.statusCode).toBe(201);
  return { app: fastify, owner: { ...BROWSER, [OWNER_SESSION_HEADER]: signIn.json().data.session as string } };
}

type Planned = { status: "planned"; changes: true; planId: string; planHash: string };
async function planned(r: Rig, path: string, env = "staging"): Promise<Planned> {
  const out = await get(r).plan(path, env);
  expect(out).toMatchObject({ status: "planned", changes: true });
  return out as Planned;
}

describe("plan: state in S3 with native locking, the plan kept for approval", () => {
  it("reads the state of the environment from the bucket and writes the plan to a file", async () => {
    const path = root();
    const r = rig(path, {});
    const out = await planned(r, path);
    const init = r.tofu.specs[0]!.argv;
    expect(init).toEqual(expect.arrayContaining([
      "-backend-config=bucket=lair-state-123456789012",
      "-backend-config=key=example/staging/terraform.tfstate",
      "-backend-config=region=us-east-1",
      "-backend-config=use_lockfile=true",
      "-backend-config=encrypt=true",
    ]));
    expect(r.tofu.specs[1]!.argv).toEqual(["tofu", "plan", "-input=false", "-no-color", "-lock=false", "-detailed-exitcode", "-out=lair.tfplan"]);
    // the plan runs with the read-only plan role only
    expect(r.issuer.requests.map((q) => q.roleArn)).toEqual([PLAN_ROLE]);
    expect(out.planHash).toBe(sha256(Buffer.from("plan-file-v1")));
  });

  it("keeps a separate state file per environment", async () => {
    const path = root();
    const r = rig(path, {});
    await planned(r, path, "production");
    expect(r.tofu.specs[0]!.argv).toContain("-backend-config=key=example/production/terraform.tfstate");
  });

  it("keeps no plan when there are no changes, and refuses an environment that is not configured", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.planExit = 0;
    expect(await get(r).plan(path, "staging")).toMatchObject({ status: "planned", changes: false });
    expect(existsSync(r.planDir) ? readdirSync(r.planDir) : []).toEqual([]);
    await expect(get(r).plan(path, "qa")).rejects.toThrow("not a configured environment");
  });

  it("goes through the policy scan: an external data source ends the run before any credential", async () => {
    const path = root(AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`);
    const r = rig(path, {});
    expect(await get(r).plan(path, "staging")).toMatchObject({ status: "refused", reason: "policy" });
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.tofu.specs).toHaveLength(0);
  });
});

describe("apply runs only the approved plan file, with the apply role", () => {
  it("applies the exact bytes that were planned, assuming the apply role for 1 hour", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    r.tofu.planContent = "something-else-written-later";
    const out = await get(r).apply(p.planId, p.planHash);
    expect(out).toMatchObject({ status: "applied" });
    expect(r.tofu.applied).toEqual(["plan-file-v1"]);
    expect(r.tofu.specs.at(-1)!.argv).toEqual(["tofu", "apply", "-input=false", "-no-color", "-lock-timeout=60s", "lair.tfplan"]);
    const apply = r.issuer.requests.at(-1)!;
    expect(apply).toMatchObject({ roleArn: APPLY_ROLE, externalId: "lair-apply-ext", seconds: 3600 });
    // the apply steps hold the apply role's keys, not the plan role's
    for (const spec of r.tofu.specs.slice(3)) {
      expect(spec.env.AWS_ACCESS_KEY_ID).toBe(APPLY_CREDS.accessKeyId);
      expect(JSON.stringify(spec)).not.toContain(PLAN_CREDS.secretAccessKey);
    }
    // and the apply init reads the same state
    expect(r.tofu.specs[3]!.argv).toContain("-backend-config=key=example/staging/terraform.tfstate");
  });

  it("applies a plan once", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "applied" });
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "not-approvable" });
    expect(r.tofu.applied).toHaveLength(1);
    expect(readdirSync(r.planDir).filter((n) => n.endsWith(".tfplan"))).toEqual([]);
  });

  it("starts one apply when the same plan is applied twice at once", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    const both = await Promise.all([get(r).apply(p.planId, p.planHash), get(r).apply(p.planId, p.planHash)]);
    expect(both.map((o) => o.status).sort()).toEqual(["applied", "refused"]);
    expect(r.tofu.applied).toHaveLength(1);
  });

  it("an approval for plan A cannot apply plan B", async () => {
    const path = root();
    const r = rig(path, {});
    const a = await planned(r, path, "staging");
    r.tofu.planContent = "plan-file-for-production";
    const b = await planned(r, path, "production");
    expect(a.planHash).not.toBe(b.planHash);
    const issued = r.issuer.requests.length;
    expect(await get(r).apply(b.planId, a.planHash)).toMatchObject({ status: "refused", reason: "hash-mismatch" });
    expect(r.issuer.requests).toHaveLength(issued);
    expect(r.tofu.applied).toEqual([]);
  });

  it("refuses a plan file that was changed on disk after it was approved", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    writeFileSync(join(r.planDir, `${p.planId}.tfplan`), "tampered");
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "plan-file-changed" });
    expect(r.tofu.applied).toEqual([]);
  });

  it("refuses an unknown plan id, including one that is a path", async () => {
    const path = root();
    const r = rig(path, {});
    expect(await get(r).apply("0123456789abcdef01234567", "x")).toMatchObject({ status: "refused", reason: "unknown-plan" });
    expect(await get(r).apply("../../etc/passwd", "x")).toMatchObject({ status: "refused", reason: "unknown-plan" });
  });

  it("a newer plan of the same environment replaces the older: only the latest can be applied", async () => {
    const path = root();
    const r = rig(path, {});
    const first = await planned(r, path);
    r.tofu.planContent = "plan-file-v2";
    const second = await planned(r, path);
    expect(await get(r).apply(first.planId, first.planHash)).toMatchObject({ status: "refused", reason: "not-approvable" });
    expect(await get(r).apply(second.planId, second.planHash)).toMatchObject({ status: "applied" });
    expect(r.tofu.applied).toEqual(["plan-file-v2"]);
  });

  it("does not apply in observe mode, the default, and issues no credential", async () => {
    const path = root();
    const r = rig(path, { mode: undefined });
    const p = await planned(r, path);
    const issued = r.issuer.requests.length;
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "observe-mode" });
    expect(r.issuer.requests).toHaveLength(issued);
    expect(r.tofu.applied).toEqual([]);
  });
});

describe("a plan that destroys or replaces needs its own approval, naming the resources", () => {
  const DESTROYS = [
    { address: "aws_db_instance.main", actions: ["delete"] },
    { address: "aws_s3_bucket.logs", actions: ["create", "delete"] },
    { address: "aws_s3_bucket.new", actions: ["create"] },
  ];

  it("flags what the plan deletes and replaces, and returns a confirmation bound to them", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.resourceChanges = DESTROYS;
    const p = (await planned(r, path)) as Planned & { destroys: string[]; replaces: string[]; destroyConfirmation?: string };
    expect(p.destroys).toEqual(["aws_db_instance.main"]);
    expect(p.replaces).toEqual(["aws_s3_bucket.logs"]);
    expect(p.destroyConfirmation).toMatch(/^[a-f0-9]{64}$/);
    expect(r.tofu.verbs()).toEqual(["init", "plan", "show"]);
    expect((await get(r).plans())[0]).toMatchObject({ destroys: ["aws_db_instance.main"], replaces: ["aws_s3_bucket.logs"] });
  });

  it("refuses an apply with the hash alone, naming the resources, with no credential issued", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.resourceChanges = DESTROYS;
    const p = await planned(r, path);
    const issued = r.issuer.requests.length;
    const out = await get(r).apply(p.planId, p.planHash);
    expect(out).toMatchObject({ status: "refused", reason: "destroy-not-confirmed" });
    expect((out as { message: string }).message).toContain("destroy aws_db_instance.main");
    expect((out as { message: string }).message).toContain("replace aws_s3_bucket.logs");
    expect(await get(r).apply(p.planId, p.planHash, "0".repeat(64))).toMatchObject({ status: "refused", reason: "destroy-not-confirmed" });
    expect(r.issuer.requests).toHaveLength(issued);
    expect(r.tofu.applied).toEqual([]);
    // the plan is still approvable: the refusal spent nothing
    expect((await get(r).plans())[0]).toMatchObject({ status: "planned" });
  });

  it("applies with the confirmation that was returned with the plan", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.resourceChanges = DESTROYS;
    const p = (await planned(r, path)) as Planned & { destroyConfirmation: string };
    expect(await get(r).apply(p.planId, p.planHash, p.destroyConfirmation)).toMatchObject({ status: "applied" });
    expect(r.tofu.applied).toEqual(["plan-file-v1"]);
  });

  it("a confirmation for another plan does not confirm this one", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.resourceChanges = DESTROYS;
    const a = (await planned(r, path, "staging")) as Planned & { destroyConfirmation: string };
    r.tofu.planContent = "plan-file-for-production";
    const b = await planned(r, path, "production");
    expect(await get(r).apply(b.planId, b.planHash, a.destroyConfirmation)).toMatchObject({ status: "refused", reason: "destroy-not-confirmed" });
  });

  it("asks for no confirmation, and returns none, when the plan only adds or changes", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.resourceChanges = [{ address: "aws_s3_bucket.logs", actions: ["update"] }];
    const p = await planned(r, path);
    expect(p).toMatchObject({ destroys: [], replaces: [] });
    expect(p).not.toHaveProperty("destroyConfirmation");
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "applied" });
  });

  it("refuses to keep a plan whose changes cannot be read, or whose show fails", async () => {
    const path = root();
    const r = rig(path, {});
    r.tofu.showStdout = "not json";
    expect(await get(r).plan(path, "staging")).toMatchObject({ status: "refused", reason: "plan-unreadable" });
    r.tofu.showStdout = undefined;
    r.tofu.showExit = 1;
    expect(await get(r).plan(path, "staging")).toMatchObject({ status: "failed", reason: "show" });
    expect(existsSync(r.planDir) ? readdirSync(r.planDir) : []).toEqual([]);
  });

  it("over the route: refuses without confirmDestroy and applies with it", async () => {
    const path = root();
    const rg = rig(path, {});
    rg.tofu.resourceChanges = DESTROYS;
    const { app: a, owner } = await serveRoutes(rg);
    const plan = await a.inject({ method: "POST", url: `/api/tofu-runner/plan?project=${PROJECT}&root=${encodeURIComponent(path)}&env=staging`, headers: owner });
    const { planId, planHash, destroyConfirmation, destroys } = plan.json().data;
    expect(destroys).toEqual(["aws_db_instance.main"]);
    const base = `/api/tofu-runner/apply?project=${PROJECT}&plan=${planId}&hash=${planHash}`;
    expect((await a.inject({ method: "POST", url: base, headers: owner })).json().data).toMatchObject({ status: "refused", reason: "destroy-not-confirmed" });
    expect((await a.inject({ method: "POST", url: `${base}&confirmDestroy=${destroyConfirmation}`, headers: owner })).json().data).toMatchObject({ status: "applied" });
  });
});

describe("a stale plan is refused", () => {
  it("when the state changed (tofu refuses the plan), nothing is rolled back and the runner re-plans", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    r.tofu.applyExit = 1;
    r.tofu.applyStderr = "Error: Saved plan is stale";
    r.tofu.planContent = "plan-file-on-new-state";
    const out = await get(r).apply(p.planId, p.planHash);
    expect(out).toMatchObject({ status: "not-applied", reason: "stale", replan: { status: "planned", changes: true } });
    const replan = (out as { replan: Planned }).replan;
    expect(replan.planId).not.toBe(p.planId);
    expect(replan.planHash).toBe(sha256(Buffer.from("plan-file-on-new-state")));
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "not-approvable" });
  });

  it("when the code changed since the plan, the apply role is never assumed", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    writeFileSync(join(path, "main.tf"), `${AWS}\n# a later edit\n`);
    const before = r.issuer.requests.length;
    const out = await get(r).apply(p.planId, p.planHash);
    expect(out).toMatchObject({ status: "not-applied", reason: "code-changed-since-plan", replan: { status: "planned" } });
    // only the re-plan's credentials (the plan role) were issued
    expect(r.issuer.requests.slice(before).map((q) => q.roleArn)).toEqual([PLAN_ROLE]);
    expect(r.tofu.applied).toEqual([]);
  });

  it("when the code now fails the policy scan, nothing applies and the approved plan stays approvable", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    writeFileSync(join(path, "main.tf"), AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`);
    const before = r.issuer.requests.length;
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "policy" });
    expect(r.issuer.requests).toHaveLength(before);
    expect(r.tofu.applied).toEqual([]);
    writeFileSync(join(path, "main.tf"), AWS);
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "applied" });
  });
});

describe("a failed apply is not rolled back but re-planned", () => {
  it("runs no destroy or other undo, spends the plan, and returns a plan from the state as it now is", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    r.tofu.applyExit = 1;
    r.tofu.applyStderr = "Error: creating bucket: AccessDenied";
    r.tofu.planContent = "plan-for-the-rest";
    const out = await get(r).apply(p.planId, p.planHash);
    expect(out).toMatchObject({
      status: "not-applied",
      reason: "apply",
      output: expect.stringContaining("AccessDenied"),
      replan: { status: "planned", changes: true },
    });
    // init, plan, then init, apply, then the re-plan's init and plan: nothing else
    expect(r.tofu.verbs()).toEqual(["init", "plan", "show", "init", "apply", "init", "plan", "show"]);
    expect(JSON.stringify(r.tofu.specs.map((s) => s.argv))).not.toMatch(/destroy|-replace|rollback/);
    const record = (await get(r).plans()).find((x) => x.id === p.planId);
    expect(record).toMatchObject({ status: "failed", finishedAt: NOW });
    expect(await get(r).apply(p.planId, p.planHash)).toMatchObject({ status: "refused", reason: "not-approvable" });
  });

  it("keeps the record of an applied plan with its hash and time", async () => {
    const path = root();
    const r = rig(path, {});
    const p = await planned(r, path);
    await get(r).apply(p.planId, p.planHash);
    expect((await get(r).plans())[0]).toMatchObject({ id: p.planId, planHash: p.planHash, status: "applied", finishedAt: NOW, env: "staging" });
  });
});

describe("off by default, and never half on", () => {
  it("has no runner for a project without the block, and reports it off", async () => {
    const path = root();
    const r = rig(path, undefined);
    expect(r.runner.get(PROJECT)).toBeUndefined();
    expect(r.runner.status(PROJECT)).toEqual({ enabled: false, errors: [] });
  });

  it("has no runner for enabled: false", () => {
    const r = rig(root(), { enabled: false });
    expect(r.runner.get(PROJECT)).toBeUndefined();
  });

  it("refuses everything for an invalid block, and shows why", async () => {
    const r = rig(root(), { apply_role_arn: undefined, plan_dir: "relative" });
    const runner = get(r) as BlockedTofuRunner;
    expect(runner.status()).toMatchObject({ enabled: true, blocked: true });
    expect(JSON.stringify(runner.status())).toContain("apply_role_arn");
    expect(await runner.plan()).toMatchObject({ status: "refused", reason: "invalid-config" });
    expect(await runner.apply()).toMatchObject({ status: "refused", reason: "invalid-config" });
  });

  it("refuses when the plan sandbox is not enabled for the project", async () => {
    const path = root();
    const r = rig(path, {}, { sandbox: false });
    expect(await get(r).plan(path, "staging")).toMatchObject({ status: "refused", reason: "sandbox-required" });
    expect(r.issuer.requests).toHaveLength(0);
  });

  it("does not accept the plan role as the apply role", () => {
    const r = rig(root(), { apply_role_arn: PLAN_ROLE });
    expect(get(r).status()).toMatchObject({ enabled: true, blocked: true });
    expect(JSON.stringify(get(r).status())).toContain("apply_role_arn");
  });
});

describe("routes (owner only)", () => {
  const serve = serveRoutes;

  it("plans, then applies the approved plan for the owner, without the plan file in any answer", async () => {
    const path = root();
    const { app: a, owner } = await serve(rig(path, {}));
    const plan = await a.inject({ method: "POST", url: `/api/tofu-runner/plan?project=${PROJECT}&root=${encodeURIComponent(path)}&env=staging`, headers: owner });
    expect(plan.statusCode).toBe(200);
    const { planId, planHash } = plan.json().data;
    expect(plan.body).not.toContain("plan-file-v1");
    const apply = await a.inject({ method: "POST", url: `/api/tofu-runner/apply?project=${PROJECT}&plan=${planId}&hash=${planHash}`, headers: owner });
    expect(apply.json().data).toMatchObject({ status: "applied" });
    const plans = await a.inject({ method: "GET", url: `/api/tofu-runner/plans?project=${PROJECT}`, headers: owner });
    expect(plans.json().data).toHaveLength(1);
    expect(plans.json().data[0]).toMatchObject({ status: "applied" });
  });

  it("refuses a caller without the owner session on every route, and runs nothing", async () => {
    const path = root();
    const r = rig(path, {});
    const { app: a } = await serve(r);
    for (const [method, url] of [
      ["POST", `/api/tofu-runner/plan?project=${PROJECT}&root=${encodeURIComponent(path)}&env=staging`],
      ["POST", `/api/tofu-runner/apply?project=${PROJECT}&plan=0123456789abcdef01234567&hash=x`],
      ["GET", `/api/tofu-runner/status?project=${PROJECT}`],
      ["GET", `/api/tofu-runner/plans?project=${PROJECT}`],
    ] as const) {
      expect((await a.inject({ method, url, headers: BROWSER })).statusCode).toBe(403);
    }
    expect(r.issuer.requests).toHaveLength(0);
    expect(r.tofu.specs).toHaveLength(0);
  });

  it("answers 400 for an unknown root, environment or missing field, and 404 when off", async () => {
    const path = root();
    const on = await serve(rig(path, {}));
    const base = `/api/tofu-runner/plan?project=${PROJECT}`;
    expect((await on.app.inject({ method: "POST", url: `${base}&root=/etc&env=staging`, headers: on.owner })).statusCode).toBe(400);
    expect((await on.app.inject({ method: "POST", url: `${base}&root=${encodeURIComponent(path)}&env=qa`, headers: on.owner })).statusCode).toBe(400);
    expect((await on.app.inject({ method: "POST", url: `${base}&root=${encodeURIComponent(path)}`, headers: on.owner })).statusCode).toBe(400);
    expect((await on.app.inject({ method: "POST", url: `/api/tofu-runner/apply?project=${PROJECT}`, headers: on.owner })).statusCode).toBe(400);
    await on.app.close();
    const off = await serve(rig(path, undefined));
    expect((await off.app.inject({ method: "POST", url: `${base}&root=${encodeURIComponent(path)}&env=staging`, headers: off.owner })).statusCode).toBe(404);
    expect((await off.app.inject({ method: "GET", url: `/api/tofu-runner/status?project=${PROJECT}`, headers: off.owner })).json().data).toEqual({ enabled: false, errors: [] });
  });

  it("shows the mode, role, bucket and environments on status, and no credential or external id", async () => {
    const { app: a, owner } = await serve(rig(root(), {}));
    const res = await a.inject({ method: "GET", url: `/api/tofu-runner/status?project=${PROJECT}`, headers: owner });
    expect(res.json().data).toMatchObject({ enabled: true, blocked: false, mode: "act", applyRoleArn: APPLY_ROLE, stateBucket: "lair-state-123456789012", environments: ["staging", "production"] });
    expect(res.body).not.toContain("lair-apply-ext");
  });
});
