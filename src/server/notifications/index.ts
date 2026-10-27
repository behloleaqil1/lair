/**
 * Notifications (docs/configuration.md#notifications): opt-in desktop and
 * phone (ntfy) notifications when a decision needs the owner, batched, with
 * a daily reminder. Configured in Lair's own data/server.yaml; mounted by
 * src/server/index.ts with mountNotifications().
 */
export { mountNotifications } from "./mount.js";
export type { MountNotificationsOptions } from "./mount.js";
export { Notifier, BATCH_MS, DAY_MS, GATHER_MS, REMINDER_CHECK_MS, realTimers } from "./notifier.js";
export type { NotifierInbox, NotifierOptions, Timers } from "./notifier.js";
export { loadNotificationConfig, parseNotificationConfig, readNtfyToken, NOTIFICATIONS_OFF } from "./config.js";
export type { NotificationSettings } from "./config.js";
export { DesktopSender, NtfySender, OSASCRIPT_SOURCE, desktopCommand, plainText, sendersFor } from "./senders.js";
export { registerNotificationRoutes } from "./routes.js";
export { saveNotificationSettings } from "./settings-file.js";
