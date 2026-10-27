/**
 * Where "the required gate passed at the exact head" comes from:
 *
 * - checks: the git host's check runs for that commit, by name, made by an
 *   allow-listed app (GitHub Actions by default), plus commit statuses only
 *   from allow-listed accounts;
 * - signed: gate results signed by a Lair node and posted to Lair (or
 *   handed over by triage, with from_triage), verified with the node keys
 *   and pipeline versions in the config (the policy engine's own
 *   verification, src/server/policy/policy-evaluator.ts). A required entry
 *   is a pipeline, or a group {anyOf} that any one of its pipelines fills.
 */
import type { GateCheck } from "../../shared/review-types.js";
import type { PolicyConfig, PullRequest } from "../../shared/policy-types.js";
import { verifyGateResults } from "../policy/policy-evaluator.js";
import { requirementName, type GateSettings, type RequiredCheck } from "./config.js";
import type { GitHost, HostCheck } from "./host.js";
import type { ReviewStore } from "./store.js";

export interface GateSource {
  /** Each required gate's result at exactly `sha` */
  checksAt(sha: string): Promise<GateCheck[]>;
}

function time(at: string | null): number {
  const t = Date.parse(at ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/** The required check's state at `sha`: a run in progress wins, else the newest run decides. */
export function checkVerdict(name: string, sha: string, runs: HostCheck[]): GateCheck {
  if (runs.length === 0) {
    return { name, status: "missing", sha, detail: "no run at this commit", url: null };
  }
  const pending = runs.find((r) => r.state === "pending");
  if (pending) return { name, status: "pending", sha, detail: pending.detail, url: pending.url };
  const newest = [...runs].sort((a, b) => time(b.at) - time(a.at))[0];
  switch (newest.state) {
    case "success":
      return { name, status: "passed", sha, detail: newest.detail, url: newest.url };
    case "skipped":
      return { name, status: "failed", sha, detail: `${newest.detail}: a skipped check is not a pass`, url: newest.url };
    default:
      return { name, status: "failed", sha, detail: newest.detail, url: newest.url };
  }
}

/**
 * True if `check` comes from a source the config trusts: a check run made by
 * the required app (slug or numeric id), or a commit status posted by an
 * allow-listed account. Anyone who can write statuses (or install an app)
 * can post a "success" under any name, so the name alone proves nothing.
 */
export function trustedCheck(check: HostCheck, required: RequiredCheck, statusCreators: string[]): boolean {
  if (check.kind === "check_run") {
    return check.app !== null && (check.app.slug === required.app || String(check.app.id) === required.app);
  }
  return check.creator !== null && statusCreators.includes(check.creator);
}

export function hostChecksGate(host: GitHost, required: RequiredCheck[], statusCreators: string[]): GateSource {
  return {
    async checksAt(sha) {
      const checks = await host.listChecks(sha);
      return required.map((req) => {
        const named = checks.filter((c) => c.name === req.name);
        const trusted = named.filter((c) => trustedCheck(c, req, statusCreators));
        const verdict = checkVerdict(req.name, sha, trusted);
        const ignored = named.length - trusted.length;
        if (ignored > 0 && verdict.status !== "passed") {
          const from = [`app ${req.app}`, ...statusCreators.map((c) => `statuses by ${c}`)].join(" or ");
          verdict.detail = `${verdict.detail}; ignored ${ignored} result(s) not from ${from}`;
        }
        return verdict;
      });
    },
  };
}

/**
 * A group's result from its pipelines' results: passed when any one passed
 * (its newest trustworthy result at the head is a pass), else failed when one
 * failed or can't be trusted, else missing. The detail names every pipeline.
 */
export function groupVerdict(name: string, sha: string, members: GateCheck[]): GateCheck {
  const passed = members.find((m) => m.status === "passed");
  if (passed) return { name, status: "passed", sha, detail: `${passed.name}: ${passed.detail}`, url: passed.url };
  const failed = members.some((m) => m.status === "failed");
  const status: GateCheck["status"] = failed ? "failed" : members.some((m) => m.status === "pending") ? "pending" : "missing";
  const detail =
    status === "missing"
      ? "no signed result at this commit for any of them"
      : `none passed: ${members
          .map((m) => `${m.name} ${m.status}${m.status === "failed" && m.detail ? ` (${m.detail.slice(0, 300)})` : ""}`)
          .join("; ")}`;
  return { name, status, sha, detail, url: null };
}

export function signedGate(
  store: ReviewStore,
  project: string,
  settings: Extract<GateSettings, { source: "signed" }>,
): GateSource {
  const keys = new Map(Object.entries(settings.nodeKeys));
  const versions = new Map(Object.entries(settings.pipelineVersions));
  return {
    async checksAt(sha) {
      const results = store.gateResults(project, sha);
      const verdict = (gate: string): GateCheck => {
        const pr: PullRequest = {
          id: `${project}@${sha}`,
          number: 0,
          sourceBranch: "",
          targetBranch: "",
          headSha: sha,
          baseSha: "",
          changedFiles: [],
          linesAdded: 0,
          linesDeleted: 0,
          reviews: [],
          gateResults: results,
          projectId: project,
        };
        const policy: PolicyConfig = {
          projectId: project,
          riskTiers: [],
          reviewRequirements: {},
          requiredGates: [gate],
          protectedTests: [],
        };
        const { evidence, violations } = verifyGateResults(pr, policy, keys, versions);
        if (violations.length === 0) {
          const passed = evidence.find((e) => e.verified && e.status === "passed");
          return { name: gate, status: "passed", sha, detail: `signed result ${passed?.id ?? ""}`.trim(), url: null };
        }
        if (violations.every((v) => v.rule === "required-gate")) {
          return { name: gate, status: "missing", sha, detail: "no signed result at this commit", url: null };
        }
        return { name: gate, status: "failed", sha, detail: violations.map((v) => v.message).join("; "), url: null };
      };
      return settings.required.map((requirement) =>
        typeof requirement === "string"
          ? verdict(requirement)
          : groupVerdict(requirementName(requirement), sha, requirement.anyOf.map(verdict)),
      );
    },
  };
}
