/**
 * What the planner needs from the agents module, in-process (the rule:
 * modules start runs through AgentsManager.requestRun, never over HTTP):
 * starting the planner agent's run, its runs and fill's done records in the
 * agents store, fill's lines, releasing a no_done hold for an unblock, and
 * recording its guards' verdicts where the spend API counts them.
 */
import type { AgentRunView, FillLineView, RunOrigin } from "../../shared/agents-types.js";
import type { AgentsManager, ModuleGuard } from "../agents/service.js";
import type { AgentsStore } from "../agents/store.js";
import type { StructuredReport } from "../bus/consumers.js";

export interface PlannerAgents {
  /** `origin`: planner or verifier, kept on the run for its AI spend record */
  requestRun(project: string, input: { agent: string; task: string; prompt: string }, options?: { origin?: RunOrigin }): Promise<AgentRunView>;
  /** The agents store, or null while no project runs the agents module */
  store(): AgentsStore | null;
  /** Fill's lines at its last check ([] when fill is off) */
  fillLines(project: string): FillLineView[];
  /** Release fill's no_done hold on `task`, as the planner (an owner hold is refused) */
  releaseFillHold(project: string, task: string): Promise<void>;
  /**
   * Whether the ready guard accepts a done line as `task`'s report (true when the guard is off); `report`: the bus
   * report the line was read from (bus.consume on), whose PR and head are its own fields
   */
  reportAccepted(project: string, agent: string, task: string, line: string, taskText: string, report?: StructuredReport | null): Promise<boolean>;
  /**
   * A G6 guard's verdict (docs/design/ai-spend.md §4.5): a guard_would (observe) or guard_did (act) event of the
   * agents module, once per dedupe key; nothing while agents.spend is off. True when this call recorded it.
   */
  recordGuard(project: string, kind: "guard_would" | "guard_did", guard: ModuleGuard): Promise<boolean>;
}

/** The agents module as the planner uses it (the service is looked up on every call, so a reload is followed). */
export function plannerAgentsFrom(manager: AgentsManager): PlannerAgents {
  return {
    requestRun: (project, input, options) => manager.requestRun(project, input, options),
    store: () => manager.getStore(),
    fillLines: (project) => manager.get(project)?.fillStatus().lines ?? [],
    reportAccepted: async (project, agent, task, line, taskText, report) =>
      (await manager.get(project)?.reportAccepted(agent, task, line, taskText, report ?? null)) ?? true,
    releaseFillHold: async (project, task) => {
      const service = manager.get(project);
      if (!service) throw new Error(`the agents module is off for ${project}`);
      await service.releaseFillHold(task, "planner");
    },
    recordGuard: (project, kind, guard) => manager.recordModuleGuard(project, kind, guard),
  };
}
