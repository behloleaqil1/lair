/**
 * Shadow mode (design §5): when a decision is raised, the best model writes
 * its proposal into a trace. The proposal is never shown with the decision,
 * never applied and never returned by a route for an open decision; once the
 * decision is answered it is compared with the answer. This file reads
 * decisions and never imports the code that answers them.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "fs";
import type { Decision } from "../../shared/decision-types.js";
import { BenchModelError } from "../brain-bench/types.js";
import { labelOf, queryOf, shapeOf } from "./examples.js";
import { propose } from "./model.js";
import type { ModelStore } from "./store.js";
import type { TreeModel } from "./types.js";

export const MAX_TRACE_BYTES = 16 * 1024 * 1024;

/** Written for each decision raised while a model shadows. `option` is null when the model abstained. */
export interface ShadowProposal {
  decisionId: string;
  class: string;
  proposer: "classifier";
  version: string;
  option: string | null;
  reasonCode: string;
  confidence: number;
  at: string;
}

/** The only part of the Decision Inbox the shadow can touch: reading. */
export interface DecisionReader {
  get(id: string): Decision | null;
  list(options: { status?: "answered"; limit?: number }): Decision[];
}

/**
 * A real get/list-only wrapper, not the inbox typed as a reader: the object
 * the trainer holds has exactly these two methods, so there is nothing to cast
 * to (`answer`, `withdraw` and `raise` do not exist on it).
 */
export function readOnlyDecisions(source: DecisionReader): DecisionReader {
  return Object.freeze({
    get: (id: string) => source.get(id),
    list: (options: { status?: "answered"; limit?: number }) => source.list(options),
  });
}

interface Loaded {
  version: string;
  model: TreeModel;
}

export class ShadowRecorder {
  private loaded: Loaded | null = null;

  constructor(
    private readonly store: ModelStore,
    private readonly reader: DecisionReader,
    private readonly confidenceFloor: () => number,
    /** Answers that turned out bad, as the model's veto keys: a proposal equal to one is an abstain */
    private readonly vetoes: () => ReadonlySet<string> = () => new Set(),
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private current(): Loaded | null {
    const best = this.store.best();
    if (!best) return null;
    if (this.loaded?.version === best.version) return this.loaded;
    const model = this.store.loadModel(best.version);
    if (!model) return null;
    this.loaded = { version: best.version, model };
    return this.loaded;
  }

  /** The bus's decision.raised data. Never throws: a failing shadow must not hold up a decision. */
  onRaised(data: Record<string, unknown>): ShadowProposal | null {
    try {
      const id = data.decisionId;
      if (typeof id !== "string") return null;
      const decision = this.reader.get(id);
      const shape = decision ? shapeOf(decision) : null;
      const loaded = this.current();
      if (!decision || !shape || !loaded) return null;
      let proposal: ShadowProposal;
      const base = { decisionId: id, class: shape.classKey, proposer: "classifier" as const, version: loaded.version, at: this.now().toISOString() };
      try {
        const answer = propose(loaded.model, queryOf(shape), this.vetoes());
        proposal =
          answer.confidence < this.confidenceFloor()
            ? { ...base, option: null, reasonCode: "below_floor", confidence: answer.confidence }
            : { ...base, option: answer.option, reasonCode: answer.reasonCode, confidence: answer.confidence };
      } catch (e) {
        if (!(e instanceof BenchModelError)) throw e;
        proposal = { ...base, option: null, reasonCode: "abstain", confidence: 0 };
      }
      this.append(proposal);
      return proposal;
    } catch (e) {
      this.log(`brain trainer: shadow proposal failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private append(p: ShadowProposal): void {
    const path = this.store.shadowTracePath;
    if (existsSync(path) && statSync(path).size > MAX_TRACE_BYTES) return;
    appendFileSync(path, `${JSON.stringify(p)}\n`, { mode: 0o600 });
  }

  proposals(): ShadowProposal[] {
    return this.readProposals().proposals;
  }

  /** The trace; a line that is not a proposal is skipped and counted, never an error. */
  readProposals(): { proposals: ShadowProposal[]; skipped: number } {
    const path = this.store.shadowTracePath;
    if (!existsSync(path)) return { proposals: [], skipped: 0 };
    if (statSync(path).size > MAX_TRACE_BYTES * 2) return { proposals: [], skipped: 1 };
    const proposals: ShadowProposal[] = [];
    let skipped = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const o = JSON.parse(line) as ShadowProposal | null;
        if (typeof o !== "object" || o === null || typeof o.decisionId !== "string" || typeof o.class !== "string" || typeof o.version !== "string") throw new Error("not a proposal");
        proposals.push(o);
      } catch {
        skipped++;
      }
    }
    return { proposals, skipped };
  }

  /** Per class and model version: proposals compared with the answers given. Open decisions are left out. */
  agreement(): AgreementRow[] {
    const rows = new Map<string, AgreementRow>();
    for (const p of this.proposals()) {
      const d = this.reader.get(p.decisionId);
      const answer = d ? labelOf(d) : null;
      if (answer === null) continue;
      const key = `${p.class}\u0000${p.version}`;
      const row = rows.get(key) ?? { class: p.class, version: p.version, compared: 0, agreed: 0, abstained: 0, wrongConfident: 0 };
      row.compared++;
      if (p.option === null) row.abstained++;
      else if (p.option === answer) row.agreed++;
      else row.wrongConfident++;
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => (a.class + a.version).localeCompare(b.class + b.version));
  }
}

export interface AgreementRow {
  class: string;
  version: string;
  compared: number;
  agreed: number;
  abstained: number;
  /** Proposed an option other than the answer, at or above the confidence floor */
  wrongConfident: number;
}
