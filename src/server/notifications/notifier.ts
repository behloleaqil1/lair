/**
 * The notifier: tells the owner when something needs them, opt-in
 * (data/server.yaml `notifications:`, read again at every use).
 *
 * - A new `action` decision (the bus's decision.raised) notifies; a notice
 *   never does.
 * - Batched: at most one notification per BATCH_MS. The first item waits
 *   GATHER_MS for others raised with it; items raised within a minute of the
 *   last notification wait for that minute to end. Then the items still
 *   open go out together: one as "Lair: <its title>, needs you" with its
 *   link (#/decisions/<id>), several as "Lair: N things need you". So a new
 *   action item notifies within a minute.
 * - A daily reminder while action items stay open longer than
 *   reminder_hours: at most one per day, also across a restart (the time of
 *   the last one is kept in a small owner-only state file).
 * - Titles only, bounded: never a decision's context, a log line or a secret.
 * - A failing channel is logged once per distinct problem and never throws
 *   or holds up the Decision Inbox.
 */
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "fs";
import { dirname } from "path";
import type { Decision } from "../../shared/decision-types.js";
import type { ChannelResult, NotificationStatusView } from "../../shared/notification-types.js";
import { readRegularFile } from "../read-file.js";
import { notificationsOn, type NotificationConfigResult, type NotificationSettings } from "./config.js";
import { MAX_TITLE_CHARS, plainText, type NotificationMessage, type Sender } from "./senders.js";

export const BATCH_MS = 60_000;
export const GATHER_MS = 5_000;
export const REMINDER_CHECK_MS = 10 * 60_000;
export const REMINDER_FIRST_CHECK_MS = 60_000;
export const DAY_MS = 24 * 60 * 60_000;
const MAX_PENDING = 500;
const MAX_LOGGED = 100;
const STATE_MAX_BYTES = 4096;

