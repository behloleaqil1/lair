/**
 * The policy scan as a gate in front of `plan`. Off unless a project sets
 * `infra_policy.enabled: true`. The OpenTofu runner (a later PR) runs its
 * plan through the policy's guardPlan, so no plan starts on code that fails
 * the scan.
 *
 * A runner asks `manager.requires(project)` and, when it is true, plans only
 * through `manager.get(project).guardPlan`. A project whose `infra_policy`
 * block is invalid (and not explicitly `enabled: false`) holds a blocked
 * policy whose guardPlan always refuses: a typo never turns the scan off.
 *
 * The scan reads the live directory and `plan` runs afterwards, so code could
 * change in between. The plan runner (a later PR) must plan a copy taken
 * after the scan, or compare a content hash before and after.
 */
import { parseInfraPolicyConfig, type InfraPolicySettings } from "./config.js";
import { agentMessage, scanRoot, type ScanOptions, type ScanResult } from "./scan.js";

export type GuardResult<T> =
  | { status: "refused"; message: string; scan: ScanResult }
  | { status: "planned"; scan: ScanResult; result: T };

/** What the plan runner and the routes use, for a working policy and a blocked one */
export interface PolicyGate {
  readonly project: string;
  /** The roots the scan may read */
  readonly roots: string[];
  scan(root: string): Promise<ScanResult>;
  guardPlan<T>(root: string, plan: () => Promise<T>): Promise<GuardResult<T>>;
  status(): Record<string, unknown>;
}

export class InfraPolicy implements PolicyGate {
  private readonly last = new Map<string, { at: string; result: ScanResult }>();

  constructor(
    readonly project: string,
    readonly settings: InfraPolicySettings,
    private readonly now: () => Date = () => new Date(),
    private readonly scanOptions: ScanOptions = {},
  ) {}

  get roots(): string[] {
    return this.settings.roots;
  }

  private known(root: string): void {
    if (!this.settings.roots.includes(root)) throw new Error(`not a configured root: ${root}`);
  }

  /** Scan a configured root. */
  async scan(root: string): Promise<ScanResult> {
    this.known(root);
    const result = await scanRoot(root, this.settings, this.scanOptions);
    this.last.set(root, { at: this.now().toISOString(), result });
    return result;
  }

  /**
   * Run `plan` only if the root passes the scan. A refusal never calls
   * `plan`, and its `message` (what an agent may see) is the rule names only.
   */
  async guardPlan<T>(root: string, plan: () => Promise<T>): Promise<GuardResult<T>> {
    const scan = await this.scan(root);
    if (!scan.ok) return { status: "refused", message: agentMessage(scan), scan };
    return { status: "planned", scan, result: await plan() };
  }

  status() {
    return {
      enabled: true as const,
      blocked: false as const,
      roots: this.settings.roots.map((root) => ({ root, last: this.last.get(root) ?? null })),
    };
  }
}

/** A project that asked for the scan with a config that cannot be read: every plan is refused */
export class BlockedInfraPolicy implements PolicyGate {
  readonly roots: string[] = [];

  constructor(
    readonly project: string,
    readonly errors: string[],
  ) {}

  private result(): ScanResult {
    return {
      ok: false,
      violations: [{ rule: "invalid-config", file: ".", line: 1, detail: this.errors.join("; ") }],
      allowed: [],
      filesScanned: 0,
      modulesScanned: 0,
    };
  }

  async scan(): Promise<ScanResult> {
    return this.result();
  }

  async guardPlan<T>(): Promise<GuardResult<T>> {
    const scan = this.result();
    return { status: "refused", message: agentMessage(scan), scan };
  }

  status() {
    return { enabled: true as const, blocked: true as const, errors: this.errors, roots: [] };
  }
}

export interface ProjectEntry {
  name: string;
  config?: { infra_policy?: Record<string, unknown> };
  error?: string;
}

/** One policy per project that has `infra_policy` enabled, or enabled with a block that is invalid (blocked). */
export class InfraPolicyManager {
  private readonly policies = new Map<string, PolicyGate>();

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const raw = entry.config.infra_policy;
      const parsed = parseInfraPolicyConfig(raw);
      if (!parsed.ok) {
        // Off only when the block says so itself; a typo or a bad value must not turn the scan off
        const disabled = typeof raw === "object" && raw !== null && (raw as { enabled?: unknown }).enabled === false;
        console.warn(`[infra-policy] ${entry.name}: ${parsed.errors.join("; ")}`);
        if (!disabled) this.policies.set(entry.name, new BlockedInfraPolicy(entry.name, parsed.errors));
        continue;
      }
      if (parsed.settings.enabled) this.policies.set(entry.name, new InfraPolicy(entry.name, parsed.settings));
    }
  }

  /** The policy to plan through, or undefined when the project has none (the scan is off) */
  get(project: string): PolicyGate | undefined {
    return this.policies.get(project);
  }

  /** True when plans of this project must go through guardPlan (the scan is on, or blocked by a bad config) */
  requires(project: string): boolean {
    return this.policies.has(project);
  }

  status(project: string) {
    const policy = this.policies.get(project);
    if (policy) return policy.status();
    return { enabled: false as const, errors: [] as string[] };
  }
}
