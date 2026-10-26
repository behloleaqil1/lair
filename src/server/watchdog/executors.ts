/**
 * The step executors. There is one built-in set and no way to register
 * others: diagnose and verify re-run the breach's detector on fresh probe
 * data, and act runs the project's configured command.
 *
 * Act steps are guarded twice: the detector only reports what it can
 * attribute, and the guard here re-checks on a fresh view right before the
 * command runs (a WAITING agent is never restarted, a live agent's claim is
 * never released, a live holder's lock is never broken, and no pid that
 * isn't a configured agent's process is ever passed to a command).
 */
import { ACTION_PLACEHOLDERS, type ActionId, type Breach, type CommandRecord, type PlaybookStep } from "./types.js";
import { placeholdersIn } from "./config.js";
import { getDetector } from "./detectors.js";
import { ProjectView, type WatchdogContext } from "./view.js";

export interface StepOutcome {
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
  command?: CommandRecord;
  /** diagnose: the breach is no longer detected */
  cleared?: boolean;
  /** verify: nothing to check right away */
  deferred?: boolean;
}

/** Per-run state shared by a run's steps. */
export interface StepState {
  breach: Breach;
  /** Placeholder values, refreshed by diagnose from the fresh finding */
  vars: Record<string, string>;
}

const OUTPUT_TAIL = 2000;

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/**
 * Fill an argv template. Every placeholder must be one the action allows and
 * that this breach provides.
 */
export function buildArgv(
  action: ActionId,
  template: string[],
  vars: Record<string, string>,
): { argv: string[] } | { error: string } {
  const allowed = new Set<string>([...ACTION_PLACEHOLDERS[action], "project"]);
  for (const name of placeholdersIn(template)) {
    if (!allowed.has(name)) {
      return { error: `watchdog.actions.${action}: placeholder {${name}} is not allowed` };
    }
    if (vars[name] === undefined) {
      return { error: `watchdog.actions.${action}: no value for {${name}}` };
    }
  }
  return {
    argv: template.map((arg) => arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => vars[name] ?? "")),
  };
}

export class StepExecutors {
  constructor(private ctx: WatchdogContext) {}

  private freshView(): ProjectView {
    return new ProjectView(this.ctx);
  }

  private varsFor(state: StepState): Record<string, string> {
    return { ...state.vars, project: this.ctx.project };
  }

  /** The argv an act step would run (for observe mode); null when it can't be built. */
  plannedArgv(step: PlaybookStep, breach: Breach): string[] | null {
    if (!step.action) return null;
    const template = this.ctx.settings.actions[step.action];
    if (!template) return null;
    const built = buildArgv(step.action, template, { ...breach.vars, project: this.ctx.project });
    return "argv" in built ? built.argv : null;
  }

  async execute(step: PlaybookStep, state: StepState): Promise<StepOutcome> {
    switch (step.type) {
      case "diagnose":
        return this.diagnose(state);
      case "act":
        return this.act(step, state);
      case "verify":
        return this.verify(step, state);
    }
  }

  /** Re-run the detector: is the breach still there? */
  private async diagnose(state: StepState): Promise<StepOutcome> {
    const view = this.freshView();
    const result = await getDetector(state.breach.detector).detect(view);
    const finding = result.findings.find((f) => f.key === state.breach.key);
    if (!finding) {
      return { status: "succeeded", cleared: true, output: "no longer detected" };
    }
    state.vars = { ...finding.vars };
    return { status: "succeeded", output: finding.evidence.join("\n") };
  }

  private async act(step: PlaybookStep, state: StepState): Promise<StepOutcome> {
    const action = step.action;
    if (!action) {
      return { status: "failed", error: "act step without an action" };
    }
    const template = this.ctx.settings.actions[action];
    if (!template) {
      return { status: "failed", error: `watchdog.actions.${action} is not configured` };
    }
    const refusal = await this.guard(action, state.vars);
    if (refusal) {
      return { status: "failed", error: `refused: ${refusal}` };
    }
    const built = buildArgv(action, template, this.varsFor(state));
    if ("error" in built) {
      return { status: "failed", error: built.error };
    }
    const out = await this.ctx.probes.runner.run(built.argv, {
      timeoutMs: this.ctx.settings.commandTimeoutSeconds * 1000,
    });
    const command: CommandRecord = {
      argv: built.argv,
      code: out.code,
      stdout: tail(out.stdout),
      stderr: tail(out.stderr),
    };
    if (out.code !== 0) {
      return { status: "failed", command, error: `${built.argv[0]} exited ${out.code}` };
    }
    return { status: "succeeded", command, output: tail(out.stdout.trim()) };
  }

  /** Why an action must not run on the current state, or null. */
  private async guard(action: ActionId, vars: Record<string, string>): Promise<string | null> {
    const view = this.freshView();
    const pid = vars.pid ? Number(vars.pid) : null;
    switch (action) {
      case "restart_agent":
      case "stop_duplicate": {
        const agent = vars.agent;
        if (!agent || !view.agentIds().includes(agent)) {
          return `${agent ?? "(none)"} is not a configured agent`;
        }
        const procs = await view.agentProcesses(agent);
        if (pid === null || !procs.some((p) => p.pid === pid)) {
          return `pid ${vars.pid ?? "(none)"} is not a live process of agent ${agent}`;
        }
        if (action === "restart_agent") {
          const gate = view.waitingOn(agent);
          if (gate) return `agent ${agent} is WAITING on gate ${gate}`;
        } else if (procs.length < 2 || procs[0].pid === pid) {
          return `pid ${pid} is not a duplicate of agent ${agent}`;
        }
        return null;
      }
      case "release_claim": {
        if (!view.hasAgentPattern()) return "watchdog.agent_command is not set";
        const live = await view.agentProcesses(vars.agent ?? "");
        return live.length > 0 ? `agent ${vars.agent} has a live process (pid ${live[0].pid})` : null;
      }
      case "break_lock":
      case "requeue_gate":
        if (pid !== null && (await view.isAlive(pid))) {
          return `holder pid ${pid} is running`;
        }
        return null;
      default:
        return null;
    }
  }

  private async verify(step: PlaybookStep, state: StepState): Promise<StepOutcome> {
    const check = step.check ?? "recheck";
    if (check === "deferred") {
      return {
        status: "succeeded",
        deferred: true,
        output: "checked on later ticks: the breach closes when it is no longer detected",
      };
    }
    const view = this.freshView();
    if (check === "agent_restarted") {
      const agent = state.vars.agent ?? "";
      const oldPid = Number(state.vars.pid);
      const procs = await view.agentProcesses(agent);
      if (await view.isAlive(oldPid)) {
        return { status: "failed", error: `pid ${oldPid} of agent ${agent} is still running` };
      }
      if (procs.length === 0) {
        return { status: "failed", error: `agent ${agent} has no live process after the restart` };
      }
      return { status: "succeeded", output: `agent ${agent} is running as pid ${procs[0].pid}` };
    }
    const result = await getDetector(state.breach.detector).detect(view);
    const finding = result.findings.find((f) => f.key === state.breach.key);
    if (finding) {
      return { status: "failed", error: `still detected: ${finding.summary}` };
    }
    return { status: "succeeded", output: "no longer detected" };
  }
}