/** setTimeout as the notifier uses it (unref'd); the tests' clock drives a fake one. */
export interface Timers {
  /** Run `fn` after `ms`; returns the cancel function */
  set(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** The Decision Inbox as the notifier reads it (DecisionInbox.list). */
export interface NotifierInbox {
  list(options: { status: "open"; attention: "action"; limit: number }): Decision[];
}

export interface NotifierOptions {
  /** data/server.yaml's notifications section, read at every use */
  settings: () => NotificationConfigResult;
  /** The senders the settings turn on */
  senders: (settings: NotificationSettings) => Sender[];
  inbox: NotifierInbox;
  /** The dashboard's address, e.g. http://127.0.0.1:4777 */
  dashboardUrl: string;
  /** Where the last reminder's time is kept (data/notifications-state.json) */
  statePath: string;
  /** Whether desktop notifications can be shown here (for the Settings view) */
  desktopAvailability: () => { ok: boolean; detail: string };
  clock?: { now(): number };
  timers?: Timers;
  log?: (line: string) => void;
}

const HEAD = "Lair: ";

/** "Lair: <title><tail>", the title cut so the whole fits MAX_TITLE_CHARS. */
function titled(title: string, tail: string, fallback: string): string {
  const room = MAX_TITLE_CHARS - HEAD.length - tail.length;
  const text = plainText(title, room);
  return text ? `${HEAD}${text}${tail}` : `${HEAD}${fallback}${tail}`;
}

export class Notifier {
  private clock: { now(): number };
  private timers: Timers;
  private log: (line: string) => void;
  private base: string;
  /** Action items raised since the last notification: id -> title, and what it is about (project, module, key) */
  private pending = new Map<string, { title: string; about: string | null }>();
  /**
   * When each condition (project, module, key) was last in a notification: a
   * decision withdrawn and raised again for the same hold (a line taken out
   * of the tasks file and put back) doesn't notify again within the window
   */
  private notifiedAbout = new Map<string, number>();
  private lastSentAt: number | null = null;
  private cancelFlush: (() => void) | null = null;
  private cancelReminder: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** undefined: not read from the state file yet */
  private lastReminderAt: number | null | undefined = undefined;
  private last: NotificationStatusView["last"] = null;
  private logged = new Set<string>();
  private stopped = false;

  constructor(private options: NotifierOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? ((line) => console.warn(line));
    this.base = options.dashboardUrl.replace(/\/+$/, "");
  }

  private link(id?: string): string {
    return id ? `${this.base}/#/decisions/${encodeURIComponent(id)}` : `${this.base}/#/decisions`;
  }

  /** Log a problem once, until its channel works again. */
  private logOnce(key: string, line: string): void {
    if (this.logged.has(key)) return;
    if (this.logged.size >= MAX_LOGGED) this.logged.clear();
    this.logged.add(key);
    this.log(line);
  }

  private forget(prefix: string): void {
    for (const key of [...this.logged]) if (key.startsWith(prefix)) this.logged.delete(key);
  }

  /** The settings now; a refused or invalid section is off, and logged once. */
  private current(): NotificationSettings {
    const config = this.options.settings();
    if (!config.ok) {
      this.logOnce(`config:${config.errors.join("; ")}`, `[notifications] off: ${config.errors.join("; ")}`);
    } else {
      this.forget("config:");
    }
    return config.settings;
  }

  /** Serialize flushes, reminders and tests; a failure is logged, never thrown at the timer. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      (e: unknown) => this.logOnce(`internal:${String(e)}`, `[notifications] ${e instanceof Error ? e.message : String(e)}`),
    );
    return run;
  }

  /** Resolves once the work queued so far is done. */
  idle(): Promise<void> {
    return this.queue;
  }

  // ============ NEW ACTION ITEMS ============

  /** A decision.raised event's data. Only an action item, with notifications on, is queued. */
  onRaised(data: Record<string, unknown>): void {
    if (this.stopped || data.attention !== "action") return;
    const id = typeof data.decisionId === "string" ? data.decisionId.slice(0, 100) : null;
    if (!id) return;
    const settings = this.current();
    if (!notificationsOn(settings)) return;
    const about =
      typeof data.project === "string" && typeof data.module === "string" && typeof data.key === "string"
        ? `${data.project}\n${data.module}\n${data.key}`.slice(0, 600)
        : null;
    // The same condition asked again soon after it was notified (withdrawn, then raised again): no second push
    const told = about ? this.notifiedAbout.get(about) : undefined;
    if (told !== undefined && this.clock.now() - told < this.repeatWindow(settings)) return;
    if (!this.pending.has(id) && this.pending.size >= MAX_PENDING) return;
    this.pending.set(id, { title: typeof data.title === "string" ? data.title.slice(0, 1000) : "", about });
    this.scheduleFlush();
  }

  /** How long a condition that was notified isn't notified again: the reminder's hours (a day without one), at least the batch. */
  private repeatWindow(settings: NotificationSettings): number {
    return Math.max(BATCH_MS, settings.reminderHours > 0 ? settings.reminderHours * 60 * 60_000 : DAY_MS);
  }

  private rememberNotified(abouts: (string | null)[], at: number): void {
    for (const about of abouts) if (about) this.notifiedAbout.set(about, at);
    if (this.notifiedAbout.size > MAX_PENDING) {
      for (const [about, t] of this.notifiedAbout) if (at - t >= DAY_MS) this.notifiedAbout.delete(about);
    }
  }

  private scheduleFlush(): void {
    if (this.cancelFlush || this.stopped) return;
    const now = this.clock.now();
    const at = Math.max(now + GATHER_MS, this.lastSentAt === null ? 0 : this.lastSentAt + BATCH_MS);
    this.cancelFlush = this.timers.set(() => {
      this.cancelFlush = null;
      this.enqueue(() => this.flush()).catch(() => undefined);
    }, at - now);
  }

  /** Send what is pending and still open, as one notification. */
  private async flush(): Promise<void> {
    if (this.pending.size === 0 || this.stopped) return;
    const settings = this.current();
    if (!notificationsOn(settings)) {
      this.pending.clear();
      return;
    }
    const now = this.clock.now();
    // A reminder may have gone out meanwhile: the minute counts from it
    if (this.lastSentAt !== null && now - this.lastSentAt < BATCH_MS) {
      this.scheduleFlush();
      return;
    }
    const waiting = [...this.pending.entries()];
    this.pending.clear();
    let open: Set<string>;
    try {
      open = new Set(this.options.inbox.list({ status: "open", attention: "action", limit: 500 }).map((d) => d.id));
    } catch (e) {
      this.logOnce("inbox", `[notifications] could not read the Decision Inbox: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Answered or withdrawn meanwhile: nothing to tell
    const still = waiting.filter(([id]) => open.has(id));
    if (still.length === 0) return;
    const message: NotificationMessage =
      still.length === 1
        ? { title: titled(still[0][1].title, ", needs you", "a decision"), body: `Open ${this.link(still[0][0])}`, link: this.link(still[0][0]) }
        : { title: `${HEAD}${still.length} things need you`, body: `Open ${this.link()}`, link: this.link() };
    await this.deliver("batch", message, settings);
    this.rememberNotified(still.map(([, item]) => item.about), this.clock.now());
  }

  /** Send through every channel on; never throws. */
  private async deliver(kind: "batch" | "reminder" | "test", message: NotificationMessage, settings: NotificationSettings) {
    const results: ChannelResult[] = [];
    for (const sender of this.options.senders(settings)) {
      let result: ChannelResult;
      try {
        result = await sender.send(message);
      } catch (e) {
        result = { channel: sender.channel, ok: false, detail: plainText(e instanceof Error ? e.message : String(e), 200) };
      }
      results.push(result);
      if (result.ok) this.forget(`${sender.channel}:`);
      else this.logOnce(`${sender.channel}:${result.detail}`, `[notifications] ${sender.channel}: ${result.detail}`);
    }
    const now = this.clock.now();
    if (kind !== "test") this.lastSentAt = now;
    this.last = { at: new Date(now).toISOString(), title: message.title, kind, results };
    return results;
  }

  // ============ THE DAILY REMINDER ============

  private readState(): number | null {
    const path = this.options.statePath;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return null;
      const text = readRegularFile(path, { maxBytes: STATE_MAX_BYTES, noFollow: true });
      const value = (JSON.parse(text) as { lastReminderAt?: unknown }).lastReminderAt;
      const at = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(at) ? at : null;
    } catch {
      // Missing, unreadable or corrupt: as if no reminder went out yet
      return null;
    }
  }

  /** Write the state file atomically, owner-only (0600). */
  private writeState(at: number): void {
    const path = this.options.statePath;
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ lastReminderAt: new Date(at).toISOString() })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      this.forget("state:");
    } catch (e) {
      rmSync(temp, { force: true });
      this.logOnce("state:write", `[notifications] could not keep the reminder's time in ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private lastReminder(): number | null {
    if (this.lastReminderAt === undefined) this.lastReminderAt = this.readState();
    return this.lastReminderAt;
  }

  /** Remind once a day while action items stay open longer than reminder_hours. */
  checkReminder(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const settings = this.current();
      if (!notificationsOn(settings) || settings.reminderHours <= 0) return;
      const now = this.clock.now();
      const last = this.lastReminder();
      if (last !== null && now - last < DAY_MS) return;
      // Never two notifications within a minute: the next check takes it
      if (this.lastSentAt !== null && now - this.lastSentAt < BATCH_MS) return;
      const cutoff = now - settings.reminderHours * 3_600_000;
      let stale: Decision[];
      try {
        stale = this.options.inbox
          .list({ status: "open", attention: "action", limit: 500 })
          .filter((d) => Date.parse(d.createdAt) <= cutoff);
      } catch (e) {
        this.logOnce("inbox", `[notifications] could not read the Decision Inbox: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (stale.length === 0) return;
      this.lastReminderAt = now;
      this.writeState(now);
      const message: NotificationMessage =
        stale.length === 1
          ? { title: titled(stale[0].title, ", still needs you", "a decision"), body: `Open ${this.link(stale[0].id)}`, link: this.link(stale[0].id) }
          : { title: `${HEAD}${stale.length} things still need you`, body: `Open ${this.link()}`, link: this.link() };
      await this.deliver("reminder", message, settings);
    });
  }

  // ============ TEST, STATUS, LIFECYCLE ============

  /** The Settings view's "Send test notification": every channel on, now (not counted in the minute). */
  sendTest(): Promise<{ ok: true; results: ChannelResult[] } | { ok: false; error: string }> {
    return this.enqueue(async () => {
      const settings = this.current();
      if (!notificationsOn(settings)) {
        return { ok: false as const, error: "Notifications are off: turn on desktop notifications or set an ntfy topic first" };
      }
      const results = await this.deliver(
        "test",
        { title: `${HEAD}test notification`, body: `Notifications from Lair reach you here. Open ${this.base}`, link: `${this.base}/` },
        settings,
      );
      return { ok: true as const, results };
    });
  }

  status(): NotificationStatusView {
    const config = this.options.settings();
    const s = config.settings;
    const reminder = this.lastReminder();
    return {
      settings: {
        desktop: s.desktop,
        ntfyUrl: s.ntfy?.url ?? null,
        ntfyTokenFile: Boolean(s.ntfy?.tokenFile),
        reminderHours: s.reminderHours,
        enabled: notificationsOn(s),
      },
      errors: config.ok ? [] : config.errors,
      desktopAvailable: this.options.desktopAvailability(),
      last: this.last,
      lastReminderAt: reminder === null ? null : new Date(reminder).toISOString(),
    };
  }

  /** Check for the reminder soon, then every REMINDER_CHECK_MS, until stop(). */
  start(): void {
    if (this.cancelReminder || this.stopped) return;
    const loop = (ms: number) => {
      this.cancelReminder = this.timers.set(() => {
        this.checkReminder()
          .catch(() => undefined)
          .finally(() => {
            if (!this.stopped) loop(REMINDER_CHECK_MS);
          });
      }, ms);
    };
    loop(REMINDER_FIRST_CHECK_MS);
  }

  /** Stop the timers and drop what is pending; resolves once the work in progress is done. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.cancelReminder?.();
    this.cancelReminder = null;
    this.pending.clear();
    await this.queue;
  }
}
