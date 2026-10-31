/**
 * The Decision Inbox, as the agents module needs it (docs/design/autonomy.md
 * §1). In the server the agents module raises its decisions in the real
 * inbox (src/server/decisions/) through ProducerDecisions, and follows the
 * answers (AgentsManager.useDecisions). Without the inbox, or when raising
 * fails, decisions are written as `OWNER?` entries to the project's inbox
 * file, the convention the Decision Inbox importers read.
 */
import { randomUUID } from "crypto";
import type {
  Decision,
  DecisionEffect,
  DecisionKind as InboxKind,
  DecisionStructure,
} from "../../shared/decision-types.js";
import type { DecisionProducer, RaiseDecisionInput } from "../decisions/types.js";
import type { Clock, FileSystem } from "../watchdog/probes.js";

/** The module name the agents module raises decisions as. */
export const DECISION_MODULE = "agents";

/** The key of a run chain's escalation, per escalation (`attempts`: the chain's runs when it was escalated). */
export const escalationDecisionKey = (chainId: string, attempts: number) => `escalation:${chainId}:${attempts}`;

export type DecisionKind =
  | "product"
  | "spend"
  | "legal"
  | "security"
  | "credential"
  | "release"
  | "escalation"
  | "other";

export interface DecisionOption {
  /** Lowercase letters, digits, '_' and '-' (the inbox's option ids) */
  id: string;
  label: string;
  /** What happens if this option is chosen */
  consequences?: string;
  /** What choosing it does; every option of a request with a structure needs one */
  effect?: DecisionEffect;
}

export interface DecisionRequest {
  project: string;
  kind: DecisionKind;
  question: string;
  /** Markdown: the evidence and links */
  context: string;
  options: DecisionOption[];
  /** The id of the recommended option */
  recommended?: string;
  why?: string;
  reversible: boolean;
  /** ISO time */
  deadline?: string;
  onTimeout?: "wait" | "recommended" | "cancel";
  /** The module asking, e.g. "agents" */
  requestedBy: string;
  /** Stable identity of the condition; the agents module raises each key once */
  key: string;
  /** What the answer applies to, e.g. "chain:<id>" */
  ref?: string;
  /** References of the work that waits, e.g. "agents:demo:task:feat-login" */
  blocks?: string[];
  /** Policy class and evidence (docs/design/decision-policies.md §4) */
  structure?: DecisionStructure;
}

export interface DecisionInbox {
  /** Raise a decision. Resolves with its id and where it went. */
  request(decision: DecisionRequest): Promise<{ id: string; via: string }>;
  /**
   * The Decision Inbox's latest decision of this module with this key (null
   * when there is none). Absent: this inbox can't tell (the inbox file).
   */
  find?(project: string, key: string): Decision | null;
  /** This module's open decisions in the project. Absent: this inbox can't tell. */
  open?(project: string): Decision[];
  /** Withdraw an open decision whose condition is gone. Absent: this inbox can't. */
  withdraw?(id: string, reason: string): Promise<void>;
  /** Tell the inbox an open decision's cause cleared (docs/design/decision-policies.md §4). Absent: this inbox can't. */
  causeCleared?(id: string): Promise<void>;
}

function oneLine(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** An inbox entry for a decision. */
export function formatDecision(decision: DecisionRequest, id: string, at: string): string {
  const options = decision.options
    .map((o) => `${o.id} = ${o.label}${o.id === decision.recommended ? " (recommended)" : ""}`)
    .join("; ");
  const lines = [
    `- OWNER? ${at} [agents:${id.slice(0, 8)}] ${decision.project}: ${oneLine(decision.question)} (${decision.kind})`,
    ...decision.context
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 20)
      .map((line) => `  - ${oneLine(line.replace(/^[-*]\s+/, ""))}`),
  ];
  if (options) lines.push(`  - options: ${oneLine(options)}`);
  if (decision.why) lines.push(`  - why: ${oneLine(decision.why)}`);
  return lines.join("\n") + "\n";
}

