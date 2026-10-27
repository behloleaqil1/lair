/**
 * The Settings view's notification form and requests (notifications-api.ts).
 * The routes themselves are tested in src/server/notifications/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationStatusView } from "../shared/notification-types";
import {
  NOTIFICATIONS_URL,
  formFrom,
  loadNotifications,
  resultLine,
  saveNotifications,
  sendTestNotification,
  updateFromForm,
} from "./notifications-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const view: NotificationStatusView = {
  settings: { desktop: true, ntfyUrl: null, ntfyTokenFile: false, reminderHours: 4, enabled: true },
  errors: [],
  desktopAvailable: { ok: true, detail: "macOS notifications (osascript)" },
  last: null,
  lastReminderAt: null,
};

describe("the notification form", () => {
  it("round-trips the settings; an empty topic is no phone push", () => {
    const form = formFrom(view);
    expect(form).toEqual({ desktop: true, ntfyUrl: "", reminderHours: "4" });
    expect(updateFromForm(form)).toEqual({ ok: true, update: { desktop: true, ntfyUrl: null, reminderHours: 4 } });
    expect(updateFromForm({ ...form, ntfyUrl: " https://ntfy.sh/lair-topic " })).toEqual({
      ok: true,
      update: { desktop: true, ntfyUrl: "https://ntfy.sh/lair-topic", reminderHours: 4 },
    });
  });

  it("asks for a topic URL and whole hours before sending anything", () => {
    for (const ntfyUrl of [
      "ntfy.sh/topic",
      "https://ntfy.sh/",
      "ftp://ntfy.sh/topic",
      "https://ntfy.sh/a b",
      "http://ntfy.sh/topic",
      "http://192.168.1.5/topic",
    ]) {
      expect(updateFromForm({ desktop: false, ntfyUrl, reminderHours: "4" })).toMatchObject({ ok: false });
    }
    // Plain http only to this machine
    for (const ntfyUrl of ["http://localhost:8090/topic", "http://127.0.0.1/topic"]) {
      expect(updateFromForm({ desktop: false, ntfyUrl, reminderHours: "4" })).toMatchObject({ ok: true });
    }
    for (const reminderHours of ["", "1.5", "-1", "169", "four"]) {
      expect(updateFromForm({ desktop: false, ntfyUrl: "", reminderHours })).toMatchObject({ ok: false });
    }
    expect(updateFromForm({ desktop: false, ntfyUrl: "", reminderHours: "0" })).toMatchObject({ ok: true });
  });

  it("says what each channel did", () => {
    expect(resultLine({ channel: "desktop", ok: true, detail: "shown" })).toBe("Desktop: shown");
    expect(resultLine({ channel: "ntfy", ok: false, detail: "ntfy.sh answered HTTP 403" })).toBe(
      "Phone (ntfy): failed: ntfy.sh answered HTTP 403",
    );
  });
});

describe("the notification requests", () => {
  it("read, save and test through the owner-only routes, and carry the server's refusal", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (init.method === "POST") {
        return new Response(JSON.stringify({ success: false, error: "Notifications are off" }), { status: 409 });
      }
      return new Response(JSON.stringify({ success: true, data: view }), { status: 200 });
    });
    expect(await loadNotifications()).toEqual({ status: 200, ok: true, data: view, error: undefined });
    expect((await saveNotifications({ desktop: true, ntfyUrl: null, reminderHours: 4 })).ok).toBe(true);
    expect(await sendTestNotification()).toEqual({ status: 409, ok: false, data: undefined, error: "Notifications are off" });
    expect(calls).toEqual([
      { url: NOTIFICATIONS_URL, method: "GET", body: undefined },
      { url: NOTIFICATIONS_URL, method: "PUT", body: { desktop: true, ntfyUrl: null, reminderHours: 4 } },
      { url: `${NOTIFICATIONS_URL}/test`, method: "POST", body: {} },
    ]);
  });

  it("a network failure is an answer, not a throw", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Failed to fetch");
    });
    expect(await loadNotifications()).toEqual({ status: 0, ok: false, error: "Failed to fetch" });
  });
});
