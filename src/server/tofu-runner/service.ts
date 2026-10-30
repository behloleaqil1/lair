/**
 * The OpenTofu runner: plan, then apply an approved plan, from the control plane
 * (docs/design/deploy-aws.md §1.2, §2.6). Off unless a project sets
 * `tofu_runner.enabled: true`.
 *
 * Every run goes through the plan sandbox, which copies the root, runs the
 * policy scan (guardPlan), checks the lock file and only then issues
 * credentials and starts the isolated process. This module adds:
 *   - plan: state read from S3 (`<project>/<env>/terraform.tfstate`, native
 *     locking), the plan written to a file whose SHA-256 the approval carries;
 *   - apply: only that file, only when the approval's hash matches it, the
 *     code is the code that was planned, and the mode is `act`; with the apply
 *     role, never the plan role. A plan is applied once.
 *   - a failed apply is not rolled back: the plan is spent, the record says
 *     what happened, and the runner re-plans from the state as it now is.
 */
import { randomBytes } from "crypto";
import { PlanSandbox, type PlanOutcome, type PlanSandboxManager, type StateBackend } from "../plan-sandbox/index.js";
import { APPLY_ROLE_SECONDS, parseTofuRunnerConfig, type TofuRunnerSettings } from "./config.js";
import { PlanStore, sha256, type PlanRecord } from "./store.js";

export type RunnerPlanOutcome =
  | Extract<PlanOutcome, { status: "refused" | "failed" }>
  | { status: "planned"; changes: false; output: string }
  | {
      status: "planned";
      changes: true;
      output: string;
      planId: string;
      planHash: string;
      /** What the plan deletes, and what it replaces; when either is not empty, apply also needs `destroyConfirmation` */
      destroys: string[];
      replaces: string[];
      destroyConfirmation?: string;
    };

/**
 * What the plan does to each resource, from `tofu show -json`. A resource whose
 * actions include `delete` is destroyed (or, with `create` too, replaced). A plan
 * that cannot be read is refused: nothing that is not understood is approvable.
 */
export function readPlanChanges(planJson: string | undefined): { destroys: string[]; replaces: string[] } | undefined {
  if (planJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    return undefined;
  }
  const changes = (parsed as { resource_changes?: unknown } | null)?.resource_changes;
  if (changes === undefined) return { destroys: [], replaces: [] };
  if (!Array.isArray(changes)) return undefined;
  const destroys: string[] = [];
  const replaces: string[] = [];
  for (const c of changes as { address?: unknown; change?: { actions?: unknown } }[]) {
    const actions = c?.change?.actions;
    if (typeof c?.address !== "string" || !Array.isArray(actions)) return undefined;
    if (!actions.includes("delete")) continue;
    (actions.includes("create") ? replaces : destroys).push(c.address);
  }
  return { destroys: destroys.sort(), replaces: replaces.sort() };
}

/** The second approval of a plan that destroys or replaces: bound to the plan hash and the resources it names */
export function destroyConfirmation(record: Pick<PlanRecord, "planHash" | "destroys" | "replaces">): string {
  return sha256(Buffer.from(`destroy:${record.planHash}:${record.destroys.join(",")}:${record.replaces.join(",")}`));
}

export type RunnerApplyOutcome =
  | { status: "refused"; reason: string; message: string }
  | { status: "applied"; output: string }
  | {
      /** The apply did not complete (or the plan was stale); nothing was rolled back. `replan` is the plan from the state as it now is */
      status: "not-applied";
      reason: string;
      message: string;
      output: string;
      replan: RunnerPlanOutcome;
    };

export interface TofuRunnerDeps {
  sandbox: PlanSandboxManager;
  now?: () => Date;
}

export class TofuRunner {
  private readonly store: PlanStore;
  /** Plans being applied now; checked and set before any await, so a plan cannot start twice */
  private readonly inFlight = new Set<string>();

