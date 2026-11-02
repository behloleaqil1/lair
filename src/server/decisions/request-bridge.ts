/**
 * Decision requests from modules that speak the design note's shape
 * (`DecisionRequest` in gates/decision-hook.ts: string options, kinds such
 * as `product`, `credential` and `release`) become Decision Inbox items.
 *
 * Two ways in, both raised in the server (not over HTTP):
 * - InboxDecisionHook, a DecisionHook a module can be given directly;
 * - listenForDecisionRequests(), which takes the `decision.needed` events
 *   that the default EventBusDecisionHook emits. mountDecisions() wires it,
 *   so gate pipelines' decisions (the GitHub-hosted minutes budget) land in
 *   the inbox with no change to the pipelines module.
 *
 * Answers go to the module named in `requestedBy` through onResolved(). A
 * module that doesn't listen yet (gate pipelines don't) keeps its answers
 * waiting in the inbox; they are delivered when it starts listening.
 */
import { z } from "zod";
import type { EventBus } from "../core/event-bus.js";
import type { DecisionKind, DecisionOption } from "../../shared/decision-types.js";
import type { DecisionHook, DecisionRequest } from "../gates/decision-hook.js";
import type { DecisionProducer, RaiseDecisionInput } from "./types.js";

/** The design note's kinds, as the inbox names them. */
const KINDS: Record<DecisionRequest["kind"], DecisionKind> = {
  product: "pricing",
  spend: "spend",
  legal: "legal",
  security: "security",
  credential: "credentials",
  release: "go_no_go",
  escalation: "escalation",
  other: "other",
};

const RequestSchema = z.object({
  key: z.string().min(1),
  project: z.string().min(1),
  kind: z.enum(["product", "spend", "legal", "security", "credential", "release", "escalation", "other"]),
  question: z.string().min(1),
  context: z.string().min(1),
  options: z.array(z.string().min(1)).min(1).max(10),
  recommended: z.string(),
  why: z.string().min(1),
  reversible: z.boolean(),
  onTimeout: z.enum(["wait", "recommended", "cancel"]),
  requestedBy: z.string().min(1),
  // Shape-checked by the inbox when it is raised
  structure: z.custom<NonNullable<DecisionRequest["structure"]>>((v) => typeof v === "object" && v !== null).optional(),
});

function printable(text: string, keepNewlines: boolean): string {
  return [...text]
    .map((ch) => {
      if (keepNewlines && (ch === "\n" || ch === "\t")) return ch;
      return ch < " " || ch === "\u007f" ? " " : ch;
    })
    .join("");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function oneLine(text: string, max: number): string {
  return clip(printable(text, false).replace(/\s+/g, " ").trim(), max);
}

/** Readable option ids from the labels: "Keep the budget" -> keep_the_budget. */
function optionIds(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, i) => {
    let base = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 40)
      .replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(base)) base = `option_${i + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 37)}_${n}`;
    used.add(id);
    return id;
  });
}

/**
 * The inbox decision for a request. `onTimeout` is not carried over: the
 * request has no deadline, so the decision waits for an answer. A request
 * whose `kind` the inbox never defaults would wait anyway.
 */
export function toDecisionInput(request: DecisionRequest): RaiseDecisionInput {
  const ids = optionIds(request.options);
  const options: DecisionOption[] = request.options.map((label, i) => ({
    id: ids[i],
    label: oneLine(label, 120),
    consequences: clip(printable(label, true), 1000),
    ...(request.structure ? { effect: request.structure.effects[i] } : {}),
  }));
  const recommended = Math.max(0, request.options.indexOf(request.recommended));
  const module = /^[a-z][a-z0-9_-]{0,39}$/.test(request.requestedBy) ? request.requestedBy : "other";
  return {
    project: request.project,
    kind: KINDS[request.kind],
    title: oneLine(request.question, 200),
    context: clip(
      `${printable(request.context, true)}\n\n${request.reversible ? "This can be undone later." : "This can't be undone."}`,
      20000,
    ),
    options,
    recommended: { optionId: ids[recommended], reasoning: clip(printable(request.why, true), 2000) },
    source: { module, ref: oneLine(request.key, 200) },
    key: oneLine(request.key, 200),
    blocks: [oneLine(request.key, 200)],
    ...(request.structure ? { class: request.structure.class, evidence: request.structure.evidence } : {}),
  };
}

/** A DecisionHook that raises in the Decision Inbox. */
export class InboxDecisionHook implements DecisionHook {
  constructor(private readonly inbox: Pick<DecisionProducer, "raise">) {}

  async needsDecision(request: DecisionRequest): Promise<void> {
    await this.inbox.raise(toDecisionInput(request));
  }
}

/**
 * Raise every `decision.needed` event as an inbox decision. Returns the
 * unsubscribe function. A malformed or refused request is logged and dropped.
 */
export function listenForDecisionRequests(events: EventBus, inbox: Pick<DecisionProducer, "raise">): () => void {
  const hook = new InboxDecisionHook(inbox);
  return events.on("decision.needed", async (event) => {
    const parsed = RequestSchema.safeParse(event.data);
    if (!parsed.success) {
      const where = parsed.error.issues[0]?.path.join(".") || "(data)";
      console.warn(`[decisions] ignored a decision.needed event: ${where} is not valid`);
      return;
    }
    try {
      await hook.needsDecision(parsed.data);
    } catch (e) {
      console.warn(
        `[decisions] could not raise ${parsed.data.requestedBy}'s decision ${parsed.data.key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}
