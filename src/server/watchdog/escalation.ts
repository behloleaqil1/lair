/**
 * Escalation: when the watchdog may not act (observe mode, read_only, or no
 * playbook opted in) or every playbook is used up, it asks the human through
 * the project's inbox, once per breach, with the evidence.
 *
 * The entry is an `OWNER?` decision line (the convention the Decision Inbox
 * importers read, docs/design/autonomy.md §1) with indented detail lines:
 *
 *   - OWNER? 2026-01-01T12:00:00.000Z [watchdog:1a2b3c4d] demo: Agent worker-a ... (agent_hung). Not acting: ...
 *     - evidence: newest log worker-a.log last changed ...
 *     - would run: ./bin/restart-agent worker-a 4242
 */
import type { EventBus } from "../core/event-bus.js";
import type { Breach, PlaybookRun } from "./types.js";
import type { WatchdogContext } from "./view.js";

const MAX_LINE = 500;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}...` : flat;
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
  ];
  if (run) {
    for (const step of run.steps) {
      if (step.plannedArgv) {
        lines.push(`  - would run: ${oneLine(step.plannedArgv.join(" "))}`);
      }
      if (step.command) {
        lines.push(`  - ran: ${oneLine(step.command.argv.join(" "))} (exit ${step.command.code})`);
        const output = (step.command.stdout + step.command.stderr).trim();
        if (output) lines.push(`  - output: ${oneLine(output)}`);
      }
      if (step.status === "failed" && step.error) {
        lines.push(`  - ${step.stepId} failed: ${oneLine(step.error)}`);
      }
    }
    if (run.mode === "act") {
      lines.push(`  - last run: playbook ${run.playbookId}, attempt ${run.attempt}, ${run.outcome ?? run.status}`);
    }
  }
  return lines.join("\n") + "\n";
}

export class Escalator {
  constructor(
    private ctx: WatchdogContext,
    private events?: EventBus,
  ) {}

  /** The file escalations go to: watchdog.escalation_file, else inbox_file. */
  get target(): string | undefined {
    return this.ctx.settings.escalationFile ?? this.ctx.config.inbox_file;
  }

  /**
   * Escalate a breach unless it already was. Returns true when this call
   * wrote the escalation. A breach whose key was escalated less than
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
    const file = this.target;
    let writeError: string | undefined;
    if (file) {
      try {
        probes.fs.append(file, text);
      } catch (e) {
        writeError = e instanceof Error ? e.message : String(e);
      }
    }
    store.recordEscalation({
      project,
      breachId: breach.id,
      createdAt: at,
      file: writeError ? undefined : file,
      text: writeError ? `${text}  - could not write ${file}: ${writeError}\n` : text,
    });
    store.markEscalated(breach.id, at);
    if (!file || writeError) {
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
    });
    return true;
  }
}
