/**
 * Mount the notifier on a Fastify server: its owner-only routes, the bus
 * subscription (decision.raised: a new action item), and the reminder's
 * timer, stopped with fastify.close(). src/server/index.ts calls this, and
 * the tests call the same function with a fake runner, fetch and clock.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { ServerConfigFileOptions } from "../restart/server-config.js";
import { ExecFileRunner, type CommandRunner } from "../watchdog/probes.js";
import { loadNotificationConfig } from "./config.js";
import { Notifier, type NotifierInbox, type Timers } from "./notifier.js";
import { registerNotificationRoutes } from "./routes.js";
import { desktopAvailability, sendersFor, type FetchLike } from "./senders.js";

export interface MountNotificationsOptions {
  /** data/server.yaml */
  configPath: string;
  /** data/notifications-state.json: when the last daily reminder went out */
  statePath: string;
  events: EventBus;
  inbox: NotifierInbox;
  humanAuth: HumanAuth;
  /** The dashboard's address (dashboardUrlFor(HOST, PORT)) */
  dashboardUrl: string;
  clock?: { now(): number };
  timers?: Timers;
  runner?: CommandRunner;
  fetch?: FetchLike;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** server.yaml and token file checks (tests pass another uid) */
  fileOptions?: ServerConfigFileOptions;
  log?: (line: string) => void;
}

export async function mountNotifications(fastify: FastifyInstance, options: MountNotificationsOptions): Promise<Notifier> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileOptions: ServerConfigFileOptions = { platform, ...options.fileOptions };
  const environment = {
    runner: options.runner ?? new ExecFileRunner(10_000),
    fetch: options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
    platform,
    env,
    fileOptions,
  };
  const notifier = new Notifier({
    settings: () => loadNotificationConfig(options.configPath, fileOptions),
    senders: (settings) => sendersFor(settings, environment),
    inbox: options.inbox,
    dashboardUrl: options.dashboardUrl,
    statePath: options.statePath,
    desktopAvailability: () => desktopAvailability({ platform, env }),
    clock: options.clock,
    timers: options.timers,
    log: options.log,
  });
  await registerNotificationRoutes(fastify, options.humanAuth, { notifier, configPath: options.configPath, fileOptions });
  const unsubscribe = options.events.on("decision.raised", (event) => notifier.onRaised(event.data));
  notifier.start();
  fastify.addHook("onClose", async () => {
    unsubscribe();
    await notifier.stop();
  });
  return notifier;
}
