/**
 * Notification settings and results, shared by the server
 * (src/server/notifications/) and the Settings view.
 */

export type NotificationChannel = "desktop" | "ntfy";

/** What one channel did with one notification. `detail` never carries a token or a decision's context. */
export interface ChannelResult {
  channel: NotificationChannel;
  ok: boolean;
  detail: string;
}

export interface NotificationSettingsView {
  /** Desktop notifications on this machine (macOS osascript, Linux notify-send) */
  desktop: boolean;
  /** The ntfy topic URL, or null */
  ntfyUrl: string | null;
  /** Whether ntfy.token_file is set (the token itself is never shown) */
  ntfyTokenFile: boolean;
  /** A daily reminder when action items stay open longer than this; 0 turns it off */
  reminderHours: number;
  /** Any channel is on */
  enabled: boolean;
}

export interface NotificationStatusView {
  settings: NotificationSettingsView;
  /** Why data/server.yaml or its notifications section was refused (notifications are then off) */
  errors: string[];
  /** Whether desktop notifications can be shown here, and how */
  desktopAvailable: { ok: boolean; detail: string };
  /** The last notification sent (a batch, a reminder or a test), with what each channel did */
  last: { at: string; title: string; kind: "batch" | "reminder" | "test"; results: ChannelResult[] } | null;
  /** When the last daily reminder went out */
  lastReminderAt: string | null;
}

/** PUT /api/owner/notifications */
export interface NotificationSettingsUpdate {
  desktop: boolean;
  ntfyUrl: string | null;
  reminderHours?: number;
}
