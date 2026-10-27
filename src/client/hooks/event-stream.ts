/**
 * A server-sent event stream that comes back after the server does: the
 * live feed's connection to /api/bus/events (LiveFeed.tsx), without React.
 *
 * The browser's EventSource retries a dropped connection by itself only
 * sometimes: an HTTP error while the server restarts (a proxy's 502, for
 * one) closes it for good, and the feed stayed "Disconnected". So any
 * connection error closes the EventSource here, and a new one is opened
 * after a backoff (reconnect.ts: 1 s, doubling, at most 30 s) until one
 * opens, which resets the backoff. stop() closes it on purpose.
 */
import { Reconnector, browserTimers, type ConnectionStatus, type Timers } from "./reconnect";

/** Events with more data than this are dropped unread */
export const MAX_EVENT_CHARS = 4_000_000;

export interface StreamHandlers {
  open(): void;
  /** The connection failed or dropped */
  error(): void;
  /** A named event the server sent */
  event(name: string, data: string): void;
}

export interface StreamHandle {
  /** Close it on purpose: none of its handlers run after this */
  close(): void;
}

/** Opens a stream to `url` that reports the named `events` (the browser's EventSource, or a fake in tests). */
export type StreamFactory = (url: string, events: readonly string[], handlers: StreamHandlers) => StreamHandle;

export const openBrowserEventSource: StreamFactory = (url, events, handlers) => {
  const source = new EventSource(url);
  source.onopen = () => handlers.open();
  source.onerror = (e) => {
    // A server-sent "error" event (with data) is a message, not a lost connection
    if (typeof (e as MessageEvent).data === "string") return;
    handlers.error();
  };
  const listeners = events.map((name) => {
    const listener = (e: Event) => {
      const data = (e as MessageEvent).data;
      if (typeof data === "string") handlers.event(name, data);
    };
    source.addEventListener(name, listener);
    return { name, listener };
  });
  return {
    close() {
      source.onopen = null;
      source.onerror = null;
      for (const { name, listener } of listeners) source.removeEventListener(name, listener);
      source.close();
    },
  };
};

export interface EventStreamState {
  status: ConnectionStatus;
  /** Retries since the stream was last open */
  attempt: number;
  /** The wait before the scheduled retry, while reconnecting */
  retryInMs: number | null;
}

export interface EventStreamOptions {
  url: string;
  /** The named events to report */
  events: readonly string[];
  onEvent: (name: string, data: string) => void;
  onState?: (state: EventStreamState) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  open?: StreamFactory;
  timers?: Timers;
}

export class EventStream {
  private stream: StreamHandle | null = null;
  private stopped = false;
  private everOpened = false;
  private readonly reconnector: Reconnector;
  private readonly open: StreamFactory;
  private current: EventStreamState = { status: "connecting", attempt: 0, retryInMs: null };

  constructor(private readonly options: EventStreamOptions) {
    this.open = options.open ?? openBrowserEventSource;
    this.reconnector = new Reconnector(() => this.connect(), {
      initialMs: options.initialDelayMs,
      maxMs: options.maxDelayMs,
      timers: options.timers ?? browserTimers,
    });
  }

  get state(): EventStreamState {
    return this.current;
  }

  start(): void {
    if (this.stopped || this.stream) return;
    this.connect();
  }

  /** Close for good (unmount, a new project): cancels a scheduled retry. */
  stop(): void {
    this.stopped = true;
    this.reconnector.stop();
    const stream = this.stream;
    this.stream = null;
    stream?.close();
    this.setState({ status: "closed", attempt: 0, retryInMs: null });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState({
      status: this.everOpened || this.reconnector.attempts > 0 ? "reconnecting" : "connecting",
      retryInMs: null,
    });
    let stream: StreamHandle | null = null;
    const ours = () => stream !== null && this.stream === stream;
    try {
      stream = this.open(this.options.url, this.options.events, {
        open: () => {
          if (!ours()) return;
          this.everOpened = true;
          this.reconnector.opened();
          this.setState({ status: "connected", attempt: 0, retryInMs: null });
        },
        error: () => {
          if (ours()) this.lost();
        },
        event: (name, data) => {
          if (!ours() || data.length > MAX_EVENT_CHARS) return;
          this.options.onEvent(name, data);
        },
      });
      this.stream = stream;
    } catch {
      this.lost();
    }
  }

  /** The stream failed: close it (the browser's own retry may never come) and retry with backoff. */
  private lost(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.close();
    if (this.stopped) return;
    const delay = this.reconnector.lost();
    this.setState({ status: "reconnecting", attempt: this.reconnector.attempts, retryInMs: delay });
  }

  private setState(update: Partial<EventStreamState>): void {
    this.current = { ...this.current, ...update };
    this.options.onState?.(this.current);
  }
}
