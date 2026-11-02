/**
 * PR health's Decision Inbox notices (act mode; docs/design/pr-health.md
 * section 4.5), shaped as the infrastructure monitor's: for information,
 * one "Noted" option, never counted or notified, one per (repo, PR, head)
 * keyed pr_health:<repo>#<n>@<head8>. Evaluated every tick, for a head with
 * an open kind, only when the inbox must hear about it:
 * - no_owner: nobody owns the PR (an unknown owner raises nothing);
 * - delivery_failed: a note of that head gave up;
 * - unfixed: escalate_after_minutes passed since a note was sent (sentAt in
 *   the ledger, so a restart neither resets nor repeats it) and one of its
 *   kinds is still found.
 * While one is open no other is raised; one answered (Noted) after the
 * head's first finding is not raised again for that head. It is withdrawn
 * when its head has no open kind; one left open from before a restart or a
 * reload, with no finding behind it, after clear_minutes once its
 * repository has been read.
 */
import type { EventBus } from "../core/event-bus.js";
import type { DecisionProducer, RaiseDecisionInput } from "../decisions/types.js";
import type { PrHealthSettings } from "./config.js";
import type { PlanGroup } from "./plan.js";
import type { FindingView, NoteRecord } from "./types.js";

export const NOTICE_MODULE = "pr_health";
export const NOTICE_CLASS = "pr_health.notice";
export const NOTICE_NOTED = "noted";

export type NoticeCode = "no_owner" | "delivery_failed" | "unfixed";

const KEY = /^pr_health:(.+)#[0-9]+@[0-9a-f]{8}$/;

export const noticeKey = (repo: string, pr: number, head: string) => `pr_health:${repo}#${pr}@${head.slice(0, 8)}`;

const SAYS: Record<NoticeCode, string> = {
  no_owner: "no agent owns it",
  delivery_failed: "the note to its agent could not be delivered",
  unfixed: "still not fixed after the note",
};

/** Why the inbox hears about this head now (with Lair's reason), or null. `records`: the ledger's notes of this head. */
export function noticeCode(g: PlanGroup, records: NoteRecord[], settings: PrHealthSettings, now: number): { code: NoticeCode; reason: string } | null {
  if (!("unknown" in g.owner) && g.owner.owner.agent === null) return { code: "no_owner", reason: g.owner.owner.reason };
  // A note interrupted at its last attempt reads back as failed: it gave up too
  const gaveUp = records.find((r) => r.status === "gave_up" || (r.status === "failed" && r.attempts >= settings.maxAttempts));
  if (gaveUp) return { code: "delivery_failed", reason: `note ${gaveUp.id} to ${gaveUp.agent} gave up after ${gaveUp.attempts} attempts` };
  const after = settings.escalateAfterMinutes;
  if (after === null) return null;
  const late = records.find((r) => r.status === "sent" && r.sentAt !== null && now - r.sentAt >= after * 60_000 && r.kinds.some((k) => g.seen.includes(k)));
  return late ? { code: "unfixed", reason: `note ${late.id} to ${late.agent} was sent ${Math.floor((now - (late.sentAt ?? now)) / 60_000)} min ago` } : null;
}

export function noticeFor(project: string, g: PlanGroup, code: NoticeCode, reason: string, clearMinutes: number): RaiseDecisionInput {
  const key = noticeKey(g.repo, g.pr, g.head);
  const owner = "unknown" in g.owner ? null : g.owner.owner.agent;
  const context = [
    `**PR ${g.repo}#${g.pr} at ${g.head.slice(0, 8)}: ${SAYS[code]}**`,
    "",
    `- Problems: ${g.kinds.join(", ")}`,
    `- Owner: ${owner ?? "none"}`,
    `- Why: ${reason}`,
    "",
    `Lair withdraws this notice once none of these problems has been seen at this head for ${clearMinutes} min. GET /api/pr-health/status shows it live.`,
  ].join("\n");
  return {
    project,
    kind: "other",
    attention: "notice",
    title: `PR ${g.repo}#${g.pr}: ${g.kinds.join(", ")}: ${SAYS[code]}`.slice(0, 200),
    context: context.slice(0, 4000),
    options: [
      {
        id: NOTICE_NOTED,
        label: "Noted",
        effect: "reversible",
        consequences: "The notice closes. Lair does not raise it again for this head of the PR.",
      },
    ],
    recommended: { optionId: NOTICE_NOTED, reasoning: "Nothing is decided here: the fix is on the PR, and the notice goes by itself once its problems clear." },
    source: { module: NOTICE_MODULE, ref: key },
    key,
    class: NOTICE_CLASS,
    evidence: {
      code,
      facts: { repo: g.repo, pr: g.pr, head: g.head, kinds: g.kinds.join(","), owner, reason: reason.slice(0, 200) },
      cause_cleared: false,
      linked_issue: null,
    },
  };
}

