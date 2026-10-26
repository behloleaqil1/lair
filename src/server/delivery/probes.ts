/**
 * Delivery probes: the only places delivery touches the system. It runs
 * commands (docker, git) through the watchdog's CommandRunner (execFile,
 * never a shell), reads the time through its Clock, and asks HTTP health
 * URLs through HttpProbe. Tests replace these three and nothing else.
 */
import { ExecFileRunner, systemClock, type Clock, type CommandRunner } from "../watchdog/probes.js";

export type HttpAnswer = { status: number } | { error: string };

/** GETs a health URL. */
export interface HttpProbe {
  get(url: string, timeoutMs: number): Promise<HttpAnswer>;
}

export interface DeliveryProbes {
  runner: CommandRunner;
  clock: Clock;
  http: HttpProbe;
}

/** fetch() as an HttpProbe: redirects are not followed, the body is not read. */
export const fetchProbe: HttpProbe = {
  async get(url, timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status };
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      return { error: `${e instanceof Error ? e.message : String(e)}${cause}` };
    }
  },
};

/** The real probes. */
export function systemDeliveryProbes(commandTimeoutMs: number): DeliveryProbes {
  return { runner: new ExecFileRunner(commandTimeoutMs), clock: systemClock, http: fetchProbe };
}
