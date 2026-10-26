/**
 * The Decision Inbox, as the agents module needs it (docs/design/autonomy.md
 * §1): a small interface the decisions module implements. Until one is
 * registered (AgentsManager.setDecisionInbox), decisions are written as
 * `OWNER?` entries to the project's inbox file, the convention the Decision
 * Inbox importers read.
 */
import { randomUUID } from "crypto";
import type { Clock, FileSystem } from "../watchdog/probes.js";

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
  id: string;
  label: string;
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
}

export interface DecisionInbox {
  /** Raise a decision. Resolves with its id and where it went. */
  request(decision: DecisionRequest): Promise<{ id: string; via: string }>;
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
