/**
 * The OpenTofu runner: plan, then apply an approved plan, from the control plane
 * (docs/design/deploy-aws.md §1.2, §2.6). Off unless a project sets
 * `tofu_runner.enabled: true`.
 *
 * Every run goes through the plan sandbox, which copies the root, runs the
 * policy scan (guardPlan), checks the lock file and only then issues
 * credentials and starts the isolated process. This module adds:
 *   - plan: state read from S3 (`<project>/<env>/<root>/terraform.tfstate`,
 *     native locking), the plan written to a file whose SHA-256 the approval
 *     carries, and read back (`tofu show -json`) for what it destroys or replaces;
 *   - apply: only that file, only when the approval's hash matches it, the
 *     code is the code that was planned, the plan is not older than
 *     `plan_max_age_seconds`, and the mode is `act`; a plan that destroys or
 *     replaces also needs its own confirmation; with the apply role, never the
 *     plan role. A plan is applied once, one run per workspace (root and
 *     environment) at a time.
 *   - a failed apply is not rolled back: the plan is spent, the record says
 *     what happened, and the runner re-plans from the state as it now is. An
 *     apply that raised an error, or was cut off by a restart, ends `failed` too.
 *   - every plan, apply request, refusal, start and end is written to the audit
 *     log with the owner session, and sent as an event.
 */
import { createHash, randomBytes } from "crypto";
import { basename } from "path";
import type { EventType } from "../../shared/server-types.js";
import { PlanSandbox, type PlanOutcome, type PlanSandboxManager, type StateBackend } from "../plan-sandbox/index.js";
import { AuditLog, type AuditEntry } from "./audit.js";
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

/**
 * The state key of one workspace: project, environment and root. The root is in
 * the key, so two roots planned for one environment never share a state file.
 */
