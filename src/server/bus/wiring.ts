/**
 * The fleet bus as the server wires it into the agents module
 * (src/server/index.ts), per project. Each run gets a bus token (its hash
 * stored in the project's bus store) while the project's bus.consume isn't
 * off, or while another module takes the token (`tokenUsers`: the checks);
 * fill reads the project's bus while bus.consume isn't off. Neither: no
 * token, no bus, as before.
 *
 * Revocation is unconditional: every way a run ends revokes its token, also
 * after a reload switched bus.consume off (a token this server minted is in
 * a store it has open), and at start the agents module revokes the tokens of
 * every run that isn't active (runs that ended while no server was there to
 * revoke them). Neither creates a bus store for a project that has none.
 */
import type { AgentsBus } from "../agents/service.js";
import type { BusConsumers } from "./consumers.js";
import type { BusStore } from "./store.js";
import { hashBusToken, newBusToken } from "./tokens.js";

export interface AgentsBusOptions {
  consumers: BusConsumers;
  /** The project's bus store (the one the bus routes read: routes/bus.ts busStoreFor), created when missing */
  store: (project: string) => BusStore;
  /** The project's bus store if this process has it open, else null: nothing opened or created (store.ts openedBusStore) */
  openedStore: (project: string) => BusStore | null;
  /** The project's bus store if it is open or its file exists, else null: nothing created (store.ts existingBusStore) */
  existingStore: (project: string) => Promise<BusStore | null>;
  clock: { now(): number };
  /** This server's URL, given to a run with a bus token as LAIR_URL */
  serverUrl?: string;
  /** Whether another module takes the project's run tokens (the checks routes): its runs get one with the bus off too */
  tokenUsers?: (project: string) => boolean;
  warn?: (text: string) => void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function agentsBusFor(options: AgentsBusOptions): AgentsBus {
  const { consumers, store, openedStore, existingStore, clock, warn } = options;
  const wantsTokens = (project: string) => consumers.mode(project) !== "off" || options.tokenUsers?.(project) === true;
  const revokeIn = (project: string, runId: string, bus: BusStore) => {
    try {
      bus.revokeTokensForRun(runId, clock.now());
    } catch (e) {
      warn?.(`[bus] ${project}: revoking run ${runId.slice(0, 8)}'s bus token failed: ${reason(e)}`);
    }
  };
  return {
    lineSource: (project) => consumers.lineSource(project),
    mintToken: (project, runId, agent) => {
      if (!wantsTokens(project)) return null;
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
      // Whatever the mode is now. A token minted here is in a store this process has open: revoked at once
      const open = openedStore(project);
      if (open !== null) return revokeIn(project, runId, open);
      // Not open: only an earlier server can have minted one, and only when the store's file exists
      void existingStore(project).then(
        (existing) => {
          if (existing !== null) revokeIn(project, runId, existing);
        },
        (e: unknown) => warn?.(`[bus] ${project}: revoking run ${runId.slice(0, 8)}'s bus token failed: ${reason(e)}`),
      );
    },
    sweepTokens: async (project, activeRunIds) => {
      const existing = await existingStore(project);
      if (existing === null) return; // the project never had a bus store: no token to revoke
      // The active runs are read right before the revocation (no await between): a run started meanwhile keeps its token
      const revoked = existing.revokeTokensExcept(activeRunIds(), clock.now());
      if (revoked > 0) warn?.(`[bus] ${project}: revoked ${revoked} bus token(s) of runs that are no longer active`);
    },
    serverUrl: options.serverUrl,
  };
}
