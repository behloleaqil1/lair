/**
 * The fleet bus as the server wires it into the agents module
 * (src/server/index.ts), per project behind its bus.consume: while it isn't
 * off, each run gets a bus token (its hash stored in the project's bus store,
 * revoked when the run ends) and fill reads the project's bus. Off: no token,
 * no bus.
 */
import type { AgentsBus } from "../agents/service.js";
import type { BusConsumers } from "./consumers.js";
import type { BusStore } from "./store.js";
import { hashBusToken, newBusToken } from "./tokens.js";

export interface AgentsBusOptions {
  consumers: BusConsumers;
  /** The project's bus store (the one the bus routes read: routes/bus.ts busStoreFor) */
  store: (project: string) => BusStore;
  clock: { now(): number };
  /** This server's URL, given to a run with a bus token as LAIR_URL */
  serverUrl?: string;
  warn?: (text: string) => void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function agentsBusFor(options: AgentsBusOptions): AgentsBus {
  const { consumers, store, clock, warn } = options;
  return {
    lineSource: (project) => consumers.lineSource(project),
    mintToken: (project, runId, agent) => {
      if (consumers.mode(project) === "off") return null;
      try {
        const token = newBusToken();
        store(project).issueToken(agent, runId, hashBusToken(token), clock.now());
        return token;
      } catch (e) {
        // The run starts without the bus: it can still write its queue lines by hand
        warn?.(`[bus] ${project}: no bus token for run ${runId.slice(0, 8)}: ${reason(e)}`);
        return null;
      }
    },
    revokeTokens: (project, runId) => {
      // Off: the bus routes refuse every token of the project anyway (they answer 404)
      if (consumers.mode(project) === "off") return;
      try {
        store(project).revokeTokensForRun(runId, clock.now());
      } catch (e) {
        warn?.(`[bus] ${project}: revoking run ${runId.slice(0, 8)}'s bus token failed: ${reason(e)}`);
      }
    },
    serverUrl: options.serverUrl,
  };
}
