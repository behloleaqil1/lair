/**
 * Reconnecting after the server goes away (a restart, a crash, the network):
 * the backoff between attempts and the scheduling of the next one. Used by
 * the WebSocket connection (live-socket.ts) and the live feed's event stream
 * (event-stream.ts). Kept free of React and of the browser's timers, so the
 * tests drive it with a fake clock.
 */

/** The first retry waits this long */
export const RECONNECT_INITIAL_MS = 1000;
/** No retry waits longer than this */
export const RECONNECT_MAX_MS = 30_000;

/**
 * The wait before retry number `attempt` (0 for the first): the initial
 * delay, doubled per attempt, capped at `maxMs`.
 */
export function backoffDelay(
  attempt: number,
  initialMs: number = RECONNECT_INITIAL_MS,
  maxMs: number = RECONNECT_MAX_MS,
): number {
  const n = Number.isFinite(attempt) ? Math.min(Math.max(0, Math.floor(attempt)), 30) : 30;
  const first = Math.max(1, initialMs);
  return Math.min(Math.max(first, maxMs), first * 2 ** n);
}

/** The timers a connection uses: the browser's, or a fake clock in tests. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * - connecting: the first attempt
 * - connected: open
 * - reconnecting: lost (or never reached), the next attempt is scheduled or under way
 * - closed: stopped on purpose (unmounted, project changed), or lost with reconnecting off
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

/** What the dashboard shows for a connection status. */
export function connectionLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "closed":
      return "Disconnected";
  }
}

export interface ReconnectorOptions {
  initialMs?: number;
  maxMs?: number;
  timers?: Timers;
}

/**
 * Schedules the next attempt after a lost connection, with backoff. A
 * successful open resets the backoff; stop() cancels a scheduled attempt
 * for good.
 */
export class Reconnector {
  private attempt = 0;
  private handle: unknown = null;
  private stopped = false;
  private readonly timers: Timers;
  private readonly initialMs: number;
  private readonly maxMs: number;

  constructor(
    private readonly connect: () => void,
    options: ReconnectorOptions = {},
  ) {
    this.timers = options.timers ?? browserTimers;
    this.initialMs = options.initialMs ?? RECONNECT_INITIAL_MS;
    this.maxMs = options.maxMs ?? RECONNECT_MAX_MS;
  }

  /** Retries scheduled since the connection was last open */
  get attempts(): number {
    return this.attempt;
  }

  /** True while an attempt is scheduled */
  get pending(): boolean {
    return this.handle !== null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** The connection opened: the next loss starts from the first delay again. */
  opened(): void {
    this.attempt = 0;
  }

  /**
   * The connection was lost, or an attempt failed: try again after the next
   * delay. Returns that delay, or null when stopped or already scheduled.
   */
  lost(): number | null {
    if (this.stopped || this.handle !== null) return null;
    const delay = backoffDelay(this.attempt, this.initialMs, this.maxMs);
    this.attempt++;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      if (!this.stopped) this.connect();
    }, delay);
    return delay;
  }

  /** Drop a scheduled attempt (a manual reconnect is about to run). */
  cancel(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  /** Stop for good: nothing scheduled runs, and lost() schedules nothing. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }
}
