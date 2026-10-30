/**
 * The policy scan as a gate in front of `plan`. Off unless a project sets
 * `infra_policy.enabled: true`. The OpenTofu runner (a later PR) runs its
 * plan through InfraPolicy.guardPlan, so no plan starts on code that fails
 * the scan.
 */
import { parseInfraPolicyConfig, type InfraPolicySettings } from "./config.js";
import { agentMessage, scanRoot, type ScanResult } from "./scan.js";

export type GuardResult<T> =
  | { status: "refused"; message: string; scan: ScanResult }
  | { status: "planned"; scan: ScanResult; result: T };

export class InfraPolicy {
  private readonly last = new Map<string, { at: string; result: ScanResult }>();

  constructor(
    readonly project: string,
    readonly settings: InfraPolicySettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private known(root: string): void {
    if (!this.settings.roots.includes(root)) throw new Error(`not a configured root: ${root}`);
  }

  /** Scan a configured root. */
  scan(root: string): ScanResult {
    this.known(root);
    const result = scanRoot(root, this.settings);
    this.last.set(root, { at: this.now().toISOString(), result });
    return result;
  }

  /**
   * Run `plan` only if the root passes the scan. A refusal never calls
   * `plan`, and its `message` (what an agent may see) is the rule names only.
   */
  async guardPlan<T>(root: string, plan: () => Promise<T>): Promise<GuardResult<T>> {
    const scan = this.scan(root);
    if (!scan.ok) return { status: "refused", message: agentMessage(scan), scan };
    return { status: "planned", scan, result: await plan() };
  }

  status() {
    return {
      enabled: true as const,
      roots: this.settings.roots.map((root) => ({ root, last: this.last.get(root) ?? null })),
    };
  }
}

export interface ProjectEntry {
  name: string;
  config?: { infra_policy?: Record<string, unknown> };
  error?: string;
}

/** One InfraPolicy per project with `infra_policy.enabled: true`. */
export class InfraPolicyManager {
  private readonly policies = new Map<string, InfraPolicy>();
  private readonly problems = new Map<string, string[]>();

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const parsed = parseInfraPolicyConfig(entry.config.infra_policy);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[infra-policy] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (parsed.settings.enabled) this.policies.set(entry.name, new InfraPolicy(entry.name, parsed.settings));
    }
  }

  get(project: string): InfraPolicy | undefined {
    return this.policies.get(project);
  }

  status(project: string) {
    const policy = this.policies.get(project);
    if (policy) return policy.status();
    return { enabled: false as const, errors: this.problems.get(project) ?? [] };
  }
}
