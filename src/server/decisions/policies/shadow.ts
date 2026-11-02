/**
 * Shadow mode (design §5): when a decision is raised, each proposer writes its proposal into the policy
 * trace. The proposal is never shown with the decision, never applied, and never returned for an open
 * decision. This file is handed a reader that can get a decision, page through the open ones and write trace
 * rows, and nothing else: `answer`, `withdraw` and `raise` do not exist on it.
 */
import type { Decision } from "../../../shared/decision-types.js";
import type { OpenDecisionCursor, PolicyTraceRow } from "../store.js";
import type { Proposer } from "./types.js";

export interface ShadowSource {
  get(id: string): Decision | null;
  /** Open decisions with a class, oldest first, after `after` */
  openPage(after: OpenDecisionCursor | null, limit: number): OpenDecisionCursor[];
  recordPolicyTrace(row: PolicyTraceRow): boolean;
  hasPolicyTrace(decisionId: string, proposer: string, version: string): boolean;
}

/** A real object with those four methods, so there is nothing to cast to. */
export function shadowSource(source: ShadowSource): ShadowSource {
  return Object.freeze({
    get: (id: string) => source.get(id),
    openPage: (after: OpenDecisionCursor | null, limit: number) => source.openPage(after, limit),
    recordPolicyTrace: (row: PolicyTraceRow) => source.recordPolicyTrace(row),
    hasPolicyTrace: (id: string, proposer: string, version: string) => source.hasPolicyTrace(id, proposer, version),
  });
}

/** How the catch-up at start walks the open decisions: pages of `batch`, yielding to the event loop between them. */
export interface CatchUpOptions {
  batch?: number;
  /** Checked before each page: true stops the walk (the server is closing) */
  stopped?: () => boolean;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
   * Decisions raised while Lair was down, or before the table last changed, get their row too: every open
   * decision with a class and no row for the current version is proposed for, oldest first, a page at a time,
   * with a turn of the event loop between pages, so a long backlog never stalls the server. Rows are unique per
   * decision, proposer and version, so running it twice (a restart), or beside a live `decision.raised`, writes
   * nothing new. Resolves with the rows written; never rejects.
   */
  async catchUp(options: CatchUpOptions = {}): Promise<number> {
    const batch = Math.max(1, options.batch ?? 100);
    let written = 0;
    let after: OpenDecisionCursor | null = null;
    try {
      while (!options.stopped?.()) {
        const page = this.source.openPage(after, batch);
        for (const d of page) written += this.propose(d.id).length;
        if (page.length < batch) break;
        after = page[page.length - 1];
        await nextTurn();
      }
    } catch (e) {
      this.log(`decision policies: catch-up failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return written;
  }
}
