/**
 * The plan sandbox: `tofu plan` in an isolated runner with only the read-only
 * plan role (docs/design/deploy-aws.md §2.2). Off unless a project sets
 * `plan_sandbox.enabled: true`.
 *
 * Order, each step ending the run before the next:
 *   1. a private copy of the root and its hash is taken;
 *   2. the policy scan (guardPlan) reads the root; a failing scan stops here;
 *   3. the root is hashed again: a change since the copy is refused;
 *   4. the lock file must pin every provider, with hashes, all allowed;
 *   5. only now are the plan role's credentials issued (15 minutes);
 *   6. `tofu init -lockfile=readonly -plugin-dir=...` and `tofu plan` run
 *      in the copy, with an environment of exactly the names in `sandboxEnv`.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { InfraPolicy, type InfraPolicyManager } from "../infra-policy/index.js";
import { parsePlanSandboxConfig, PLAN_ROLE_SECONDS, type PlanSandboxSettings } from "./config.js";
import { checkLockFile } from "./lock.js";
import { snapshotRoot, SnapshotRefused } from "./snapshot.js";
import type { PlanCredentialIssuer, PlanCredentials, SandboxSpawner } from "./types.js";

export type PlanOutcome =
  | { status: "refused"; reason: string; message: string; detail?: string[] }
  | { status: "failed"; reason: "init" | "plan" | "timeout" | "output" | "credentials"; message: string; output: string }
  | { status: "planned"; changes: boolean; output: string; credentialsExpireAt: string; codeHash: string; planFile?: Buffer };

export type ApplyOutcome =
  | { status: "refused"; reason: string; message: string; detail?: string[] }
  | { status: "failed"; reason: "init" | "apply" | "stale" | "timeout" | "output" | "credentials"; message: string; output: string }
  | { status: "applied"; output: string };

/** The S3 state of one environment (§1.2); the values are passed to `tofu init` as -backend-config */
export interface StateBackend {
  bucket: string;
  key: string;
  region: string;
}

/** Plan with the state read from S3 and the plan written to a file the caller keeps */
export interface PlanJob {
  backend?: StateBackend;
  keepPlanFile?: boolean;
}

/** Apply exactly this plan file, with this role, on code that still has this hash */
export interface ApplyJob {
  backend: StateBackend;
  roleArn: string;
  externalId?: string;
  seconds: number;
  timeoutSeconds: number;
  planFile: Buffer;
  codeHash: string;
}

const PLAN_FILE = "lair.tfplan";
const MAX_PLAN_FILE_BYTES = 64 * 1024 * 1024;

function initArgs(backend?: StateBackend): string[] {
  const args = ["tofu", "init", "-input=false", "-no-color", "-lockfile=readonly", "-plugin-dir=/plugins"];
  if (backend) {
    args.push(`-backend-config=bucket=${backend.bucket}`, `-backend-config=key=${backend.key}`, `-backend-config=region=${backend.region}`);
    args.push("-backend-config=use_lockfile=true", "-backend-config=encrypt=true");
  }
  return args;
}

/** The whole environment of the sandboxed process. Nothing of Lair's own is in it. */
export function sandboxEnv(creds: PlanCredentials, region: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
  };
}

export interface PlanSandboxDeps {
  spawner: SandboxSpawner;
  issuer: PlanCredentialIssuer;
  infra: InfraPolicyManager;
  now?: () => Date;
  /** Removes what a crashed run left (temp copies, containers); run once by `startupSweep` */
  sweep?: () => Promise<unknown>;
}

function redact(text: string, secrets: string[], limit: number): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out.length > limit ? `${out.slice(0, limit)}\n[output cut]` : out;
}

export class PlanSandbox {
  constructor(
    readonly project: string,
    readonly settings: PlanSandboxSettings,
    private readonly deps: PlanSandboxDeps,
  ) {}

  /** Plan a configured root of the project's infra_policy. */
  async plan(root: string, job: PlanJob = {}): Promise<PlanOutcome> {
    return this.guarded<PlanOutcome>(root, async (copy, copyHash) =>
      this.run(copy, copyHash, job),
    );
  }

