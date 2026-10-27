/**
 * The dashboard's WebSocket connection to the Lair server (/ws), without
 * React: useWebSocket.ts wraps it.
 *
 * When the server goes away (a restart, a crash) the socket closes, and
 * LiveSocket opens a new one after a backoff (reconnect.ts: 1 s, doubling,
 * at most 30 s), for as long as it runs. Once open, it subscribes to the
 * channels again (a restarted server knows none of them) and the backoff
 * starts over. stop() closes the socket on purpose: no reconnect follows.
 */
import { Reconnector, browserTimers, type ConnectionStatus, type Timers } from "./reconnect";

/** Messages longer than this are dropped unread */
export const MAX_MESSAGE_CHARS = 1_000_000;
const PING_INTERVAL_MS = 25_000;

/** The events of one socket, as LiveSocket handles them. */
export interface SocketHandlers {
  open(): void;
  message(data: string): void;
  error(): void;
  close(code: number, reason: string): void;
}

/** One open (or opening) socket. */
export interface SocketHandle {
  /** False when the socket isn't open */
  send(data: string): boolean;
  /** Close it on purpose: none of its handlers run after this */
  close(code?: number, reason?: string): void;
}

/** Opens a socket to `url` (the browser's WebSocket, or a fake in tests). */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

/** The browser's WebSocket behind a SocketHandle. */
export const openBrowserSocket: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.open();
  ws.onmessage = (event) => handlers.message(typeof event.data === "string" ? event.data : "");
  ws.onerror = () => handlers.error();
  ws.onclose = (event) => handlers.close(event.code, event.reason);
  return {
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(data);
      return true;
    },
    close(code, reason) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(code, reason);
      } catch {
        // Already closed
      }
    },
  };
};

export interface LiveSocketState {
  status: ConnectionStatus;
  /** Retries since the socket was last open */
  attempt: number;
  /** The wait before the scheduled retry, while reconnecting */
  retryInMs: number | null;
  error: string | null;
}

export interface LiveSocketOptions {
  url: string;
  /** Subscribed on every open */
  channels?: readonly string[];
  /** Open a new socket after a lost one (default true) */
  autoReconnect?: boolean;
  /** The first retry's wait (default 1 s); it doubles up to maxDelayMs */
  initialDelayMs?: number;
  maxDelayMs?: number;
  pingIntervalMs?: number;
  open?: SocketFactory;
  timers?: Timers;
  onState?: (state: LiveSocketState) => void;
  /** Each message the server sends, parsed */
  onMessage?: (message: unknown) => void;
}

export class LiveSocket {
  private socket: SocketHandle | null = null;
  private ping: unknown = null;
  private stopped = false;
  private everOpened = false;
  private readonly channels: Set<string>;
  private readonly reconnector: Reconnector;
  private readonly timers: Timers;
  private readonly open: SocketFactory;
  private current: LiveSocketState = { status: "connecting", attempt: 0, retryInMs: null, error: null };

  constructor(private readonly options: LiveSocketOptions) {
    this.timers = options.timers ?? browserTimers;
    this.open = options.open ?? openBrowserSocket;
    this.channels = new Set(options.channels ?? []);
    this.reconnector = new Reconnector(() => this.connect(), {
      initialMs: options.initialDelayMs,
      maxMs: options.maxDelayMs,
      timers: this.timers,
    });
  }

  get state(): LiveSocketState {
    return this.current;
  }

  /** The channels sent on every open. */
  get subscriptions(): string[] {
    return [...this.channels];
  }

  /** Open the first socket. */
  start(): void {
    if (this.stopped || this.socket) return;
    this.connect();
  }

  /** Close for good (unmount, a new project): cancels a scheduled retry. */
  stop(): void {
    this.stopped = true;
    this.reconnector.stop();
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Closed by the dashboard");
    this.setState({ status: "closed", attempt: 0, retryInMs: null });
  }

  /** Try now instead of waiting for the scheduled retry. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.reconnector.cancel();
    this.dropSocket();
    this.connect();
  }

  send(message: unknown): boolean {
    return this.socket?.send(JSON.stringify(message)) ?? false;
  }

  subscribe(channels: readonly string[]): void {
    for (const channel of channels) this.channels.add(channel);
    if (channels.length > 0) this.send({ type: "subscribe", channels: [...channels] });
  }

  unsubscribe(channels: readonly string[]): void {
    for (const channel of channels) this.channels.delete(channel);
    if (channels.length > 0) this.send({ type: "unsubscribe", channels: [...channels] });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState({
      status: this.everOpened || this.reconnector.attempts > 0 ? "reconnecting" : "connecting",
      retryInMs: null,
    });
    let socket: SocketHandle | null = null;
    const ours = () => socket !== null && this.socket === socket;
    try {
      socket = this.open(this.options.url, {
        open: () => {
          if (ours()) this.opened();
        },
        message: (data) => {
          if (ours()) this.received(data);
        },
        error: () => {
          if (ours()) this.setState({ error: "WebSocket connection error" });
        },
        close: () => {
          if (ours()) this.lost();
        },
      });
      this.socket = socket;
    } catch (e) {
      this.setState({ error: e instanceof Error ? e.message : "Failed to connect to WebSocket" });
      this.lost();
    }
  }

  private opened(): void {
    this.everOpened = true;
    this.reconnector.opened();
    this.setState({ status: "connected", attempt: 0, retryInMs: null, error: null });
    // A restarted server knows none of this page's subscriptions
    if (this.channels.size > 0) this.send({ type: "subscribe", channels: [...this.channels] });
    this.stopPing();
    this.ping = this.timers.setInterval(() => this.send({ type: "ping" }), this.options.pingIntervalMs ?? PING_INTERVAL_MS);
  }

  private received(data: string): void {
    if (data.length === 0 || data.length > MAX_MESSAGE_CHARS) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    this.options.onMessage?.(message);
  }

  /** The socket closed (or never opened): retry unless stopped. */
  private lost(): void {
    this.dropSocket();
    if (this.stopped) return;
    if (this.options.autoReconnect === false) {
      this.setState({ status: "closed", retryInMs: null });
      return;
    }
    const delay = this.reconnector.lost();
    this.setState({ status: "reconnecting", attempt: this.reconnector.attempts, retryInMs: delay });
  }

  private dropSocket(): void {
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private stopPing(): void {
    if (this.ping === null) return;
    this.timers.clearInterval(this.ping);
    this.ping = null;
  }

  private setState(update: Partial<LiveSocketState>): void {
    this.current = { ...this.current, ...update };
    this.options.onState?.(this.current);
  }
}
