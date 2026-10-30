/**
 * Shadow mode (design §5): when a decision is raised, each proposer writes its proposal into the policy
 * trace. The proposal is never shown with the decision, never applied, and never returned for an open
 * decision. This file is handed a reader that can get and list decisions and write trace rows, and nothing
 * else: `answer`, `withdraw` and `raise` do not exist on it.
 */
import type { Decision } from "../../../shared/decision-types.js";
import type { PolicyTraceRow } from "../store.js";
import type { Proposer } from "./types.js";

export interface ShadowSource {
  get(id: string): Decision | null;
  list(options: { status?: "open"; limit?: number }): Decision[];
  recordPolicyTrace(row: PolicyTraceRow): boolean;
  hasPolicyTrace(decisionId: string, proposer: string, version: string): boolean;
}

/** A real object with those four methods, so there is nothing to cast to. */
export function shadowSource(source: ShadowSource): ShadowSource {
  return Object.freeze({
    get: (id: string) => source.get(id),
    list: (options: { status?: "open"; limit?: number }) => source.list(options),
    recordPolicyTrace: (row: PolicyTraceRow) => source.recordPolicyTrace(row),
    hasPolicyTrace: (id: string, proposer: string, version: string) => source.hasPolicyTrace(id, proposer, version),
  });
}

export class PolicyShadow {
  constructor(
    private readonly source: ShadowSource,
    private readonly proposers: () => Proposer[],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Propose for one decision; returns the rows newly written. Never throws: a failing shadow must not hold up a decision. */
  propose(decisionId: string): PolicyTraceRow[] {
    const written: PolicyTraceRow[] = [];
    try {
      const decision = this.source.get(decisionId);
      if (!decision || decision.status !== "open") return written;
      const at = this.now();
      for (const proposer of this.proposers()) {
        const version = proposer.version();
        if (this.source.hasPolicyTrace(decisionId, proposer.id, version)) continue;
        const proposal = proposer.propose(decision, at);
        if (!proposal || !decision.class) continue;
        const row: PolicyTraceRow = {
          decisionId,
          proposer: proposer.id,
          version,
          class: decision.class,
          policy: proposal.policy,
          option: proposal.option,
          reasonCode: proposal.reasonCode,
          confidence: proposal.confidence,
          at: at.toISOString(),
        };
        if (this.source.recordPolicyTrace(row)) written.push(row);
      }
    } catch (e) {
      this.log(`decision policies: shadow proposal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return written;
  }

  /** The bus's decision.raised data. */
  onRaised(data: Record<string, unknown>): void {
    if (typeof data.decisionId === "string") this.propose(data.decisionId);
  }

  /**
   * Decisions raised while Lair was down, or before the table last changed, get their row too: an open
   * decision with no row for the current version is proposed for. Rows are unique per decision, proposer and
   * version, so running it twice (a restart) writes nothing new.
   */
  catchUp(limit = 500): number {
    let n = 0;
    try {
      for (const d of this.source.list({ status: "open", limit })) n += this.propose(d.id).length;
    } catch (e) {
      this.log(`decision policies: catch-up failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return n;
  }
}
