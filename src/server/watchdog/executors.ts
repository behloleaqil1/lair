/**
 * The step executors. There is one built-in set and no way to register
 * others: diagnose and verify re-run the breach's detector on fresh probe
 * data, and act runs the project's configured command.
 *
 * Act steps are guarded twice: the detector only reports what it can
 * attribute, and the guard here re-checks on a fresh view right before the
 * command runs (a WAITING agent is never restarted, a live agent's claim is
 * never released, a live holder's lock is never broken, no pid that isn't a
 * configured agent's process is ever passed to a command, and no command runs
 * on a container whose delivery service a human holds).
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
  /** act: the guard found a false positive (e.g. live pid not matching the pattern) */
  falsePositive?: boolean;
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
 * that this breach provides. Values come from files (log text, file names),
 * so one that would turn an argument into an option (a leading "-" where the
 * template has none) is refused rather than passed on.
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
  const argv: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => vars[name] ?? "");
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      const name = arg.match(/^\{([A-Za-z_]+)\}/)?.[1] ?? "?";
      return {
        error: `watchdog.actions.${action}: the value of {${name}} starts with "-" and would be read as an option`,
      };
    }
    argv.push(filled);
  }
  return { argv };
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
    const guardResult = await this.guard(action, state.vars);
    if (guardResult.refused) {
      // A false positive (agent running by pid check): close the breach, no decision
      if (guardResult.falsePositive) {
        return { status: "succeeded", falsePositive: true, output: `false positive: ${guardResult.reason}` };
      }
      return { status: "failed", error: `refused: ${guardResult.reason}` };
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

  /** Why an action must not run on the current state; falsePositive means the breach is a false alarm */
  private async guard(
    action: ActionId,
    vars: Record<string, string>,
  ): Promise<{ refused: false } | { refused: true; reason: string; falsePositive?: boolean }> {
    // A container whose delivery service a human holds gets no command at all
    if (vars.container) {
      const held = this.ctx.services?.heldReason(this.ctx.project, vars.container);
      if (held) return { refused: true, reason: held };
    }
    const view = this.freshView();
    const pid = vars.pid ? Number(vars.pid) : null;
    switch (action) {
      case "restart_agent":
      case "stop_duplicate": {
        const agent = vars.agent;
        if (!agent || !view.agentIds().includes(agent)) {
          return { refused: true, reason: `${agent ?? "(none)"} is not a configured agent` };
        }
        if (!view.isLocalAgent(agent)) {
          return { refused: true, reason: `agent ${agent} runs on ${view.agentMachine(agent).machine}, whose processes are not visible here` };
        }
        const procs = await view.agentProcesses(agent);
        if (pid === null || !procs.some((p) => p.pid === pid)) {
          return { refused: true, reason: `pid ${vars.pid ?? "(none)"} is not a live process of agent ${agent}` };
        }
        if (action === "restart_agent") {
          const gate = view.waitingOn(agent);
          if (gate) return { refused: true, reason: `agent ${agent} is WAITING on gate ${gate}` };
        } else if (procs.length < 2 || procs[0].pid === pid) {
          return { refused: true, reason: `pid ${pid} is not a duplicate of agent ${agent}` };
        }
        return { refused: false };
      }
      case "release_claim": {
        if (!view.hasAgentPattern()) return { refused: true, reason: "watchdog.agent_command is not set" };
        if (!view.isLocalAgent(vars.agent ?? "")) {
          return { refused: true, reason: `agent ${vars.agent} runs on ${view.agentMachine(vars.agent ?? "").machine}, so its liveness is unknown here` };
        }
        const live = await view.agentProcesses(vars.agent ?? "");
        if (live.length > 0) {
          return { refused: true, reason: `agent ${vars.agent} has a live process (pid ${live[0].pid})` };
        }
        // Also check the claim file's recorded pid: if it is alive AND matches the agent,
        // the agent is running (even if it doesn't match watchdog.agent_command).
        // We verify the process matches to avoid false positives from pid reuse.
        const claim = view.claims().find((c) => c.agent === vars.agent);
        if (claim) {
          const claimPid = view.claimPid(claim);
          if (claimPid !== null) {
            const proc = await view.getProcess(claimPid.pid);
            if (proc !== null) {
              // Check if the process belongs to this agent by start time or command
              const expectedUptimeMs = claimPid.startedAt !== null ? view.now - claimPid.startedAt : null;
              const actualUptimeMs = proc.elapsedSeconds * 1000;
              const toleranceMs = expectedUptimeMs !== null ? Math.max(60000, expectedUptimeMs * 0.1) : 0;
              const startMatch =
                expectedUptimeMs !== null &&
                Math.abs(actualUptimeMs - expectedUptimeMs) <= toleranceMs;
              const commandMatch = proc.command.includes(vars.agent ?? "");
              if (startMatch || commandMatch) {
                return {
                  refused: true,
                  reason: `agent ${vars.agent} is running (claim's recorded pid ${claimPid.pid} is alive, though it doesn't match the pattern)`,
                  falsePositive: true,
                };
              }
              // The pid is alive but doesn't match - it's reused, don't block the release
            }
          }
        }
        return { refused: false };
      }
      case "break_lock":
      case "requeue_gate":
        if (pid !== null && (await view.isAlive(pid))) {
          return { refused: true, reason: `holder pid ${pid} is running` };
        }
        return { refused: false };
      default:
        return { refused: false };
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
