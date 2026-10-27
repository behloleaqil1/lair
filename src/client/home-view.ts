/**
 * Home's "Needs you" list and its fleet tiles: everything waiting on the
 * owner in one place, each item linking to the row that explains it. Kept
 * apart from the component so tests check the same rules.
 */
import type { Decision } from "../shared/decision-types";
import type { MergeHold } from "../shared/review-types";
import type { AgentsStatusView } from "../shared/agents-types";
import type { DeliveryProjectStatus } from "../shared/delivery-types";
import type { ConfigProblem } from "../shared/lifecycle-types";
import type { FailedGate } from "./gate-detail-view";
import type { PrRow } from "./pr-view";
import type { WorkRow } from "./work-view";
import { linkTo } from "./router";

export type NeedKind = "decision" | "config" | "agent" | "hold" | "gate" | "pr";
export type NeedTone = "error" | "warning" | "neutral";

export interface NeedItem {
  kind: NeedKind;
  /** Unique within the list */
  key: string;
  title: string;
  detail: string;
  href: string;
  tone: NeedTone;
  at: string | null;
}

export interface NeedsInput {
  project: string;
  /** Every project's decisions (the Decision Inbox is shared) */
  decisions: readonly Decision[];
  reviewHolds: readonly MergeHold[];
  agents: AgentsStatusView | null;
  delivery: DeliveryProjectStatus | null;
  failures: readonly FailedGate[];
  prs: readonly PrRow[];
  configProblems: readonly ConfigProblem[];
  work: readonly WorkRow[];
}

const KIND_ORDER: NeedKind[] = ["decision", "config", "agent", "hold", "gate", "pr"];
const TONE_ORDER: NeedTone[] = ["error", "warning", "neutral"];

export function needsYou(input: NeedsInput): NeedItem[] {
  const items: NeedItem[] = [];

  const open = input.decisions.filter((d) => d.status === "open");
  for (const d of open.filter((d) => d.project === input.project)) {
    items.push({
      kind: "decision",
      key: `decision:${d.id}`,
      title: d.title,
      detail: `${d.overdue ? "Overdue · " : ""}raised by ${d.source.module}`,
      href: linkTo("decisions", d.id),
      tone: d.overdue ? "error" : "warning",
      at: d.createdAt,
    });
  }
  const elsewhere = open.filter((d) => d.project !== input.project).length;
  if (elsewhere > 0) {
    items.push({
      kind: "decision",
      key: "decision:elsewhere",
      title: `${elsewhere} open decision${elsewhere === 1 ? "" : "s"} in other projects`,
      detail: "The Decision Inbox lists every project's",
      href: linkTo("decisions"),
      tone: "neutral",
      at: null,
    });
  }

  for (const p of input.configProblems.filter((p) => p.project === input.project)) {
    items.push({
      kind: "config",
      key: `config:${p.file}`,
      title: `${p.file} has an error`,
      detail: p.previousRunning ? `The previous config is still running: ${p.error}` : p.error,
      href: linkTo("settings"),
      tone: "error",
      at: p.at,
    });
  }

  for (const row of input.work.filter((r) => r.attention)) {
    items.push({
      kind: "agent",
      key: `agent:${row.id}`,
      title: `${row.id} is ${row.state}`,
      detail: row.detail ?? "",
      href: linkTo("work", row.id),
      tone: "error",
      at: null,
    });
  }

  for (const h of input.reviewHolds.filter((h) => h.releasedAt === null)) {
    items.push({
      kind: "hold",
      key: `hold:review:${h.id}`,
      title: h.pr === null ? "Every merge is held" : `Merge of #${h.pr} is held`,
      detail: `${h.reason} (by ${h.createdBy})`,
      href: h.pr === null ? linkTo("prs") : linkTo("prs", String(h.pr)),
      tone: "warning",
      at: h.createdAt,
    });
  }
  for (const line of input.agents?.fill?.enabled ? input.agents.fill.lines : []) {
    if (!line.releasable || !line.agent) continue;
    items.push({
      kind: "hold",
      key: `hold:fill:${line.line}`,
      title: `${line.task ?? `Line ${line.line}`} is held for you`,
      detail: line.detail,
      href: linkTo("work", line.agent),
      tone: "warning",
      at: null,
    });
  }
  for (const env of input.delivery?.enabled ? input.delivery.environments : []) {
    for (const service of env.services) {
      if (!service.held) continue;
      items.push({
        kind: "hold",
        key: `hold:delivery:${env.environment}:${service.name}`,
        title: `${env.environment}/${service.name} is held`,
        detail: service.held.reason,
        href: linkTo("delivery"),
        tone: "neutral",
        at: service.held.heldAt,
      });
    }
  }

  for (const f of input.failures) {
    items.push({
      kind: "gate",
      key: `gate:${f.id}`,
      title: `Gate failed: ${f.track}`,
      detail: f.failedSteps.length > 0 ? `Failed: ${f.failedSteps.join(", ")}` : "See its steps",
      href: linkTo("gates", f.id, "results"),
      tone: "error",
      at: f.finishedAt ?? null,
    });
  }

  for (const pr of input.prs.filter((p) => p.readiness.group === "ready")) {
    items.push({
      kind: "pr",
      key: `pr:${pr.number}`,
      title: `#${pr.number} ${pr.readiness.label === "Merge ready" ? "is ready to merge" : "passed its gate"}`,
      detail: pr.title,
      href: linkTo("prs", String(pr.number)),
      tone: "neutral",
      at: pr.updatedAt,
    });
  }

  return items.sort(
    (a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}
