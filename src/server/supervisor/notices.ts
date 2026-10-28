/**
 * A failing check becomes one notice in the Decision Inbox: raised once it
 * has failed for supervisor.checks.notice_minutes in a row, deduped per
 * check (key `check:<scope>:<id>`), and withdrawn when the check recovers.
 *
 * No spam:
 * - a check that flaps (fails, recovers, fails) starts its count again each
 *   time it fails, so only a failure that lasts raises anything;
 * - after a notice is withdrawn, the same check raises none again for
 *   notice_cooldown_minutes;
 * - a notice the owner answered ("Noted") is not raised again until the
 *   check is seen to recover and then fail again.
 *
 * The decision is the store of record across restarts (find() reads it);
 * how long a check has been failing is kept in memory, so after a restart
 * the count starts again, while a notice already open stays open until the
 * check recovers. A server check's notice is raised in the default project.
 */
import type { CheckResult } from "../../shared/supervisor-types.js";
import type { DecisionProducer, RaiseDecisionInput } from "../decisions/types.js";
import type { ChecksSettings } from "./config.js";

export const NOTICE_MODULE = "supervisor";
export const NOTICE_NOTED = "noted";

const MAX_TITLE = 200;
const MAX_CONTEXT = 4000;

export function noticeKey(scope: string, id: string): string {
  return `check:${scope}:${id}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

function describe(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}

/** The notice for a failing check. Every word of it is Lair's own (the check's). */
export function noticeFor(project: string, result: CheckResult, failingSince: number): RaiseDecisionInput {
  const where = result.scope === "server" ? "Lair" : `project ${result.scope}`;
  const title = `Lair's self-check "${result.title}" is failing for ${where}`.slice(0, MAX_TITLE);
  const context = [
    result.explanation,
    "",
    ...(result.fix ? [`What to do: ${result.fix}`, ""] : []),
    `Measured: ${describe(result.values) || "-"}`,
    `Thresholds: ${describe(result.thresholds) || "-"}`,
    `Failing since ${iso(failingSince)}. Home → Health shows it live; this notice is withdrawn once the check recovers.`,
  ].join("\n");
  return {
    project,
    kind: "other",
    attention: "notice",
    title,
    context: context.slice(0, MAX_CONTEXT),
    options: [
      {
        id: NOTICE_NOTED,
        label: "Noted",
        consequences:
          "The notice closes. Lair doesn't raise it again until the check recovers and then fails again; Home → Health keeps showing the check.",
      },
    ],
    recommended: {
      optionId: NOTICE_NOTED,
      reasoning: "Nothing is decided here: the fix is yours to make, and the notice goes by itself once the check recovers.",
    },
    source: { module: NOTICE_MODULE, ref: `${result.scope}:${result.id}` },
    key: noticeKey(result.scope, result.id),
  };
}

export interface NoticeState {
  failingSince: number | null;
  noticeId: string | null;
}

export class Notices {
  /** key -> since when it has failed (ms), while it does */
  private failing = new Map<string, number>();
  /** key -> when it was last seen ok or warning (ms) */
  private recovered = new Map<string, number>();
  decisions?: DecisionProducer;

  constructor(private readonly log: Pick<Console, "warn"> = console) {}

  /**
   * One check's latest result, in the project its notice belongs to: raise,
   * keep or withdraw its notice. Never throws: the Decision Inbox failing
   * leaves the check's result as it is.
   */
  async observe(project: string, result: CheckResult, settings: ChecksSettings, now: number): Promise<NoticeState> {
    const key = noticeKey(result.scope, result.id);
    const inbox = this.decisions;
    try {
      if (result.status === "failing") {
        const since = this.failing.get(key) ?? now;
        this.failing.set(key, since);
        if (!inbox) return { failingSince: since, noticeId: null };
        const latest = inbox.find(project, NOTICE_MODULE, key);
        if (latest?.status === "open") return { failingSince: since, noticeId: latest.id };
        if (now - since < settings.notice_minutes * 60_000) return { failingSince: since, noticeId: null };
        if (latest) {
          const closed = Date.parse(latest.closedAt ?? latest.answeredAt ?? latest.createdAt);
          if (latest.status === "answered" && !((this.recovered.get(key) ?? -Infinity) > closed)) {
            return { failingSince: since, noticeId: null };
          }
          if (latest.status !== "answered" && now - closed < settings.notice_cooldown_minutes * 60_000) {
            return { failingSince: since, noticeId: null };
          }
        }
        const { decision } = await inbox.raise(noticeFor(project, result, since));
        return { failingSince: since, noticeId: decision.id };
      }
      if (result.status === "ok" || result.status === "warning") {
        this.failing.delete(key);
        this.recovered.set(key, now);
        const latest = inbox?.find(project, NOTICE_MODULE, key);
        if (inbox && latest?.status === "open") {
          await inbox.withdraw(latest.id, {
            module: NOTICE_MODULE,
            reason: `The check recovered (${result.status}): ${result.explanation}`.slice(0, 1000),
          });
        }
        return { failingSince: null, noticeId: null };
      }
      // unknown: nothing new is known, so nothing changes
      const latest = inbox?.find(project, NOTICE_MODULE, key);
      return { failingSince: this.failing.get(key) ?? null, noticeId: latest?.status === "open" ? latest.id : null };
    } catch (e) {
      this.log.warn(`[supervisor] the notice of ${key} could not be updated: ${e instanceof Error ? e.message : String(e)}`);
      return { failingSince: this.failing.get(key) ?? null, noticeId: null };
    }
  }

  /** Withdraw a project's open notices whose check no longer runs (checks turned off, a check disabled, its scope gone). */
  async withdrawExcept(project: string, active: ReadonlySet<string>): Promise<void> {
    const inbox = this.decisions;
    if (!inbox) return;
    try {
      for (const decision of inbox.openOf(project, NOTICE_MODULE)) {
        // Only the checks' own notices: the digest's are the chat's (chat.ts)
        if (!decision.key.startsWith("check:") || active.has(decision.key)) continue;
        this.failing.delete(decision.key);
        await inbox.withdraw(decision.id, { module: NOTICE_MODULE, reason: "The check no longer runs (turned off, or not checked here any more)." });
      }
    } catch (e) {
      this.log.warn(`[supervisor] stale notices in ${project} could not be withdrawn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Forget a scope's counts (its checks were turned off). */
  forget(scope: string): void {
    const prefix = `check:${scope}:`;
    for (const key of [...this.failing.keys()]) if (key.startsWith(prefix)) this.failing.delete(key);
  }
}
