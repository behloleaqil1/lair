/**
 * Mount the Decision Inbox on a Fastify server: the store, the inbox, its
 * routes, the sweep timer, and the producers that raise decisions (today the
 * watchdog's escalations). src/server/index.ts calls this, and the wiring
 * test calls the same function, so what the test drives is what runs.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import { registerDecisionRoutes } from "./routes.js";
import { MemorySecretStore, type SecretStore } from "./secrets.js";
import { DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import type { Clock, DecisionProducer } from "./types.js";

/** A module that raises decisions and follows their answers, e.g. the WatchdogManager. */
export interface DecisionConsumer {
  useDecisions(decisions: DecisionProducer): void;
}

export interface MountDecisionsOptions {
  /** data/decisions.db in the server; ":memory:" in tests */
  dbPath: string;
  defaultProject: () => string;
  events?: EventBus;
  /** Where credentials go; default MemorySecretStore */
  secrets?: SecretStore;
  /** Connected before the server starts, so their escalations become decisions */
  producers?: DecisionConsumer[];
  clock?: Clock;
  sweepSeconds?: number;
}

export async function mountDecisions(
  fastify: FastifyInstance,
  options: MountDecisionsOptions,
): Promise<DecisionInbox> {
  const store = new DecisionStore(options.dbPath);
  const inbox = new DecisionInbox({
    store,
    secrets: options.secrets ?? new MemorySecretStore(),
    events: options.events,
    clock: options.clock,
    sweepSeconds: options.sweepSeconds,
  });
  await registerDecisionRoutes(fastify, inbox, options.defaultProject);
  for (const producer of options.producers ?? []) producer.useDecisions(inbox);
  inbox.start();
  // fastify.close() (the server's shutdown) stops the sweeps and closes the store
  fastify.addHook("onClose", async () => {
    await inbox.stop();
    store.close();
  });
  return inbox;
}