  constructor(
    readonly project: string,
    readonly settings: TofuRunnerSettings,
    private readonly deps: TofuRunnerDeps,
  ) {
    this.store = new PlanStore(settings.planDir);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private backend(env: string, region: string): StateBackend {
    return { bucket: this.settings.stateBucket, key: `${this.project}/${env}/terraform.tfstate`, region };
  }

  private sandbox(): PlanSandbox | undefined {
    const s = this.deps.sandbox.get(this.project);
    return s instanceof PlanSandbox ? s : undefined;
  }

  /** Plan one environment of a configured root; a plan with changes is kept for approval. */
  async plan(root: string, env: string): Promise<RunnerPlanOutcome> {
    if (!this.settings.environments.includes(env)) throw new Error(`not a configured environment: ${env}`);
    const sandbox = this.sandbox();
    if (!sandbox) return { status: "refused", reason: "sandbox-required", message: "tofu runner: the plan sandbox must be enabled and valid" };
    const out = await sandbox.plan(root, { backend: this.backend(env, sandbox.settings.region), keepPlanFile: true });
    if (out.status !== "planned") return out;
    if (!out.changes || !out.planFile) return { status: "planned", changes: false, output: out.output };
    const planChanges = readPlanChanges(out.planJson);
    if (!planChanges) return { status: "refused", reason: "plan-unreadable", message: "tofu runner: the plan's changes could not be read, so it cannot be approved" };
    const planHash = sha256(out.planFile);
    const record: PlanRecord = {
      id: randomBytes(12).toString("hex"),
      project: this.project,
      root,
      env,
      planHash,
      codeHash: out.codeHash,
      createdAt: this.now().toISOString(),
      status: "planned",
      ...planChanges,
    };
    await this.store.save(record, out.planFile);
    const risky = record.destroys.length + record.replaces.length > 0;
    return {
      status: "planned",
      changes: true,
      output: out.output,
      planId: record.id,
      planHash,
      destroys: record.destroys,
      replaces: record.replaces,
      ...(risky ? { destroyConfirmation: destroyConfirmation(record) } : {}),
    };
  }

  /**
   * Apply the approved plan `planId`; `approvedHash` is the hash the approval carries.
   * A plan that destroys or replaces also needs `confirmDestroy`, the confirmation
   * returned with that plan, which names the resources.
   */
  async apply(planId: string, approvedHash: string, confirmDestroy?: string): Promise<RunnerApplyOutcome> {
    const refuse = (reason: string, message: string): RunnerApplyOutcome => ({ status: "refused", reason, message: `tofu runner: ${message}` });
    if (this.settings.mode !== "act") return refuse("observe-mode", "apply is off in observe mode");
    const sandbox = this.sandbox();
    if (!sandbox) return refuse("sandbox-required", "the plan sandbox must be enabled and valid");
    if (this.inFlight.has(planId)) return refuse("not-approvable", "this plan is being applied");
    this.inFlight.add(planId);
    try {
      const record = await this.store.get(planId);
      if (!record || record.project !== this.project) return refuse("unknown-plan", "no such plan");
      if (record.status !== "planned") return refuse("not-approvable", `the plan is ${record.status}`);
      if (approvedHash !== record.planHash) return refuse("hash-mismatch", "the approval is for a different plan");
      const file = await this.store.file(planId);
      if (!file || sha256(file) !== record.planHash) return refuse("plan-file-changed", "the plan file is not the approved one");
      const named = [...record.destroys.map((a) => `destroy ${a}`), ...record.replaces.map((a) => `replace ${a}`)];
      if (named.length > 0 && confirmDestroy !== destroyConfirmation(record)) {
        return refuse("destroy-not-confirmed", `this plan would ${named.join(", ")}; it needs its own confirmation (confirmDestroy) naming them`);
      }

      await this.store.update({ ...record, status: "applying" });
      const out = await sandbox.apply(record.root, {
        backend: this.backend(record.env, sandbox.settings.region),
        roleArn: this.settings.applyRoleArn,
        externalId: this.settings.externalId,
        seconds: APPLY_ROLE_SECONDS,
        timeoutSeconds: this.settings.applyTimeoutSeconds,
        planFile: file,
        codeHash: record.codeHash,
      });
      const finish = async (status: "applied" | "failed" | "stale") => {
        await this.store.update({ ...record, status, finishedAt: this.now().toISOString() });
        await this.store.dropFile(planId);
        console.log(`[tofu-runner] ${this.project}/${record.env} plan ${record.planHash.slice(0, 12)} ${status}`);
      };

      if (out.status === "applied") {
        await finish("applied");
        return { status: "applied", output: out.output };
      }
      // Nothing ran: the plan is still the approved one
      if (out.status === "refused" && out.reason !== "code-changed-since-plan") {
        await this.store.update(record);
        return { status: "refused", reason: out.reason, message: out.message };
      }
      const stale = out.status === "refused" || out.reason === "stale";
      await finish(stale ? "stale" : "failed");
      const replan = await this.plan(record.root, record.env);
      return {
        status: "not-applied",
        reason: out.reason,
        message: out.message,
        output: out.status === "failed" ? out.output : "",
        replan,
      };
    } finally {
      this.inFlight.delete(planId);
    }
  }

  status() {
    const s = this.settings;
    return {
      enabled: true as const,
      blocked: false as const,
      mode: s.mode,
      applyRoleArn: s.applyRoleArn,
      stateBucket: s.stateBucket,
      environments: s.environments,
      applyTimeoutSeconds: s.applyTimeoutSeconds,
    };
  }

  async plans(): Promise<PlanRecord[]> {
    return (await this.store.list()).filter((r) => r.project === this.project);
  }
}

/** A project that asked for the runner with a config that cannot be read: nothing runs */
export class BlockedTofuRunner {
  constructor(
    readonly project: string,
    readonly errors: string[],
  ) {}
  async plan(): Promise<RunnerPlanOutcome> {
    return { status: "refused", reason: "invalid-config", message: "tofu runner: invalid-config" };
  }
  async apply(): Promise<RunnerApplyOutcome> {
    return { status: "refused", reason: "invalid-config", message: "tofu runner: invalid-config" };
  }
  async plans(): Promise<PlanRecord[]> {
    return [];
  }
  status() {
    return { enabled: true as const, blocked: true as const, errors: this.errors };
  }
}

export interface ProjectEntry {
  name: string;
  config?: { tofu_runner?: Record<string, unknown> };
}

export class TofuRunnerManager {
  private readonly runners = new Map<string, TofuRunner | BlockedTofuRunner>();

