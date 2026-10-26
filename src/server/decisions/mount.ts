/**
 * Mount the Decision Inbox on a Fastify server: the store, the inbox, its
 * routes, the sweep timer, and the producers that raise decisions (today the
 * watchdog's escalations). Answers need an owner session from the shared
 * human credential (src/server/human-auth/), which the server creates and
 * passes in. src/server/index.ts calls this, and the wiring test calls the
 * same function, so what the test drives is what runs.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { HumanAuth } from "../human-auth/index.js";
import { registerDecisionRoutes } from "./routes.js";
import { MemorySecretStore, type SecretStore } from "./secrets.js";
import { DEFAULT_MAX_OPEN_HTTP_PER_PROJECT, DEFAULT_MAX_OPEN_PER_SOURCE, DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import type { Clock, DecisionProducer } from "./types.js";

/** A module that raises decisions and follows their answers, e.g. the WatchdogManager. */
export interface DecisionConsumer {
  useDecisions(decisions: DecisionProducer): void;
}

export interface MountDecisionsOptions {
  /** data/decisions.db in the server; ":memory:" in tests */
  dbPath: string;
  /** The owner's credential: answers need one of its sessions */
  humanAuth: HumanAuth;
  defaultProject: () => string;
  events?: EventBus;
  /** Where credentials go; default MemorySecretStore */
  secrets?: SecretStore;
  /** Connected before the server starts, so their escalations become decisions */
  producers?: DecisionConsumer[];
  clock?: Clock;
  sweepSeconds?: number;
  /** Open decisions per module and project; default LAIR_DECISIONS_MAX_OPEN, else 50 */
  maxOpenPerSource?: number;
  /** Open HTTP-raised decisions per project; default LAIR_DECISIONS_MAX_OPEN_HTTP, else 20 */
  maxOpenHttpPerProject?: number;
  env?: NodeJS.ProcessEnv;
}

/** A positive whole number from the environment, or undefined (with a warning when set to something else). */
function positiveFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  console.warn(`[decisions] ${name}=${raw} is not a positive whole number; using ${fallback}`);
  return undefined;
}

/** LAIR_DECISIONS_MAX_OPEN: open decisions per module and project. */
export function maxOpenFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveFromEnv(env, "LAIR_DECISIONS_MAX_OPEN", DEFAULT_MAX_OPEN_PER_SOURCE);
}

/** LAIR_DECISIONS_MAX_OPEN_HTTP: open decisions raised over HTTP per project, whatever the module. */
export function maxOpenHttpFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveFromEnv(env, "LAIR_DECISIONS_MAX_OPEN_HTTP", DEFAULT_MAX_OPEN_HTTP_PER_PROJECT);
}

export async function mountDecisions(
  fastify: FastifyInstance,
  options: MountDecisionsOptions,
): Promise<DecisionInbox> {
  const env = options.env ?? process.env;
  const store = new DecisionStore(options.dbPath);
  const inbox = new DecisionInbox({
    store,
    secrets: options.secrets ?? new MemorySecretStore(),
    events: options.events,
    clock: options.clock,
    sweepSeconds: options.sweepSeconds,
    maxOpenPerSource: options.maxOpenPerSource ?? maxOpenFromEnv(env),
    maxOpenHttpPerProject: options.maxOpenHttpPerProject ?? maxOpenHttpFromEnv(env),
  });
  await registerDecisionRoutes(fastify, inbox, options.defaultProject, options.humanAuth);
  for (const producer of options.producers ?? []) producer.useDecisions(inbox);
  inbox.start();
  // fastify.close() (the server's shutdown) stops the sweeps and closes the store
  fastify.addHook("onClose", async () => {
    await inbox.stop();
    store.close();
  });
  return inbox;
}
