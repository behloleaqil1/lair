/**
 * What each module of a project says of itself, for the module_errors
 * check: whether the project's YAML turns it on, its config errors (it did
 * not start), and its last error. Read from the managers' cheap accessors:
 * nothing here runs a command or calls a remote API.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentsManager } from "../agents/service.js";
import { NO_MODULES, moduleFlags } from "../dashboard/modules.js";
import type { DeliveryManager } from "../delivery/service.js";
import type { PipelineManager } from "../gates/pipeline-service.js";
import type { HostServicesManager } from "../host-services/service.js";
import type { PlacementManager } from "../placement/service.js";
import type { PlannerManager } from "../planner/manager.js";
import type { ReviewManager } from "../review/service.js";
import type { TriageManager } from "../triage/manager.js";
import type { WatchdogManager } from "../watchdog/service.js";
import type { ModuleReport } from "./checks.js";

export interface ReportingModules {
  watchdogs?: Pick<WatchdogManager, "status">;
  agents?: Pick<AgentsManager, "status">;
  triage?: Pick<TriageManager, "status">;
  placements?: Pick<PlacementManager, "status">;
  hostServices?: Pick<HostServicesManager, "status">;
  planner?: Pick<PlannerManager, "status">;
  reviews?: Pick<ReviewManager, "info">;
  delivery?: Pick<DeliveryManager, "report">;
  pipelines?: Pick<PipelineManager, "errors">;
}

/** Every module the server runs, as the project's YAML and the module see it. */
export function moduleReports(m: ReportingModules, project: string, config: ProjectConfig | null): ModuleReport[] {
  const on = config ? moduleFlags(config, 0) : NO_MODULES;
  const reports: ModuleReport[] = [];
  if (m.watchdogs) {
    const s = m.watchdogs.status(project);
    reports.push({ module: "watchdog", on: on.watchdog, errors: s.errors, lastError: s.lastError });
  }
  if (m.agents) {
    const s = m.agents.status(project);
    reports.push({ module: "agents", on: on.agents, errors: s.errors, lastError: s.lastError });
  }
  if (m.triage) {
    reports.push({ module: "triage", on: on.triage, errors: m.triage.status(project).errors, lastError: null });
  }
  if (m.placements) {
    const s = m.placements.status(project);
    reports.push({ module: "placement", on: on.placement, errors: s.errors, lastError: s.lastError });
  }
  if (m.hostServices) {
    const s = m.hostServices.status(project);
    reports.push({ module: "host-services", on: on.hostServices, errors: s.errors, lastError: s.lastError });
  }
  if (m.planner) {
    const s = m.planner.status(project);
    reports.push({ module: "planner", on: on.planner, errors: s.errors, lastError: s.lastError });
  }
  if (m.reviews) {
    reports.push({ module: "review", on: on.review, errors: m.reviews.info(project).errors, lastError: null });
  }
  if (m.delivery) {
    const s = m.delivery.report(project);
    reports.push({ module: "delivery", on: on.delivery, errors: s.errors, lastError: s.lastError });
  }
  if (m.pipelines) {
    reports.push({ module: "pipelines", on: on.pipelines, errors: m.pipelines.errors(project), lastError: null });
  }
  return reports;
}