  /**
   * Apply an approved plan file with the apply role (§2.6). The same copy, scan
   * and lock-file steps as a plan run first, and the code must be the code that
   * was planned.
   */
  async apply(root: string, job: ApplyJob): Promise<ApplyOutcome> {
    return this.guarded<ApplyOutcome>(root, async (copy, copyHash) => {
      if (copyHash !== job.codeHash) {
        return { status: "refused", reason: "code-changed-since-plan", message: "apply: the code is not the code that was planned" };
      }
      const session = await this.session(copy, { roleArn: job.roleArn, externalId: job.externalId, seconds: job.seconds, name: "apply", timeoutSeconds: job.timeoutSeconds });
      if (!session.ok) return { status: "failed", reason: "credentials", message: "apply: the apply role could not be assumed", output: "" };
      const { step, text } = session;
      const init = await step(initArgs(job.backend));
      if (init.outputOverflow) return { status: "failed", reason: "output", message: "apply: init wrote more output than allowed and was stopped", output: text(init) };
      if (init.timedOut) return { status: "failed", reason: "timeout", message: "apply: init timed out", output: text(init) };
      if (init.exitCode !== 0) return { status: "failed", reason: "init", message: "apply: init failed", output: text(init) };
      await writeFile(join(copy, PLAN_FILE), job.planFile, { mode: 0o600 });
      const applied = await step(["tofu", "apply", "-input=false", "-no-color", "-lock-timeout=60s", PLAN_FILE]);
      if (applied.outputOverflow) return { status: "failed", reason: "output", message: "apply: apply wrote more output than allowed and was stopped", output: text(applied) };
      if (applied.timedOut) return { status: "failed", reason: "timeout", message: "apply: apply timed out", output: text(applied) };
      if (applied.exitCode !== 0) {
        const out = text(applied);
        // OpenTofu itself refuses a plan made on a state that has since changed
        const stale = /saved plan is stale|plan file.*stale/i.test(out);
        return { status: "failed", reason: stale ? "stale" : "apply", message: stale ? "apply: the state changed since the plan" : "apply: apply failed", output: out };
      }
      return { status: "applied", output: text(applied) };
    });
  }

