/**
 * Escalation: when the watchdog may not act (observe mode, read_only, or no
 * playbook opted in) or every playbook is used up, it asks the human, once
 * per breach, with the evidence.
 *
 * With the Decision Inbox connected (src/server/decisions/, always in the
 * server), the escalation is an `escalation` decision whose answer the
 * watchdog follows: "run_playbook" runs the breach's playbook once more,
 * "stand_down" leaves the breach to the human (service.ts). Until it is
 * answered the breach is parked. `watchdog.escalation_file`, when set, still
 * gets a copy of the entry.
 *
 * Without the inbox, or when raising the decision fails, the entry goes to
 * the project's inbox file: an `OWNER?` decision line (the convention the
 * Decision Inbox importers read, docs/design/autonomy.md §1) with indented
 * detail lines:
 *
 *   - OWNER? 2026-01-01T12:00:00.000Z [watchdog:1a2b3c4d] demo: Agent worker-a ... (agent_hung). Not acting: ...
 *     - evidence: newest log worker-a.log last changed ...
 *     - would run: ./bin/restart-agent worker-a 4242
 */
import type { EventBus } from "../core/event-bus.js";
import type { DecisionOption } from "../../shared/decision-types.js";
import type { DecisionProducer, RaiseDecisionInput } from "../decisions/types.js";
import { playbooksFor } from "./playbooks.js";
import {
  DECISION_RUN,
  DECISION_STAND_DOWN,
  type Breach,
  type PlaybookDefinition,
  type PlaybookRun,
} from "./types.js";
import type { WatchdogContext } from "./view.js";

/** The module name the watchdog raises decisions as. */
export const DECISION_MODULE = "watchdog";

