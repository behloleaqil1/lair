/**
 * The Settings view's notification requests (src/server/notifications/routes.ts),
 * each with this browser's owner session (the server answers 403 without
 * it, reads included), and the form's rules, kept apart so tests check them.
 */
import { ownerHeaders } from "./owner-session";
import type {
  ChannelResult,
  NotificationSettingsUpdate,
  NotificationStatusView,
} from "../shared/notification-types";

export const NOTIFICATIONS_URL = "/api/owner/notifications";
export const MAX_REMINDER_HOURS = 168;

export interface NotificationsReply<T> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
}

async function call<T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown): Promise<NotificationsReply<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...ownerHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
  let payload: { success?: boolean; data?: unknown; error?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // Not JSON (a proxy's error page): the status says enough
  }
  const ok = payload.success === true && res.status < 400;
  return {
    status: res.status,
    ok,
    data: ok ? (payload.data as T) : undefined,
    error: ok ? undefined : (payload.error ?? `HTTP ${res.status}`),
  };
}

export function loadNotifications(): Promise<NotificationsReply<NotificationStatusView>> {
  return call("GET", NOTIFICATIONS_URL);
}

export function saveNotifications(update: NotificationSettingsUpdate): Promise<NotificationsReply<NotificationStatusView>> {
  return call("PUT", NOTIFICATIONS_URL, update);
}

export function sendTestNotification(): Promise<NotificationsReply<{ results: ChannelResult[] }>> {
  return call("POST", `${NOTIFICATIONS_URL}/test`, {});
}

export interface NotificationForm {
  desktop: boolean;
  /** The ntfy topic URL as typed; empty: no phone push */
  ntfyUrl: string;
  reminderHours: string;
}

export function formFrom(view: NotificationStatusView): NotificationForm {
  return {
    desktop: view.settings.desktop,
    ntfyUrl: view.settings.ntfyUrl ?? "",
    reminderHours: String(view.settings.reminderHours),
  };
}

/** The PUT body for the form, or what to fix first. */
export function updateFromForm(form: NotificationForm): { ok: true; update: NotificationSettingsUpdate } | { ok: false; error: string } {
  const url = form.ntfyUrl.trim();
  if (url !== "" && !/^https?:\/\/[^/\s]+\/\S+$/.test(url)) {
    return { ok: false, error: "The ntfy topic must be an http or https URL with the topic, e.g. https://ntfy.sh/<topic>" };
  }
  const text = form.reminderHours.trim();
  const hours = Number(text);
  if (text === "" || !Number.isInteger(hours) || hours < 0 || hours > MAX_REMINDER_HOURS) {
    return { ok: false, error: `The reminder needs a whole number of hours from 0 (off) to ${MAX_REMINDER_HOURS}` };
  }
  return { ok: true, update: { desktop: form.desktop, ntfyUrl: url === "" ? null : url, reminderHours: hours } };
}

const CHANNEL_LABELS: Record<ChannelResult["channel"], string> = { desktop: "Desktop", ntfy: "Phone (ntfy)" };

/** One channel's result in a line: "Desktop: shown", "Phone (ntfy): failed: ...". */
export function resultLine(result: ChannelResult): string {
  return `${CHANNEL_LABELS[result.channel]}: ${result.ok ? result.detail : `failed: ${result.detail}`}`;
}