  /** Copy, scan, re-hash and lock check; only then `work` runs. Shared by plan and apply. */
  private async guarded<T extends { status: string }>(root: string, work: (copy: string, copyHash: string) => Promise<T>): Promise<T | { status: "refused"; reason: string; message: string; detail?: string[] }> {
    const { infra } = this.deps;
    const policy = infra.get(this.project);
    if (!policy || !(policy instanceof InfraPolicy)) {
      return { status: "refused", reason: "scan-required", message: "plan sandbox: the policy scan must be enabled and valid" };
    }
    if (!policy.roots.includes(root)) throw new Error(`not a configured root: ${root}`);

    const tmp = await mkdtemp(join(tmpdir(), "lair-plan-"));
    const copy = join(tmp, "code");
    try {
      let copyHash: string;
      try {
        copyHash = await snapshotRoot(root, copy);
      } catch (e) {
        if (e instanceof SnapshotRefused) return { status: "refused", reason: "unreadable", message: "plan sandbox: root cannot be copied", detail: [e.message] };
        throw e;
      }
      const guarded = await policy.guardPlan<T | { status: "refused"; reason: string; message: string; detail?: string[] }>(root, async () => {
        if ((await snapshotRoot(root)) !== copyHash) {
          return { status: "refused", reason: "changed", message: "plan sandbox: the code changed during the scan" };
        }
        const problems = await checkLockFile(copy, policy.settings.allowedProviders);
        if (problems.length > 0) {
          return { status: "refused", reason: problems[0]!.rule, message: `plan sandbox: ${problems[0]!.rule}`, detail: problems.map((p) => `${p.rule}: ${p.detail}`) };
        }
        return work(copy, copyHash);
      });
      return guarded.status === "refused"
        ? { status: "refused", reason: "policy", message: guarded.message }
        : guarded.result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Credentials of one role and a step runner holding exactly the sandbox environment */
  private async session(copy: string, role: { roleArn: string; externalId?: string; seconds: number; name: string; timeoutSeconds: number }) {
    const s = this.settings;
    const now = this.deps.now ?? (() => new Date());
    let creds: PlanCredentials;
    try {
      creds = await this.deps.issuer.issue({
        roleArn: role.roleArn,
        externalId: role.externalId,
        sessionName: `lair-${role.name}-${this.project}`.slice(0, 64),
        seconds: role.seconds,
        region: s.region,
      });
    } catch {
      return { ok: false as const };
    }
    const secrets = [creds.accessKeyId, creds.secretAccessKey, creds.sessionToken];
    const env = sandboxEnv(creds, s.region);
    const egress = { hosts: [...s.providerApiHosts, ...s.registryHosts], network: s.egressNetwork };
    const step = async (argv: string[]) => {
      const left = Date.parse(creds.expiresAt) - now().getTime();
      return this.deps.spawner.run({
        image: s.image,
        argv,
        workdir: copy,
        pluginDir: s.pluginDir,
        env,
        egress,
        timeoutMs: Math.max(1000, Math.min(role.timeoutSeconds * 1000, left)),
      });
    };
    const text = (r: { stdout: string; stderr: string }) => redact(`${r.stdout}${r.stderr}`, secrets, s.maxOutputBytes);
    return { ok: true as const, creds, step, text };
  }

  private async run(copy: string, codeHash: string, job: PlanJob): Promise<PlanOutcome> {
    const s = this.settings;
    const session = await this.session(copy, { roleArn: s.planRoleArn, externalId: s.externalId, seconds: PLAN_ROLE_SECONDS, name: "plan", timeoutSeconds: s.timeoutSeconds });
    if (!session.ok) return { status: "failed", reason: "credentials", message: "plan sandbox: the plan role could not be assumed", output: "" };
    const { creds, step, text } = session;

    const init = await step(initArgs(job.backend));
    if (init.outputOverflow) return { status: "failed", reason: "output", message: "plan sandbox: init wrote more output than allowed and was stopped", output: text(init) };
    if (init.timedOut) return { status: "failed", reason: "timeout", message: "plan sandbox: init timed out", output: text(init) };
    if (init.exitCode !== 0) return { status: "failed", reason: "init", message: "plan sandbox: init failed", output: text(init) };

    const planArgs = ["tofu", "plan", "-input=false", "-no-color", "-lock=false", "-detailed-exitcode"];
    if (job.keepPlanFile) planArgs.push(`-out=${PLAN_FILE}`);
    const plan = await step(planArgs);
    if (plan.outputOverflow) return { status: "failed", reason: "output", message: "plan sandbox: plan wrote more output than allowed and was stopped", output: text(plan) };
    if (plan.timedOut) return { status: "failed", reason: "timeout", message: "plan sandbox: plan timed out", output: text(plan) };
    if (plan.exitCode !== 0 && plan.exitCode !== 2) return { status: "failed", reason: "plan", message: "plan sandbox: plan failed", output: text(plan) };
    const outcome: PlanOutcome = { status: "planned", changes: plan.exitCode === 2, output: text(plan), credentialsExpireAt: creds.expiresAt, codeHash };
    if (job.keepPlanFile && outcome.changes) {
      const file = join(copy, PLAN_FILE);
      if ((await stat(file)).size > MAX_PLAN_FILE_BYTES) return { status: "failed", reason: "output", message: "plan sandbox: the plan file is too large", output: "" };
      outcome.planFile = await readFile(file);
    }
    return outcome;
  }

  status() {
    const s = this.settings;
    return {
      enabled: true as const,
      blocked: false as const,
      planRoleArn: s.planRoleArn,
      region: s.region,
      // Declared for the owner's proxy; Lair passes them on but does not filter by hostname (follow-up #203)
      declaredEgressHosts: [...s.providerApiHosts, ...s.registryHosts],
      egressHostsEnforcedByLair: false as const,
      egressNetwork: s.egressNetwork ?? null,
      credentialSeconds: PLAN_ROLE_SECONDS,
      timeoutSeconds: s.timeoutSeconds,
    };
  }
}

/** A project that asked for the sandbox with a config that cannot be read: nothing runs */
export class BlockedPlanSandbox {
  constructor(
    readonly project: string,
    readonly errors: string[],
  ) {}
  async plan(): Promise<PlanOutcome> {
    return { status: "refused", reason: "invalid-config", message: "plan sandbox: invalid-config" };
  }
  async apply(): Promise<ApplyOutcome> {
    return { status: "refused", reason: "invalid-config", message: "plan sandbox: invalid-config" };
  }
  status() {
    return { enabled: true as const, blocked: true as const, errors: this.errors };
  }
}

export interface ProjectEntry {
  name: string;
  config?: { plan_sandbox?: Record<string, unknown> };
}

export class PlanSandboxManager {
  private readonly sandboxes = new Map<string, PlanSandbox | BlockedPlanSandbox>();

  constructor(private readonly deps: PlanSandboxDeps) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const raw = entry.config.plan_sandbox;
      const parsed = parsePlanSandboxConfig(raw);
      if (!parsed.ok) {
        const disabled = typeof raw === "object" && raw !== null && (raw as { enabled?: unknown }).enabled === false;
        console.warn(`[plan-sandbox] ${entry.name}: ${parsed.errors.join("; ")}`);
        if (!disabled) this.sandboxes.set(entry.name, new BlockedPlanSandbox(entry.name, parsed.errors));
        continue;
      }
      if (parsed.settings.enabled) this.sandboxes.set(entry.name, new PlanSandbox(entry.name, parsed.settings, this.deps));
    }
  }

  /** Once at startup, only when some project has the sandbox on: remove what a crash left behind */
  async startupSweep(): Promise<void> {
    if (!this.deps.sweep) return;
    if (![...this.sandboxes.values()].some((s) => s instanceof PlanSandbox)) return;
    try {
      await this.deps.sweep();
    } catch (e) {
      console.warn(`[plan-sandbox] startup sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get(project: string): PlanSandbox | BlockedPlanSandbox | undefined {
    return this.sandboxes.get(project);
  }

  status(project: string) {
    return this.sandboxes.get(project)?.status() ?? { enabled: false as const, errors: [] as string[] };
  }
}