/** One head with open findings this tick, and why the inbox hears about it (null: it does not) */
export interface NoticeHead {
  group: PlanGroup;
  notice: { code: NoticeCode; reason: string } | null;
  findings: FindingView[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Notices {
  /** Keys that had open findings in this process: withdrawn as soon as they have none */
  private readonly backed = new Set<string>();
  /** key -> when an open notice with no finding behind it was first seen (after a restart or a reload) */
  private readonly orphans = new Map<string, number>();

  constructor(
    private readonly project: string,
    private readonly events?: EventBus,
  ) {}

  /** Raise and withdraw this tick's notices; returns the problems met. `listed`: the repository was read since start. */
  async sync(inbox: DecisionProducer, heads: NoticeHead[], listed: (repo: string) => boolean, now: number, clearMinutes: number): Promise<string[]> {
    const errors: string[] = [];
    const live = new Set<string>();
    for (const { group, notice, findings } of heads) {
      const key = noticeKey(group.repo, group.pr, group.head);
      live.add(key);
      this.backed.add(key);
      this.orphans.delete(key);
      try {
        const latest = inbox.find(this.project, NOTICE_MODULE, key);
        let id = latest?.status === "open" ? latest.id : null;
        // Noted for this head's problems: not again for this head
        const noted = latest?.status === "answered" && Date.parse(latest.answeredAt ?? latest.closedAt ?? latest.createdAt) >= group.since;
        if (id === null && notice && !noted) {
          const { decision, created } = await inbox.raise(noticeFor(this.project, group, notice.code, notice.reason, clearMinutes));
          id = decision.id;
          if (created) void this.events?.emit("pr_health.escalated", { project: this.project, key, code: notice.code, decisionId: decision.id });
        }
        for (const f of findings) f.noticeId = id;
      } catch (e) {
        errors.push(`notice ${key} could not be raised: ${message(e)}`);
      }
    }
    const open = inbox.openOf(this.project, NOTICE_MODULE);
    for (const decision of open) {
      if (live.has(decision.key)) continue;
      let reason: string | null = null;
      if (this.backed.has(decision.key)) reason = "The PR's problems at this head are gone.";
      else if (listed(KEY.exec(decision.key)?.[1] ?? "")) {
        const since = this.orphans.get(decision.key) ?? now;
        this.orphans.set(decision.key, since);
        if (now - since >= clearMinutes * 60_000) reason = `No problem has been seen at this head for ${clearMinutes} min.`;
      }
      if (reason === null) continue;
      try {
        await inbox.withdraw(decision.id, { module: NOTICE_MODULE, reason });
        this.orphans.delete(decision.key);
      } catch (e) {
        errors.push(`notice ${decision.key} could not be withdrawn: ${message(e)}`);
      }
    }
    const openKeys = new Set(open.map((d) => d.key));
    for (const key of this.backed) if (!live.has(key) && !openKeys.has(key)) this.backed.delete(key);
    return errors;
  }

  /** Withdraw this project's open notices (act turned off: observe, enabled: false or read_only). */
  async withdrawAll(inbox: DecisionProducer, reason: string, log: Pick<Console, "warn">): Promise<void> {
    for (const decision of inbox.openOf(this.project, NOTICE_MODULE)) {
      try {
        await inbox.withdraw(decision.id, { module: NOTICE_MODULE, reason });
      } catch (e) {
        log.warn(`[pr-health] ${this.project}: notice ${decision.key} could not be withdrawn: ${message(e)}`);
      }
    }
  }
}