  constructor(private readonly deps: TofuRunnerDeps) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const raw = entry.config.tofu_runner;
      const parsed = parseTofuRunnerConfig(raw);
      if (!parsed.ok) {
        const disabled = typeof raw === "object" && raw !== null && (raw as { enabled?: unknown }).enabled === false;
        console.warn(`[tofu-runner] ${entry.name}: ${parsed.errors.join("; ")}`);
        if (!disabled) this.runners.set(entry.name, new BlockedTofuRunner(entry.name, parsed.errors));
        continue;
      }
      if (!parsed.settings.enabled) continue;
      const sandbox = this.deps.sandbox.get(entry.name);
      if (sandbox instanceof PlanSandbox && sandbox.settings.planRoleArn === parsed.settings.applyRoleArn) {
        const errors = ["tofu_runner.apply_role_arn: must not be the plan role (plan_sandbox.plan_role_arn)"];
        console.warn(`[tofu-runner] ${entry.name}: ${errors.join("; ")}`);
        this.runners.set(entry.name, new BlockedTofuRunner(entry.name, errors));
        continue;
      }
      this.runners.set(entry.name, new TofuRunner(entry.name, parsed.settings, this.deps));
    }
  }

  get(project: string): TofuRunner | BlockedTofuRunner | undefined {
    return this.runners.get(project);
  }

  status(project: string) {
    return this.runners.get(project)?.status() ?? { enabled: false as const, errors: [] as string[] };
  }
}
