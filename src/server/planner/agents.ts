/**
 * What the planner needs from the agents module, in-process (the rule:
 * modules start runs through AgentsManager.requestRun, never over HTTP):
 * starting the planner agent's run, its runs and fill's done records in the
 * agents store, fill's lines, and releasing a no_done hold for an unblock.
 */
import type { AgentRunView, FillLineView } from "../../shared/agents-types.js";
import type { AgentsManager } from "../agents/service.js";
import type { AgentsStore } from "../agents/store.js";

export interface PlannerAgents {
  requestRun(project: string, input: { agent: string; task: string; prompt: string }): Promise<AgentRunView>;
  /** The agents store, or null while no project runs the agents module */
  store(): AgentsStore | null;
  /** Fill's lines at its last check ([] when fill is off) */
  fillLines(project: string): FillLineView[];
  /** Release fill's no_done hold on `task`, as the planner (an owner hold is refused) */
  releaseFillHold(project: string, task: string): Promise<void>;
}

/** The agents module as the planner uses it (the service is looked up on every call, so a reload is followed). */
export function plannerAgentsFrom(manager: AgentsManager): PlannerAgents {
  return {
    requestRun: (project, input) => manager.requestRun(project, input),
    store: () => manager.getStore(),
    fillLines: (project) => manager.get(project)?.fillStatus().lines ?? [],
    releaseFillHold: async (project, task) => {
      const service = manager.get(project);
      if (!service) throw new Error(`the agents module is off for ${project}`);
      await service.releaseFillHold(task, "planner");
    },
  };
}
