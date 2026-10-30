/** Turning answered decisions and bench cases into labelled examples, and the label rules. */
import type { Decision } from "../../shared/decision-types.js";
import type { BenchCase } from "../brain-bench/types.js";
import type { Example, Outcome } from "./types.js";

const CLASS_PART = /^[A-Za-z0-9._-]{1,64}$/;

/** `module/kind/option+option`: stable for a class of decision, never taken from prose. */
export function classKeyOf(module: string, kind: string, optionIds: string[], evidenceClass?: unknown): string {
  if (typeof evidenceClass === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(evidenceClass)) return evidenceClass;
  const ids = [...optionIds].sort().join("+");
  return `${module}/${kind}/${ids}`.slice(0, 200);
}

function validTime(at: string): boolean {
  return Number.isFinite(Date.parse(at));
}

/**
 * The label of an answered decision, or null when it is no label: still open,
 * withdrawn, or an expiry default that Lair applied (nobody chose it).
 */
export function labelOf(d: Decision): string | null {
  if (d.status !== "answered" || !d.answer) return null;
  if (d.answeredBy === "lair") return null;
  return d.options.some((o) => o.id === d.answer?.optionId) ? d.answer.optionId : null;
}

/** What a decision looks like to a model: structured fields only (no title, context or note). */
export type Shape = Omit<Example, "label" | "outcome">;

export function shapeOf(d: Decision): Shape | null {
  if (!validTime(d.createdAt)) return null;
  if (!d.options.every((o) => CLASS_PART.test(o.id))) return null;
  const optionIds = d.options.map((o) => o.id);
  return {
    id: d.id,
    at: new Date(d.createdAt).toISOString(),
    classKey: classKeyOf(d.source.module, d.kind, optionIds),
    kind: d.kind,
    module: d.source.module,
    evidence: { attention: d.attention, links: d.links.length, blocks: d.blocks.length },
    options: d.options.map((o) => ({ id: o.id, label: o.label })),
    recommended: d.recommended.optionId,
  };
}

/** An example from an answered decision in the inbox. */
export function exampleFromDecision(d: Decision): Example | null {
  const label = labelOf(d);
  const shape = label === null ? null : shapeOf(d);
  return shape === null || label === null ? null : { ...shape, label, outcome: "unknown" };
}

/** An example from a bench case that carries a time (`at`) and maybe an outcome. */
export function exampleFromCase(c: BenchCase): Example | null {
  if (c.at === undefined || !validTime(c.at)) return null;
  return {
    id: c.id,
    at: new Date(c.at).toISOString(),
    classKey: classKeyOf(c.module, c.kind, c.options.map((o) => o.id), c.evidence.title_class ?? c.evidence.class),
    kind: c.kind,
    module: c.module,
    evidence: c.evidence,
    options: c.options,
    recommended: c.recommended,
    label: c.label,
    outcome: c.outcome ?? "unknown",
  };
}

export interface LabelSets {
  /** Examples a model may learn from: answered, not bad, not pending */
  positive: Example[];
  /** The answer was marked bad: never a positive label; a proposal equal to it is vetoed */
  negative: Example[];
  /** Outcome not resolved yet: not a label until it is */
  pending: Example[];
}

export function splitLabels(examples: Example[]): LabelSets {
  const sets: LabelSets = { positive: [], negative: [], pending: [] };
  for (const e of examples) {
    const outcome: Outcome = e.outcome;
    if (outcome === "bad") sets.negative.push(e);
    else if (outcome === "pending") sets.pending.push(e);
    else sets.positive.push(e);
  }
  return sets;
}

/** A case file's examples; the number of cases without a usable time is returned for the report. */
export function examplesFromCases(cases: BenchCase[]): { examples: Example[]; unusable: number } {
  const examples: Example[] = [];
  let unusable = 0;
  for (const c of cases) {
    const e = exampleFromCase(c);
    if (e) examples.push(e);
    else unusable++;
  }
  return { examples, unusable };
}

/** What a model is asked: the class becomes the kind, so the bench scores per class. Never carries the label. */
export function queryOf(e: Shape): Omit<BenchCase, "label"> {
  return {
    id: e.id,
    kind: e.classKey,
    module: e.module,
    evidence: { ...e.evidence, decision_kind: e.kind },
    options: e.options,
    at: e.at,
    ...(e.recommended ? { recommended: e.recommended } : {}),
  };
}

/** An example back as a bench case */
export function toBenchCase(e: Example): BenchCase {
  return { ...queryOf(e), label: e.label };
}
