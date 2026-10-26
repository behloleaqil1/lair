/**
 * Mount the Decision Inbox on a Fastify server: the store, the inbox, the
 * answer token, its routes, the sweep timer, and the producers that raise
 * decisions (today the watchdog's escalations). src/server/index.ts calls
 * this, and the wiring test calls the same function, so what the test drives
 * is what runs.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import { AnswerCredential } from "./answer-auth.js";
import { registerDecisionRoutes } from "./routes.js";
import { MemorySecretStore, type SecretStore } from "./secrets.js";
import { DEFAULT_MAX_OPEN_PER_SOURCE, DecisionInbox } from "./service.js";
import { DecisionStore } from "./store.js";
import type { Clock, DecisionProducer } from "./types.js";

/** A module that raises decisions and follows their answers, e.g. the WatchdogManager. */
export interface DecisionConsumer {
  useDecisions(decisions: DecisionProducer): void;
}

export interface MountDecisionsOptions {
  /** data/decisions.db in the server; ":memory:" in tests */
  dbPath: string;
  /** data/decisions.answer-token in the server: created (mode 0600) on first start */
  answerTokenPath: string;
  /** Where the dashboard is served, for the one-time setup link, e.g. http://127.0.0.1:4777 */
  dashboardUrl: string;
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
  /** Where the setup link is printed; default console.log */
  log?: (line: string) => void;
}

/** The dashboard's URL for a bind address: a wildcard means this machine (localhost). */
export function dashboardUrlFor(host: string, port: number): string {
  const h = host.trim();
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]") return `http://localhost:${port}`;
  return `http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${port}`;
}

/** LAIR_DECISIONS_MAX_OPEN as a positive integer, or undefined (with a warning when it is not one). */
export function maxOpenFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.LAIR_DECISIONS_MAX_OPEN?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  console.warn(
    `[decisions] LAIR_DECISIONS_MAX_OPEN=${raw} is not a positive whole number; using ${DEFAULT_MAX_OPEN_PER_SOURCE}`,
  );
  return undefined;
}

export async function mountDecisions(
  fastify: FastifyInstance,
  options: MountDecisionsOptions,
): Promise<DecisionInbox> {
  const log = options.log ?? ((line: string) => console.log(line));
  const credential = AnswerCredential.loadOrCreate(options.answerTokenPath);
  if (credential.created) {
    log(
      `[decisions] Answering decisions is locked to your browser. Open this link once to unlock it: ` +
        `${credential.setupUrl(options.dashboardUrl)} (or paste the token from ${options.answerTokenPath} in the Decisions view)`,
    );
  } else {
    log(`[decisions] The answer token is in ${options.answerTokenPath}`);
  }

  const store = new DecisionStore(options.dbPath);
  const inbox = new DecisionInbox({
    store,
    secrets: options.secrets ?? new MemorySecretStore(),
    events: options.events,
    clock: options.clock,
    sweepSeconds: options.sweepSeconds,
    maxOpenPerSource: options.maxOpenPerSource ?? maxOpenFromEnv(),
  });
  await registerDecisionRoutes(fastify, inbox, options.defaultProject, credential);
  for (const producer of options.producers ?? []) producer.useDecisions(inbox);
  inbox.start();
  // fastify.close() (the server's shutdown) stops the sweeps and closes the store
  fastify.addHook("onClose", async () => {
    await inbox.stop();
    store.close();
  });
  return inbox;
}