export function stateKey(project: string, env: string, root: string): string {
  const name = basename(root).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "root";
  const id = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${project}/${env}/${name}-${id}/terraform.tfstate`;
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
  /** Receives `tofu.*` events; the audit log is written whether or not this is set */
  events?: { emit(type: EventType, data: Record<string, unknown>): Promise<void> };
}

export class TofuRunner {
  private readonly store: PlanStore;
  private readonly auditLog: AuditLog;
  /** Workspaces (root and environment) with a plan or apply running; checked and set before any await */
  private readonly busy = new Set<string>();

  constructor(
    readonly project: string,
    readonly settings: TofuRunnerSettings,
    private readonly deps: TofuRunnerDeps,
  ) {
    this.store = new PlanStore(settings.planDir);
    this.auditLog = new AuditLog(settings.planDir);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private backend(root: string, env: string, region: string): StateBackend {
    return { bucket: this.settings.stateBucket, key: stateKey(this.project, env, root), region };
  }

  private sandbox(): PlanSandbox | undefined {
    const s = this.deps.sandbox.get(this.project);
    return s instanceof PlanSandbox ? s : undefined;
  }

  private workspace(root: string, env: string): string {
    return `${root}\u0000${env}`;
  }

  /**
   * Write an audit entry and send its event. With `strict`, a failed write throws
   * (the caller does not go on without a record); otherwise it is logged and skipped.
   */
  private async record(event: EventType, entry: Omit<AuditEntry, "at" | "project">, strict = false): Promise<void> {
    const full: AuditEntry = { at: this.now().toISOString(), project: this.project, ...entry };
    try {
      await this.auditLog.append(full);
    } catch (e) {
      if (strict) throw e;
      console.warn(`[tofu-runner] ${this.project}: audit write failed`);
    }
    try {
      await this.deps.events?.emit(event, {
        project: this.project,
        env: full.env,
        root: full.root,
        planId: full.planId,
        outcome: full.outcome,
        reason: full.reason,
        by: full.actor,
      });
    } catch {
      // an event that cannot be sent does not stop the run; the audit log has it
    }
  }

  /** Plan one environment of a configured root; a plan with changes is kept for approval. `by` is the owner session id. */
  async plan(root: string, env: string, by: string): Promise<RunnerPlanOutcome> {
    if (!this.settings.environments.includes(env)) throw new Error(`not a configured environment: ${env}`);
    const sandbox = this.sandbox();
    if (!sandbox) return { status: "refused", reason: "sandbox-required", message: "tofu runner: the plan sandbox must be enabled and valid" };
    const problem = await this.store.checkDir();
    if (problem) return { status: "refused", reason: "plan-dir-unsafe", message: `tofu runner: ${problem}` };
    const key = this.workspace(root, env);
    if (this.busy.has(key)) return { status: "refused", reason: "workspace-busy", message: "tofu runner: a plan or apply of this root and environment is running" };
    this.busy.add(key);
    try {
      return await this.planHeld(sandbox, root, env, by);
    } finally {
      this.busy.delete(key);
    }
  }

  /** The plan itself, audited; the caller holds the workspace */
  private async planHeld(sandbox: PlanSandbox, root: string, env: string, by: string): Promise<RunnerPlanOutcome> {
    const out = await this.planNow(sandbox, root, env);
    const kept = out.status === "planned" && out.changes ? out : undefined;
    await this.record("tofu.plan", {
      action: "plan",
      actor: by,
      env,
      root,
      planId: kept?.planId,
      planHash: kept?.planHash,
      outcome: out.status === "planned" ? (out.changes ? "planned" : "no-changes") : out.status,
      reason: out.status === "planned" ? undefined : out.reason,
      destroys: kept?.destroys,
      replaces: kept?.replaces,
    });
    return out;
  }

  private async planNow(sandbox: PlanSandbox, root: string, env: string): Promise<RunnerPlanOutcome> {
    const out = await sandbox.plan(root, { backend: this.backend(root, env, sandbox.settings.region), keepPlanFile: true });
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
   * Apply the approved plan `planId`; `approvedHash` is the hash the approval
   * carries and `by` the owner session id. A plan that destroys or replaces also
   * needs `confirmDestroy`, the confirmation returned with that plan, which names
   * the resources. Every request is audited, refused ones too.
   */
  async apply(planId: string, approvedHash: string, by: string, confirmDestroy?: string): Promise<RunnerApplyOutcome> {
    const seen: { record?: PlanRecord } = {};
    const out = await this.applyHeld(planId, approvedHash, by, confirmDestroy, seen);
    if (out.status === "refused") {
      await this.record("tofu.apply.refused", {
        action: "apply-refused",
        actor: by,
        env: seen.record?.env,
        root: seen.record?.root,
        planId,
        planHash: seen.record?.planHash ?? approvedHash.slice(0, 128),
        outcome: "refused",
        reason: out.reason,
      });
    }
    return out;
  }

  private async applyHeld(planId: string, approvedHash: string, by: string, confirmDestroy: string | undefined, seen: { record?: PlanRecord }): Promise<RunnerApplyOutcome> {
    const refuse = (reason: string, message: string): RunnerApplyOutcome => ({ status: "refused", reason, message: `tofu runner: ${message}` });
    if (this.settings.mode !== "act") return refuse("observe-mode", "apply is off in observe mode");
    const sandbox = this.sandbox();
    if (!sandbox) return refuse("sandbox-required", "the plan sandbox must be enabled and valid");
    const problem = await this.store.checkDir();
    if (problem) return refuse("plan-dir-unsafe", problem);
    const first = await this.store.get(planId);
    if (!first || first.project !== this.project) return refuse("unknown-plan", "no such plan");
    const key = this.workspace(first.root, first.env);
    if (this.busy.has(key)) return refuse("workspace-busy", "a plan or apply of this root and environment is running");
    this.busy.add(key);
    try {
      // Read again now that the workspace is held: another run may have used this plan up meanwhile
      const record = await this.store.get(planId);
      if (!record || record.project !== this.project) return refuse("unknown-plan", "no such plan");
      seen.record = record;
      if (record.status !== "planned") return refuse("not-approvable", `the plan is ${record.status}`);
      if (this.now().getTime() - Date.parse(record.createdAt) > this.settings.planMaxAgeSeconds * 1000) {
        await this.store.update({ ...record, status: "expired", finishedAt: this.now().toISOString() });
        await this.store.dropFile(planId);
        return refuse("plan-expired", "the plan is too old to apply; plan again");
      }
      if (approvedHash !== record.planHash) return refuse("hash-mismatch", "the approval is for a different plan");
      const file = await this.store.file(planId);
      if (!file || sha256(file) !== record.planHash) return refuse("plan-file-changed", "the plan file is not the approved one");
      const named = [...record.destroys.map((a) => `destroy ${a}`), ...record.replaces.map((a) => `replace ${a}`)];
      if (named.length > 0 && confirmDestroy !== destroyConfirmation(record)) {
        return refuse("destroy-not-confirmed", `this plan would ${named.join(", ")}; it needs its own confirmation (confirmDestroy) naming them`);
      }

      const entry = { actor: by, env: record.env, root: record.root, planId, planHash: record.planHash, destroys: record.destroys, replaces: record.replaces };
      try {
        await this.record("tofu.apply.started", { ...entry, action: "apply-started", outcome: "started" }, true);
      } catch {
        return refuse("audit-unavailable", "the audit log cannot be written, so nothing is applied");
      }
      await this.store.update({ ...record, status: "applying" });
      const finish = async (status: "applied" | "failed" | "stale", reason: string, note?: string) => {
        await this.store.update({ ...record, status, finishedAt: this.now().toISOString(), ...(note ? { note } : {}) });
        await this.store.dropFile(planId);
        console.log(`[tofu-runner] ${this.project}/${record.env} plan ${record.planHash.slice(0, 12)} ${status}`);
        await this.record("tofu.apply.finished", { ...entry, action: "apply-finished", outcome: status, reason });
      };

      let out: Awaited<ReturnType<PlanSandbox["apply"]>>;
      try {
        out = await sandbox.apply(record.root, {
          backend: this.backend(record.root, record.env, sandbox.settings.region),
          roleArn: this.settings.applyRoleArn,
          externalId: this.settings.externalId,
          seconds: APPLY_ROLE_SECONDS,
          timeoutSeconds: this.settings.applyTimeoutSeconds,
          planFile: file,
          codeHash: record.codeHash,
        });
      } catch (e) {
        // The apply may have started: what it changed is unknown. The plan is spent and the owner gets a new one.
        console.warn(`[tofu-runner] ${this.project}/${record.env} apply raised ${e instanceof Error ? e.name : "an error"}`);
        const note = "the apply raised an error before it reported a result; what it changed is unknown, plan again";
        await finish("failed", "error", note);
        return { status: "not-applied", reason: "error", message: `tofu runner: ${note}`, output: "", replan: await this.replan(sandbox, record, by) };
      }

      if (out.status === "applied") {
        await finish("applied", "applied");
        return { status: "applied", output: out.output };
      }
      // Nothing ran: the plan is still the approved one
      if (out.status === "refused" && out.reason !== "code-changed-since-plan") {
        await this.store.update(record);
        return { status: "refused", reason: out.reason, message: out.message };
      }
      const stale = out.status === "refused" || out.reason === "stale";
      await finish(stale ? "stale" : "failed", out.reason);
      return {
        status: "not-applied",
        reason: out.reason,
        message: out.message,
        output: out.status === "failed" ? out.output : "",
        replan: await this.replan(sandbox, record, by),
      };
    } finally {
      this.busy.delete(key);
    }
  }

  /** The plan from the state as it now is; the workspace is already held. An error here is an answer, not an exception. */
  private async replan(sandbox: PlanSandbox, record: PlanRecord, by: string): Promise<RunnerPlanOutcome> {
    try {
      return await this.planHeld(sandbox, record.root, record.env, by);
    } catch (e) {
      console.warn(`[tofu-runner] ${this.project}/${record.env} re-plan raised ${e instanceof Error ? e.name : "an error"}`);
      return { status: "refused", reason: "replan-error", message: "tofu runner: the new plan could not be made; plan again" };
    }
  }

  /**
   * At startup: a plan left `applying` is one Lair stopped in the middle of. What
   * it changed is unknown, so it ends `failed` (its file dropped) and the owner
   * plans again.
   */
  async reconcile(): Promise<number> {
    let n = 0;
    for (const r of await this.store.list()) {
      if (r.project !== this.project || r.status !== "applying") continue;
      const note = "Lair stopped while this apply was running; what it changed is unknown, plan again";
      await this.store.update({ ...r, status: "failed", finishedAt: this.now().toISOString(), note });
      await this.store.dropFile(r.id);
      await this.record("tofu.apply.finished", { action: "apply-finished", actor: "lair", env: r.env, root: r.root, planId: r.id, planHash: r.planHash, outcome: "failed", reason: "interrupted" });
      console.warn(`[tofu-runner] ${this.project}/${r.env} plan ${r.planHash.slice(0, 12)} was applying at shutdown: marked failed`);
      n++;
    }
    return n;
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
      planMaxAgeSeconds: s.planMaxAgeSeconds,
      // Apply does not consult the cloud money guard or a cost estimate yet
      moneyGuardConsulted: false as const,
    };
  }

  async plans(): Promise<PlanRecord[]> {
    return (await this.store.list()).filter((r) => r.project === this.project);
  }

  async audit(limit = 100): Promise<AuditEntry[]> {
    return (await this.auditLog.read(limit)).filter((e) => e.project === this.project);
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
  async audit(): Promise<AuditEntry[]> {
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

  /** Once at startup, after `load`: end the applies a stop left half done (see TofuRunner.reconcile) */
  async reconcile(): Promise<void> {
    for (const runner of this.runners.values()) {
      if (!(runner instanceof TofuRunner)) continue;
      try {
        await runner.reconcile();
      } catch (e) {
        console.warn(`[tofu-runner] ${runner.project}: reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  get(project: string): TofuRunner | BlockedTofuRunner | undefined {
    return this.runners.get(project);
  }

  status(project: string) {
    return this.runners.get(project)?.status() ?? { enabled: false as const, errors: [] as string[] };
  }
}
