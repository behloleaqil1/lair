/**
 * One Decision Inbox item per hold that only the owner lifts
 * (docs/configuration.md#one-decision-per-hold): a module that keeps such
 * holds (review's merge holds, delivery's held services) asks through this.
 *
 * - ensure(): the hold started: its decision is raised, unless it is open
 *   already or was answered (the inbox's record tells, across restarts).
 * - lifted(): the hold lifted another way (released where it is shown): its
 *   open decision is withdrawn.
 * - reconcile(): every current hold has its decision, and every open one
 *   whose hold is gone is withdrawn: what a restart or a crash between the
 *   hold and its decision left behind.
 * - Answering "release" lifts the hold through the module's own owner path
 *   (`lift`); "keep" leaves the hold as the owner's choice, and nothing more
 *   is asked about it.
 *
 * Nothing here throws into the module: the hold itself never depends on the
 * inbox, so a refused or failed raise is logged and tried again on the next
 * reconcile.
 */
import type { Decision, DecisionLink } from "../../shared/decision-types.js";
import type { DecisionProducer } from "./types.js";

/** The option that lifts the hold */
export const HOLD_RELEASE = "release";
/** The option that keeps it (the owner's choice: nothing more is asked) */
export const HOLD_KEEP = "keep";

export interface OwnerHold {
  /** Stable per hold, e.g. "hold:<id>": one decision per key */
  key: string;
  /** What the hold is about, e.g. "pr:12" */
  ref: string;
  /** One plain sentence: what is held and what that stops */
  title: string;
  /** Who held it, why, and what each answer does (markdown) */
  context: string;
  releaseLabel: string;
  releaseConsequences: string;
  keepLabel: string;
  keepConsequences: string;
  /** References of the work that waits on it */
  blocks?: string[];
  links?: DecisionLink[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Someone else's text for a decision's context: control characters other
 * than newlines and tabs become spaces (the inbox refuses them), backticks
 * quotes (it goes in a code block), cut at `max`.
 */
export function asContextText(text: string, max = 1000): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const keep = code === 0x0a || code === 0x09;
    out += (code < 0x20 && !keep) || code === 0x7f ? " " : ch === "`" ? "'" : ch;
  }
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

export class HoldDecisions {
  private producer: DecisionProducer | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly module: string,
    private readonly project: string,
  ) {}

  /**
   * Ask through `producer` and follow its answers: `lift` runs for each
   * "release" answer with the hold's key (it lifts the hold through the
   * module's owner path; a throw makes the inbox deliver it again).
   */
  use(producer: DecisionProducer, lift: (key: string, decision: Decision) => Promise<void>): void {
    this.unsubscribe?.();
    this.producer = producer;
    this.unsubscribe = producer.onResolved(
      this.module,
      async (resolution) => {
        if (resolution.optionId === HOLD_RELEASE) await lift(resolution.decision.key, resolution.decision);
      },
      { project: this.project },
    );
  }

  /** Stop following answers (the module stops; answers wait in the inbox for the next one). */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The hold's decision, as the inbox has it now (null without one, or without the inbox). */
  decisionFor(key: string): Decision | null {
    return this.producer?.find(this.project, this.module, key) ?? null;
  }

  /** Raise the hold's decision unless it is open or was answered. True when this call raised it. */
  async ensure(hold: OwnerHold): Promise<boolean> {
    const producer = this.producer;
    if (!producer) return false;
    try {
      const known = producer.find(this.project, this.module, hold.key);
      if (known && known.status !== "withdrawn") return false;
      const { created } = await producer.raise({
        project: this.project,
        kind: "other",
        title: hold.title,
        context: hold.context,
        options: [
          { id: HOLD_RELEASE, label: hold.releaseLabel, consequences: hold.releaseConsequences },
          { id: HOLD_KEEP, label: hold.keepLabel, consequences: hold.keepConsequences },
        ],
        recommended: {
          optionId: HOLD_KEEP,
          reasoning: "Whoever held it had a reason: release it once that reason is gone.",
        },
        source: { module: this.module, ref: hold.ref },
        key: hold.key,
        blocks: hold.blocks ?? [],
        links: hold.links ?? [],
      });
      return created;
    } catch (e) {
      console.warn(`[${this.module}] ${this.project}: could not ask about hold ${hold.key}: ${message(e)}`);
      return false;
    }
  }

  /** The hold lifted another way: withdraw its open decision. True when one was withdrawn. */
  async lifted(key: string, reason: string): Promise<boolean> {
    const producer = this.producer;
    if (!producer) return false;
    const open = producer.find(this.project, this.module, key);
    if (!open || open.status !== "open") return false;
    try {
      await producer.withdraw(open.id, { module: this.module, reason: reason.slice(0, 1000) });
      return true;
    } catch (e) {
      // Answered meanwhile: moot either way
      console.warn(`[${this.module}] ${this.project}: could not withdraw the decision of hold ${key}: ${message(e)}`);
      return false;
    }
  }

  /** Every hold in `holds` has its decision; every open decision of a hold not in it is withdrawn. */
  async reconcile(holds: readonly OwnerHold[], reason: (key: string) => string): Promise<void> {
    const producer = this.producer;
    if (!producer) return;
    for (const hold of holds) await this.ensure(hold);
    const current = new Set(holds.map((h) => h.key));
    for (const decision of producer.openOf(this.project, this.module)) {
      if (!current.has(decision.key)) await this.lifted(decision.key, reason(decision.key));
    }
  }
}
