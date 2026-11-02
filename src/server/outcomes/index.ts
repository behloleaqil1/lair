/**
 * The outcome tracker (docs/design/decision-policies.md §4): records whether
 * each answered decision turned out good, bad or unknown, with structured
 * evidence, for the brain trainer and the bench. Read-only towards the rest of
 * Lair. Off unless data/server.yaml sets `outcome_tracker.enabled`.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { ServerConfigFileOptions } from "../restart/server-config.js";
import { loadOutcomeTrackerConfig } from "./config.js";
import { FactLog } from "./facts.js";
import { OutcomeTracker, type OutcomeDecisions, type Timers } from "./service.js";

export { OutcomeTracker } from "./service.js";
export { OUTCOME_TRACKER_OFF, parseOutcomeTrackerConfig } from "./config.js";

export interface MountOutcomeTrackerOptions {
  /** data/server.yaml */
  configPath: string;
  /** data/outcomes.db */
  dbPath: string;
  decisions: OutcomeDecisions;
  events: EventBus;
  clock?: () => Date;
  timers?: Timers;
  fileOptions?: ServerConfigFileOptions;
  log?: (line: string) => void;
}

/** The tracker when the section is on; null (nothing opened, nothing subscribed) when it is off or refused. */
export function mountOutcomeTracker(fastify: FastifyInstance, options: MountOutcomeTrackerOptions): OutcomeTracker | null {
  const config = loadOutcomeTrackerConfig(options.configPath, options.fileOptions);
  const log = options.log ?? ((line: string) => console.warn(line));
  if (!config.ok) {
    for (const error of config.errors) log(`[outcomes] off: ${error}`);
    return null;
  }
  if (!config.settings.enabled) return null;
  const facts = new FactLog(options.dbPath);
  // Only these two methods of the inbox reach the tracker: it can list waiting answers and record an outcome
  const decisions: OutcomeDecisions = Object.freeze({
    awaitingOutcome: (...args: Parameters<OutcomeDecisions["awaitingOutcome"]>) => options.decisions.awaitingOutcome(...args),
    recordOutcome: (...args: Parameters<OutcomeDecisions["recordOutcome"]>) => options.decisions.recordOutcome(...args),
  });
  const tracker = new OutcomeTracker({
    since: facts.enabledSince((options.clock ?? (() => new Date()))().toISOString()),
    decisions,
    facts,
    events: options.events,
    windows: config.settings.windows,
    checkMinutes: config.settings.checkMinutes,
    clock: options.clock,
    timers: options.timers,
    log,
  });
  tracker.subscribe();
  tracker.start();
  fastify.addHook("onClose", async () => {
    tracker.stop();
    facts.close();
  });
  return tracker;
}
