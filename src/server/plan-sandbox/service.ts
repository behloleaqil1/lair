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
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { InfraPolicy, type InfraPolicyManager } from "../infra-policy/index.js";
import { parsePlanSandboxConfig, PLAN_ROLE_SECONDS, type PlanSandboxSettings } from "./config.js";
import { checkLockFile } from "./lock.js";
import { snapshotRoot, SnapshotRefused } from "./snapshot.js";
import type { PlanCredentialIssuer, PlanCredentials, SandboxSpawner } from "./types.js";

export type PlanOutcome =
  | { status: "refused"; reason: string; message: string; detail?: string[] }
  | { status: "failed"; reason: "init" | "plan" | "timeout" | "credentials"; message: string; output: string }
  | { status: "planned"; changes: boolean; output: string; credentialsExpireAt: string };

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
  async plan(root: string): Promise<PlanOutcome> {
    const { infra } = this.deps;
    const now = this.deps.now ?? (() => new Date());
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
      const guarded = await policy.guardPlan<PlanOutcome>(root, async () => {
        if ((await snapshotRoot(root)) !== copyHash) {
          return { status: "refused", reason: "changed", message: "plan sandbox: the code changed during the scan" };
        }
        const problems = await checkLockFile(copy, policy.settings.allowedProviders);
        if (problems.length > 0) {
          return { status: "refused", reason: problems[0]!.rule, message: `plan sandbox: ${problems[0]!.rule}`, detail: problems.map((p) => `${p.rule}: ${p.detail}`) };
        }
        return this.run(copy, now);
      });
      return guarded.status === "refused"
        ? { status: "refused", reason: "policy", message: guarded.message }
        : guarded.result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async run(copy: string, now: () => Date): Promise<PlanOutcome> {
    const s = this.settings;
    let creds: PlanCredentials;
    try {
      creds = await this.deps.issuer.issue({
        roleArn: s.planRoleArn,
        externalId: s.externalId,
        sessionName: `lair-plan-${this.project}`.slice(0, 64),
        seconds: PLAN_ROLE_SECONDS,
        region: s.region,
      });
    } catch {
      return { status: "failed", reason: "credentials", message: "plan sandbox: the plan role could not be assumed", output: "" };
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
        timeoutMs: Math.max(1000, Math.min(s.timeoutSeconds * 1000, left)),
      });
    };
    const text = (r: { stdout: string; stderr: string }) => redact(`${r.stdout}${r.stderr}`, secrets, s.maxOutputBytes);

    const init = await step(["tofu", "init", "-input=false", "-no-color", "-lockfile=readonly", "-plugin-dir=/plugins"]);
    if (init.timedOut) return { status: "failed", reason: "timeout", message: "plan sandbox: init timed out", output: text(init) };
    if (init.exitCode !== 0) return { status: "failed", reason: "init", message: "plan sandbox: init failed", output: text(init) };

    const plan = await step(["tofu", "plan", "-input=false", "-no-color", "-lock=false", "-detailed-exitcode"]);
    if (plan.timedOut) return { status: "failed", reason: "timeout", message: "plan sandbox: plan timed out", output: text(plan) };
    if (plan.exitCode !== 0 && plan.exitCode !== 2) return { status: "failed", reason: "plan", message: "plan sandbox: plan failed", output: text(plan) };
    return { status: "planned", changes: plan.exitCode === 2, output: text(plan), credentialsExpireAt: creds.expiresAt };
  }

  status() {
    const s = this.settings;
    return {
      enabled: true as const,
      blocked: false as const,
      planRoleArn: s.planRoleArn,
      region: s.region,
      egressHosts: [...s.providerApiHosts, ...s.registryHosts],
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

  get(project: string): PlanSandbox | BlockedPlanSandbox | undefined {
    return this.sandboxes.get(project);
  }

  status(project: string) {
    return this.sandboxes.get(project)?.status() ?? { enabled: false as const, errors: [] as string[] };
  }
}
