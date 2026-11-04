/**
 * review.merge.external_gate.gate_rules (docs/design/merge-external-gate.md,
 * R2): a rule that applies to a PR (a changed file matches its paths and,
 * with added_line_contains, an added line contains one of the strings) is
 * met when ANY trusted pass at the head satisfies one of its needs_any
 * options. Every stored result is verified on its own, with the same
 * verifier as the gate (node key, signature, project, pipeline version); a
 * pass whose pipeline has a newer trusted failure at the head doesn't count.
 */
import type { MergeCondition } from "../../shared/review-types.js";
import type { GateResult, PolicyConfig, PullRequest, SignedGateResult } from "../../shared/policy-types.js";
import { verifyGateResults } from "../policy/policy-evaluator.js";
import { matchPath } from "../policy/risk-rules.js";
import type { GateRule } from "./config.js";

export interface RuleFile {
  path: string;
  /** null: the host omitted the patch (too large), so the added lines are unknown */
  patch: string | null;
}

/** The most files the host lists for a PR (30 pages of 100); a list this long may be cut short */
export const LISTED_FILES_CAP = 3000;

export interface GateTrust {
  project: string;
  nodeKeys: Record<string, string>;
  pipelineVersions: Record<string, string>;
}

/** Whether `rule` applies to the PR's files. An unknown patch counts as matching (fail closed). */
export function ruleApplies(rule: GateRule, files: RuleFile[]): boolean {
  return files.some((f) => {
    if (!rule.paths.some((glob) => matchPath(glob, f.path))) return false;
    if (rule.addedLineContains.length === 0 || f.patch === null) return true;
    // A per-file patch has no file headers: every line starting with + is an added line
    return f.patch
      .split("\n")
      .some((line) => line.startsWith("+") && rule.addedLineContains.some((s) => line.slice(1).includes(s)));
  });
}

function completedAt(r: GateResult): number {
  const t = Date.parse(r.completedAt);
  if (!Number.isNaN(t)) return t;
  const s = Date.parse(r.startedAt);
  return Number.isNaN(s) ? 0 : s;
}

/** "passed" or "failed" when the result is trusted (as the gate verifies it), else null. */
function trustOf(signed: SignedGateResult, head: string, trust: GateTrust): "passed" | "failed" | null {
  const pr: PullRequest = {
    id: `${trust.project}@${head}`,
    number: 0,
    sourceBranch: "",
    targetBranch: "",
    headSha: head,
    baseSha: "",
    changedFiles: [],
    linesAdded: 0,
    linesDeleted: 0,
    reviews: [],
    gateResults: [signed],
    projectId: trust.project,
  };
  const policy: PolicyConfig = {
    projectId: trust.project,
    riskTiers: [],
    reviewRequirements: {},
    requiredGates: [signed.result.pipelineId],
    protectedTests: [],
  };
  const { evidence, violations } = verifyGateResults(
    pr,
    policy,
    new Map(Object.entries(trust.nodeKeys)),
    new Map(Object.entries(trust.pipelineVersions)),
  );
  if (violations.length === 0) return "passed";
  return evidence.some((e) => e.verified && e.id === signed.result.id) ? "failed" : null;
}

/** Trusted passes at `head` that no newer trusted failure of the same pipeline replaced. */
export function countingPasses(results: SignedGateResult[], head: string, trust: GateTrust): GateResult[] {
  const trusted = results
    .filter((r) => r.result.commitSha === head)
    .map((r) => ({ result: r.result, status: trustOf(r, head, trust) }))
    .filter((r): r is { result: GateResult; status: "passed" | "failed" } => r.status !== null);
  return trusted
    .filter((r) => r.status === "passed")
    .filter(
      (p) =>
        !trusted.some(
          // A failure at the same time as the pass counts as newer: the tie fails closed
          (f) => f.status === "failed" && f.result.pipelineId === p.result.pipelineId && completedAt(f.result) >= completedAt(p.result),
        ),
    )
    .map((p) => p.result);
}

/**
 * Whether a report file is the named one: its name without the folder and a
 * `.xml` ending is the name, or ends with `.<name>` or `-<name>` (JUnit's
 * `TEST-<package>.<class>.xml`). Only that the gate wrote it is checked.
 */
export function reportIs(file: string, name: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.xml$/i, "");
  return base === name || base.endsWith(`.${name}`) || base.endsWith(`-${name}`);
}

function meets(need: GateRule["needsAny"][number], result: GateResult): boolean {
  if (need.pipelines && !need.pipelines.includes(result.pipelineId)) return false;
  const files = (result.reports ?? []).map((r) => r.name);
  return !need.reports || need.reports.every((name) => files.some((f) => reportIs(f, name)));
}

function describeNeeds(rule: GateRule): string {
  return rule.needsAny
    .map((n) =>
      [n.pipelines && `pipeline ${n.pipelines.join(" or ")}`, n.reports && `reports ${n.reports.join(" and ")}`]
        .filter(Boolean)
        .join(" and "),
    )
    .join(", or ");
}

/** The policy condition `gate_rules` for a PR at `head`. */
export function gateRulesCondition(
  rules: GateRule[],
  files: RuleFile[],
  /** The file list may be incomplete: every rule applies (fail closed) */
  truncated: boolean,
  results: SignedGateResult[],
  head: string,
  trust: GateTrust,
): MergeCondition {
  const label = "Gate rules";
  const applying = truncated ? rules : rules.filter((r) => ruleApplies(r, files));
  if (applying.length === 0) return { id: "gate_rules", ok: true, label, detail: "no rule applies" };
  const passes = countingPasses(results, head, trust);
  const met: string[] = [];
  const unmet: string[] = [];
  for (const rule of applying) {
    const by = passes.find((p) => rule.needsAny.some((n) => meets(n, p)));
    if (by) met.push(`${rule.id}: met by ${by.id}`);
    else unmet.push(`${rule.id} needs a passed gate at ${head.slice(0, 7)} with ${describeNeeds(rule)}`);
  }
  return unmet.length > 0
    ? { id: "gate_rules", ok: false, label, detail: unmet.join("; ") }
    : { id: "gate_rules", ok: true, label, detail: met.join("; ") };
}
