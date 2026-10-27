/**
 * Required reviewers per tier: each tier lists slots, and each slot names who
 * may fill it (a human, a named reviewer agent, any peer other than the
 * author, or the author's self-check). One review fills at most one slot, so
 * "two reviews" really means two reviewers.
 */
import type {
  ReviewerOption,
  ReviewerRef,
  ReviewSlot,
  SlotStatus,
  Verdict,
} from "../../shared/review-types.js";

/** A review as slot matching sees it. */
export interface SlotCandidate {
  id: string;
  reviewer: ReviewerRef;
  verdict: Verdict;
  headSha: string;
  /** Superseded by a later review of the same reviewer */
  superseded: boolean;
}

export function optionLabel(option: ReviewerOption): string {
  switch (option.kind) {
    case "human":
      return "a human";
    case "agent":
      return `agent ${option.agent}`;
    case "peer":
      return "a peer other than the author";
    case "self":
      return "the author's self-check";
  }
}

export function slotLabel(slot: ReviewSlot): string {
  const label = slot.anyOf.map(optionLabel).join(" or ");
  return slot.differentModel ? `${label}, on a different model from the author` : label;
}

function isAuthor(reviewer: ReviewerRef, author: ReviewerRef | null): boolean {
  return author !== null && reviewer.id === author.id;
}

/** Why `candidate` can't fill `option`, or null if it can. */
function optionMismatch(
  option: ReviewerOption,
  candidate: SlotCandidate,
  author: ReviewerRef | null,
): string | null {
  const r = candidate.reviewer;
  switch (option.kind) {
    case "human":
      if (r.kind !== "human") return "not a human";
      return isAuthor(r, author) ? "is the author" : null;
    case "agent":
      if (r.kind !== "agent" || r.id !== option.agent) return `not agent ${option.agent}`;
      // An unknown author may be this very agent: its review can't count
      if (author === null) return "the PR's author is unknown";
      return isAuthor(r, author) ? "is the author" : null;
    case "peer":
      if (r.kind === "check") return "a check, not a reviewer";
      if (author === null) return "the PR's author is unknown";
      return isAuthor(r, author) ? "is the author" : null;
    case "self":
      if (author === null) return "the PR's author is unknown";
      return isAuthor(r, author) ? null : "not the author";
  }
}

function modelMismatch(candidate: SlotCandidate, author: ReviewerRef | null): string | null {
  if (candidate.reviewer.kind === "human") return null;
  if (author === null) return "the PR's author is unknown";
  if (!author.model) return "the author's model is unknown";
  if (!candidate.reviewer.model) return "the reviewer's model is unknown";
  return candidate.reviewer.model === author.model ? `uses the author's model ${author.model}` : null;
}

/** Why `candidate` can't fill `slot` at `headSha`, or null if it can. */
export function slotMismatch(
  slot: ReviewSlot,
  candidate: SlotCandidate,
  author: ReviewerRef | null,
  headSha: string,
): string | null {
  if (candidate.headSha !== headSha) return `reviewed ${candidate.headSha.slice(0, 7)}, not the head`;
  if (candidate.superseded) return "replaced by a later review";
  if (candidate.verdict !== "approve") return "requested changes";
  const mismatches = slot.anyOf.map((o) => optionMismatch(o, candidate, author));
  if (mismatches.every((m) => m !== null)) return mismatches[0];
  if (slot.differentModel) return modelMismatch(candidate, author);
  return null;
}

/**
 * Fill the slots with approving reviews at `headSha`: a maximum matching, so
 * a reviewer who could fill several slots is placed where nobody else can.
 */
export function matchSlots(
  slots: ReviewSlot[],
  candidates: SlotCandidate[],
  author: ReviewerRef | null,
  headSha: string,
): SlotStatus[] {
  const eligible = slots.map((slot) =>
    candidates
      .map((c, index) => (slotMismatch(slot, c, author, headSha) === null ? index : -1))
      .filter((index) => index >= 0),
  );

  const slotOfCandidate = new Map<number, number>();
  const assign = (slot: number, seen: Set<number>): boolean => {
    for (const candidate of eligible[slot]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const current = slotOfCandidate.get(candidate);
      if (current === undefined || assign(current, seen)) {
        slotOfCandidate.set(candidate, slot);
        return true;
      }
    }
    return false;
  };
  slots.forEach((_, slot) => assign(slot, new Set()));

  const filledBy = new Map<number, number>();
  for (const [candidate, slot] of slotOfCandidate) filledBy.set(slot, candidate);

  return slots.map((slot, index) => {
    const label = slotLabel(slot);
    const candidate = filledBy.get(index);
    if (candidate !== undefined) {
      const review = candidates[candidate];
      return {
        slot,
        label,
        satisfiedBy: { reviewId: review.id, reviewer: review.reviewer },
        detail: `approved by ${review.reviewer.id} at ${headSha.slice(0, 7)}`,
      };
    }
    const parts = [`needs an approval at ${headSha.slice(0, 7)} from ${label}`];
    if (eligible[index].length > 0) {
      const names = eligible[index].map((c) => candidates[c].reviewer.id);
      parts.push(`${names.join(", ")} already fill${names.length === 1 ? "s" : ""} another slot`);
    }
    const needsAuthor = author === null && (slot.differentModel || slot.anyOf.some((o) => o.kind !== "human"));
    if (needsAuthor) {
      parts.push("the PR's author is unknown: register it, or map its branch (review.authors.branch_pattern or branches)");
    }
    const why = candidates
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => c.headSha === headSha && !c.superseded && !eligible[index].includes(i))
      .map(({ c }) => `${c.reviewer.id}: ${slotMismatch(slot, c, author, headSha)}`)
      .slice(0, 3);
    if (why.length > 0) parts.push(`not counted: ${why.join("; ")}`);
    return { slot, label, satisfiedBy: null, detail: parts.join(". ") };
  });
}
