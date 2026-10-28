/**
 * Playbook engine: runs a playbook's steps in order against one breach and
 * records the run. After a failed step the remaining steps are skipped; a
 * diagnose step that finds the breach gone ends the run as "cleared".
 *
 * The executors are the built-in StepExecutors; there is no registry to add
 * others, so what runs in tests is what runs in production.
 */
import type { EventBus } from "../core/event-bus.js";
import { StepExecutors, type StepOutcome, type StepState } from "./executors.js";
import type {
  Breach,
  PlaybookDefinition,
  PlaybookRun,
  PlaybookSettings,
  RunOutcome,
  StepResult,
} from "./types.js";
import type { WatchdogContext } from "./view.js";

export class PlaybookEngine {
  private executors: StepExecutors;

  constructor(
    private ctx: WatchdogContext,
    private events?: EventBus,
  ) {
    this.executors = new StepExecutors(ctx);
  }

  private iso(): string {
    return new Date(this.ctx.probes.clock.now()).toISOString();
  }

  /** Run a playbook in act mode. */
  async run(
    playbook: PlaybookDefinition,
    breach: Breach,
    attempt: number,
    settings: PlaybookSettings,
  ): Promise<PlaybookRun> {
    const { store, project, probes } = this.ctx;
    const run = store.createRun({
      project,
      breachId: breach.id,
      playbookId: playbook.id,
      mode: "act",
      status: "running",
      attempt,
      startedAt: this.iso(),
      steps: [],
    });
    await this.events?.emit("playbook.started", {
      project,
      playbookId: playbook.id,
      runId: run.id,
      breachId: breach.id,
      attempt,
    });

    const state: StepState = { breach, vars: { ...breach.vars } };
    const steps: StepResult[] = [];
    let failed = false;
    let stopped = false;
    let outcome: RunOutcome | undefined;
    let error: string | undefined;

    const signal = this.ctx.signal;
    for (const step of playbook.steps) {
      if (stopped) {
        steps.push({ stepId: step.id, type: step.type, status: "skipped" });
        continue;
      }
      // The watchdog is stopping: start no action, and don't wait to verify one
      if (step.type === "act" && signal?.aborted) {
        steps.push({ stepId: step.id, type: step.type, status: "skipped", output: "watchdog stopping: not acting" });
        failed = true;
        stopped = true;
        error = "stopped before acting";
        continue;
      }
      if (step.type === "verify" && step.check !== "deferred" && settings.verifyDelaySeconds > 0) {
        await probes.clock.sleep(settings.verifyDelaySeconds * 1000, signal);
      }
      if (step.type === "verify" && signal?.aborted) {
        steps.push({
          stepId: step.id,
          type: step.type,
          status: "skipped",
          output: "watchdog stopping: left to later ticks",
        });
        outcome = "acted";
        stopped = true;
        continue;
      }
      const startedAt = this.iso();
      let result: StepOutcome;
      try {
        result = await this.executors.execute(step, state);
      } catch (e) {
        result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
      }
      steps.push({
        stepId: step.id,
        type: step.type,
        status: result.status,
        startedAt,
        completedAt: this.iso(),
        output: result.output,
        error: result.error,
        command: result.command,
      });
      store.updateRun(run.id, { steps });

      if (result.status === "failed") {
        failed = true;
        stopped = true;
        error = `${step.id}: ${result.error ?? "failed"}`;
      } else if (step.type === "diagnose" && result.cleared) {
        outcome = "cleared";
        stopped = true;
      } else if (step.type === "act" && result.falsePositive) {
        // The guard found a false positive: the breach is not real (e.g. live pid not matching the pattern)
        outcome = "cleared";
        stopped = true;
      } else if (step.type === "verify") {
        outcome = result.deferred ? "acted" : "recovered";
      }
    }

    const finalOutcome: RunOutcome = failed ? "failed" : (outcome ?? "acted");
    store.updateRun(run.id, {
      status: failed ? "failed" : "succeeded",
      outcome: finalOutcome,
      completedAt: this.iso(),
      steps,
      error,
    });
    await this.events?.emit(failed ? "playbook.failed" : "playbook.succeeded", {
      project,
      playbookId: playbook.id,
      runId: run.id,
      breachId: breach.id,
      outcome: finalOutcome,
    });
    return store.getRun(run.id)!;
  }

  /**
   * Record what a playbook would do, without running anything (observe mode,
   * read_only, or a playbook that is not opted in).
   */
  observe(playbook: PlaybookDefinition, breach: Breach, reason: string): PlaybookRun {
    const at = this.iso();
    const steps: StepResult[] = playbook.steps.map((step) => {
      const planned = step.type === "act" ? this.executors.plannedArgv(step, breach) : null;
      return {
        stepId: step.id,
        type: step.type,
        status: "planned",
        plannedArgv: planned ?? undefined,
        output:
          step.type === "act" && !planned
            ? `watchdog.actions.${step.action} is not configured`
            : undefined,
      };
    });
    return this.ctx.store.createRun({
      project: this.ctx.project,
      breachId: breach.id,
      playbookId: playbook.id,
      mode: "observe",
      status: "observed",
      outcome: "observed",
      attempt: 0,
      startedAt: at,
      completedAt: at,
      steps,
      error: reason,
    });
  }
}