/** Control characters (log colours, ...) become spaces; newlines and tabs stay when `keepLines`. */
function printable(text: string, keepLines: boolean): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const line = code === 0x0a || code === 0x09 || code === 0x0d;
    out += (code < 0x20 && !(keepLines && line)) || code === 0x7f ? " " : ch;
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The inbox's kind for an agents decision: spend and escalation; anything else is other. */
export function inboxKind(kind: DecisionKind): InboxKind {
  return kind === "spend" || kind === "escalation" ? kind : "other";
}

/** An agents decision as the Decision Inbox takes it (see src/server/decisions/validate.ts). */
export function toRaiseInput(decision: DecisionRequest): RaiseDecisionInput {
  const options = decision.options.map((o) => ({
    id: o.id,
    label: clip(oneLine(printable(o.label, false), 200), 120),
    consequences: clip(printable(o.consequences ?? o.label, true).trim(), 1000),
    ...(o.effect ? { effect: o.effect } : {}),
  }));
  const recommended = options.some((o) => o.id === decision.recommended) ? decision.recommended! : options[0].id;
  return {
    project: decision.project,
    kind: inboxKind(decision.kind),
    title: clip(oneLine(printable(decision.question, false), 400), 200),
    context: clip(printable(decision.context, true).trim() || decision.question, 20000),
    options,
    recommended: { optionId: recommended, reasoning: clip(printable(decision.why ?? "Lair recommends it.", true), 2000) },
    source: { module: DECISION_MODULE, ref: clip(printable(decision.ref ?? decision.key, false), 200) },
    key: clip(printable(decision.key, false), 200),
    blocks: (decision.blocks ?? []).map((b) => clip(printable(b, false), 200)),
    ...(decision.structure ? { class: decision.structure.class, evidence: decision.structure.evidence } : {}),
  };
}

/**
 * Raises decisions in the Decision Inbox (src/server/decisions/), the way
 * the server does. When the inbox refuses one (or fails), `fallback` (the
 * inbox file) takes it, so the owner still hears.
 */
export class ProducerDecisions implements DecisionInbox {
  /**
   * Present only with `evidenceUpdates` (the decision policies are on, data/server.yaml
   * decision_policies.enabled): without it the agents module never changes a raised decision's evidence.
   */
  readonly causeCleared?: (id: string) => Promise<void>;

  constructor(
    private producer: DecisionProducer,
    private fallback: DecisionInbox,
    options: { evidenceUpdates?: boolean } = {},
  ) {
    if (options.evidenceUpdates) {
      this.causeCleared = async (id: string) => {
        await this.producer.updateEvidence(id, { module: DECISION_MODULE, cause_cleared: true });
      };
    }
  }

  find(project: string, key: string): Decision | null {
    return this.producer.find(project, DECISION_MODULE, key);
  }

  open(project: string): Decision[] {
    return this.producer.openOf(project, DECISION_MODULE);
  }

  async withdraw(id: string, reason: string): Promise<void> {
    await this.producer.withdraw(id, { module: DECISION_MODULE, reason: clip(printable(reason, false), 1000) });
  }

  async request(decision: DecisionRequest): Promise<{ id: string; via: string }> {
    try {
      const { decision: raised, created } = await this.producer.raise(toRaiseInput(decision));
      return { id: raised.id, via: created ? "Decision Inbox" : "Decision Inbox (already open)" };
    } catch (e) {
      const written = await this.fallback.request(decision);
      return {
        id: written.id,
        via: `${written.via}: the Decision Inbox refused it (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }
}

/** Appends decisions to the project's inbox file (or keeps them in the store only, when it has none). */
export class InboxFileDecisions implements DecisionInbox {
  constructor(
    private target: (project: string) => string | undefined,
    private fs: Pick<FileSystem, "append">,
    private clock: Pick<Clock, "now">,
  ) {}

  async request(decision: DecisionRequest): Promise<{ id: string; via: string }> {
    const id = randomUUID();
    const file = this.target(decision.project);
    if (!file) return { id, via: "store only (no inbox_file)" };
    try {
      this.fs.append(file, formatDecision(decision, id, new Date(this.clock.now()).toISOString()));
      return { id, via: `inbox file ${file}` };
    } catch (e) {
      return { id, via: `store only (could not write ${file}: ${e instanceof Error ? e.message : String(e)})` };
    }
  }
}