const MAX_LINE = 500;
const MAX_TITLE = 200;
const MAX_CONTEXT = 20000;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}...` : flat;
}

/** Control characters (log colours, ...) become spaces: decisions take printable text only. */
function printable(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** What ran, or would have run, in a playbook run: one line each. */
function runDetails(run: PlaybookRun): string[] {
  const lines: string[] = [];
  for (const step of run.steps) {
    if (step.plannedArgv) {
      lines.push(`would run: ${oneLine(step.plannedArgv.join(" "))}`);
    }
    if (step.command) {
      lines.push(`ran: ${oneLine(step.command.argv.join(" "))} (exit ${step.command.code})`);
      const output = (step.command.stdout + step.command.stderr).trim();
      if (output) lines.push(`output: ${oneLine(output)}`);
    }
    if (step.status === "failed" && step.error) {
      lines.push(`${step.stepId} failed: ${oneLine(step.error)}`);
    }
  }
  if (run.mode === "act") {
    lines.push(`last run: playbook ${run.playbookId}, attempt ${run.attempt}, ${run.outcome ?? run.status}`);
  }
  return lines;
}

export function formatEscalation(
  project: string,
  breach: Breach,
  reason: string,
  at: string,
  run?: PlaybookRun,
): string {
  const lines = [
    `- OWNER? ${at} [watchdog:${breach.id.slice(0, 8)}] ${project}: ${oneLine(breach.summary)} (${breach.detector}). ${oneLine(reason)}`,
    ...breach.evidence.map((e) => `  - evidence: ${oneLine(e)}`),
    ...(run ? runDetails(run).map((line) => `  - ${line}`) : []),
  ];
  return lines.join("\n") + "\n";
}

/**
 * The playbook an approved run uses: the breach's first playbook whose
 * watchdog.actions commands are all configured.
 */
export function runnablePlaybook(ctx: WatchdogContext, breach: Breach): PlaybookDefinition | undefined {
  return playbooksFor(breach.detector).find((p) =>
    p.steps.every((s) => !s.action || ctx.settings.actions[s.action] !== undefined),
  );
}

/** The numbers a policy rule reads for idle_capacity (C3) and orphan_claim (C4); codes and numbers only. */
function detectorFacts(breach: Breach, run?: PlaybookRun): Record<string, string | number | boolean | null> {
  const num = (name: string): number | null => {
    const raw = breach.vars[name];
    const n = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  if (breach.detector === "idle_capacity") {
    const last = breach.vars.last_start;
    return {
      ready_count: num("ready"),
      queued_count: num("queued"),
      running_count: num("running"),
      last_start: last === undefined || last === "" ? null : last,
    };
  }
  if (breach.detector === "orphan_claim") {
    const commands = (run?.steps ?? []).flatMap((s) => (s.command ? [s.command] : []));
    const failedStep = (run?.steps ?? []).some((s) => s.status === "failed");
    return {
      claim_age_min: num("claim_age_min"),
      process_found: breach.vars.process_found === "true",
      release_exit_code: commands.length > 0 ? commands[commands.length - 1].code : null,
      release_refusal: run === undefined || run.mode !== "act" ? "not_run" : failedStep ? "step_failed" : "none",
    };
  }
  return {};
}

/**
 * The Decision Inbox item for an escalated breach. "Run once" is offered
 * only when a playbook command is configured and the project isn't
 * read_only. It is recommended unless the playbooks already failed.
 * Without it the only option is "Leave it to me": nothing to choose, so the
 * item is a notice (never counted in the badge, never notified), withdrawn
 * like any escalation once the breach clears.
 */
export function decisionFor(
  ctx: WatchdogContext,
  breach: Breach,
  reason: string,
  run?: PlaybookRun,
): RaiseDecisionInput {
  const { project, config } = ctx;
  const readOnly = config.read_only === true;
  const playbook = runnablePlaybook(ctx, breach);
  const options: DecisionOption[] = [];
  if (playbook && !readOnly) {
    options.push({
      id: DECISION_RUN,
      label: `Run "${playbook.name}" once`,
      effect: "outward",
      consequences:
        `Lair runs the ${playbook.id} playbook for this breach once, now, also in observe mode: it re-checks the ` +
        "breach on fresh data, runs the configured watchdog.actions command only if the breach is still there, " +
        "and verifies. If that run fails, Lair asks you again.",
    });
  }
  options.push({
    id: DECISION_STAND_DOWN,
    label: "Leave it to me",
    effect: "reversible",
    consequences:
      "Lair runs nothing more for this breach and doesn't ask again. The breach closes when the detector stops reporting it.",
  });

  const usedUp = run !== undefined && run.mode === "act";
  const recommendRun = options.length > 1 && !usedUp;
  let reasoning: string;
  if (recommendRun) {
    reasoning =
      "The detector still reports the breach, and the playbook checks it again right before acting, so a run that is no longer needed does nothing.";
  } else if (run !== undefined && run.mode === "act") {
    reasoning = `The playbook already ran (attempt ${run.attempt}) without fixing it: read its output before running it again.`;
  } else if (readOnly) {
    reasoning = "The project is read_only, so Lair runs no command for it: only you can fix this.";
  } else {
    reasoning = `No playbook for ${breach.detector} has its watchdog.actions command configured, so only you can fix this.`;
  }

  const details = run ? runDetails(run) : [];
  const context = [
    `The watchdog found a breach in project ${project} (detector ${breach.detector}), detected ${breach.detectedAt}.`,
    oneLine(reason),
    ...(breach.evidence.length > 0 ? ["", "Evidence:", ...breach.evidence.map((e) => `- ${oneLine(e)}`)] : []),
    ...(details.length > 0 ? ["", ...details.map((line) => `- ${line}`)] : []),
  ]
    .map(printable)
    .join("\n");

  return {
    project,
    kind: "escalation",
    // With nothing to run, "Leave it to me" is no choice: the breach is for the owner's information
    attention: options.some((o) => o.id === DECISION_RUN) ? "action" : "notice",
    title: clip(printable(oneLine(breach.summary)) || breach.detector, MAX_TITLE),
    context: clip(context, MAX_CONTEXT),
    options,
    recommended: { optionId: recommendRun ? DECISION_RUN : DECISION_STAND_DOWN, reasoning },
    source: { module: DECISION_MODULE, ref: breach.id },
    class: `watchdog.${breach.detector}`,
    evidence: {
      code: breach.detector === "orphan_claim" ? "claim_orphan" : breach.detector,
      facts: {
        detector: breach.detector,
        playbook_attempts: run?.attempt ?? 0,
        playbook_available: playbook !== undefined,
        read_only: readOnly,
        detected_at: breach.detectedAt,
        ...detectorFacts(breach, run),
      },
      cause_cleared: false,
      linked_issue: null,
    },
    key: `breach:${breach.id}`,
    blocks: [clip(printable(`watchdog:${project}:${breach.key}`), 200)],
  };
}

export class Escalator {
  /** The Decision Inbox, once Watchdog.useDecisions() connected it. */
  decisions?: DecisionProducer;

  constructor(
    private ctx: WatchdogContext,
    private events?: EventBus,
  ) {}

  /** The file escalations go to without the Decision Inbox: watchdog.escalation_file, else inbox_file. */
  get target(): string | undefined {
    return this.ctx.settings.escalationFile ?? this.ctx.config.inbox_file;
  }

  /** Raise the breach's decision and link the breach to it; returns its id. */
  private async raiseDecision(breach: Breach, reason: string, at: string, run?: PlaybookRun): Promise<string> {
    const { decision } = await this.decisions!.raise(decisionFor(this.ctx, breach, reason, run));
    this.ctx.store.linkDecision(breach.id, this.ctx.project, decision.id, at);
    return decision.id;
  }

  /**
   * Escalate a breach unless it already was. Returns true when this call
   * escalated it. A breach whose key was escalated less than
   * watchdog.reescalate_minutes ago (it cleared and came back) is recorded as
   * suppressed instead, so a flapping condition doesn't flood the inbox.
   */
  async escalate(breach: Breach, reason: string, run?: PlaybookRun): Promise<boolean> {
    const { store, project, probes, settings } = this.ctx;
    if (store.hasEscalation(breach.id)) return false;

    const now = probes.clock.now();
    const at = new Date(now).toISOString();
    const text = formatEscalation(project, breach, reason, at, run);
    const previous = settings.reescalateMinutes > 0 ? store.lastEscalationForKey(project, breach.key) : null;
    if (previous && now - Date.parse(previous) < settings.reescalateMinutes * 60000) {
      store.recordEscalation({
        project,
        breachId: breach.id,
        createdAt: at,
        text: `${text}  - suppressed: ${breach.key} was escalated at ${previous} (watchdog.reescalate_minutes: ${settings.reescalateMinutes})\n`,
        suppressed: true,
      });
      store.markEscalated(breach.id, at);
      return false;
    }

    let decisionId: string | undefined;
    let decisionError: string | undefined;
    if (this.decisions) {
      try {
        decisionId = await this.raiseDecision(breach, reason, at, run);
      } catch (e) {
        decisionError = e instanceof Error ? e.message : String(e);
      }
    }

    // A raised decision is the escalation; escalation_file, when set, gets a copy
    const file = decisionId ? settings.escalationFile : this.target;
    let writeError: string | undefined;
    if (file) {
      try {
        probes.fs.append(file, text);
      } catch (e) {
        writeError = e instanceof Error ? e.message : String(e);
      }
    }
    let recorded = writeError ? `${text}  - could not write ${file}: ${writeError}\n` : text;
    if (decisionError) recorded += `  - could not raise a decision: ${oneLine(decisionError)}\n`;
    store.recordEscalation({
      project,
      breachId: breach.id,
      createdAt: at,
      file: writeError ? undefined : file,
      text: recorded,
    });
    store.markEscalated(breach.id, at);
    if (decisionError) {
      console.warn(`[watchdog] ${project}: could not raise a decision for ${breach.key}: ${decisionError}`);
    }
    if (!decisionId && (!file || writeError)) {
      console.warn(
        `[watchdog] ${project}: escalation for ${breach.key} kept in the store only (${writeError ?? "no watchdog.escalation_file or inbox_file"})`,
      );
    }
    await this.events?.emit("escalation.created", {
      project,
      breachId: breach.id,
      detector: breach.detector,
      key: breach.key,
      reason,
      file: writeError ? null : (file ?? null),
      decisionId: decisionId ?? null,
    });
    return true;
  }

  /**
   * Ask again about a breach whose approved run failed: a new decision (the
   * previous one is answered). True when it was raised.
   */
  async askAgain(breach: Breach, reason: string, run: PlaybookRun): Promise<boolean> {
    if (!this.decisions) return false;
    const at = new Date(this.ctx.probes.clock.now()).toISOString();
    try {
      await this.raiseDecision(breach, reason, at, run);
      return true;
    } catch (e) {
      console.warn(
        `[watchdog] ${this.ctx.project}: could not ask again about ${breach.key}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
}
