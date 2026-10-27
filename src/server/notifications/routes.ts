/**
 * Notification settings, for the owner only (src/server/human-auth/;
 * /api/owner is an OWNER_ONLY prefix, so no CORS is granted for them):
 *
 *   GET  /api/owner/notifications        NotificationStatusView: the settings, why the file was refused,
 *                                        whether desktop notifications work here, the last send's results
 *   PUT  /api/owner/notifications        {desktop, ntfyUrl, reminderHours?}: writes only the notifications
 *                                        section of data/server.yaml (ntfy.token_file stays in the file only)
 *   POST /api/owner/notifications/test   {}: "Lair: test notification" through every channel on, with what
 *                                        each did (409 while notifications are off)
 *
 * No response carries the ntfy token or a decision's context.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { ServerConfigFileOptions } from "../restart/server-config.js";
import { MAX_REMINDER_HOURS } from "./config.js";
import type { Notifier } from "./notifier.js";
import { saveNotificationSettings } from "./settings-file.js";

const UpdateBody = z
  .object({
    desktop: z.boolean(),
    ntfyUrl: z.string().trim().max(2000).nullable(),
    reminderHours: z.number().int().min(0).max(MAX_REMINDER_HOURS).optional(),
  })
  .strict();

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

export interface NotificationRoutesOptions {
  notifier: Notifier;
  configPath: string;
  fileOptions?: ServerConfigFileOptions;
}

export async function registerNotificationRoutes(
  fastify: FastifyInstance,
  auth: HumanAuth,
  options: NotificationRoutesOptions,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = auth.requireOwner("Only a browser signed in as the owner can see and change notifications");

    app.get("/api/owner/notifications", { onRequest: owner }, async (_request, reply) => {
      return reply.header("cache-control", "no-store").send(respond(options.notifier.status()));
    });

    app.put("/api/owner/notifications", { onRequest: owner, bodyLimit: 4096 }, async (request, reply) => {
      const body = UpdateBody.safeParse(request.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        return fail(reply, 400, `Invalid settings: ${issue.path.join(".") || "(body)"}: ${issue.message}`);
      }
      const ntfyUrl = body.data.ntfyUrl === null || body.data.ntfyUrl === "" ? null : body.data.ntfyUrl;
      const saved = saveNotificationSettings(
        options.configPath,
        { desktop: body.data.desktop, ntfyUrl, reminderHours: body.data.reminderHours },
        options.fileOptions,
      );
      if (!saved.ok) return fail(reply, saved.code, saved.error);
      return reply.header("cache-control", "no-store").send(respond(options.notifier.status()));
    });

    app.post("/api/owner/notifications/test", { onRequest: owner, bodyLimit: 1024 }, async (_request, reply) => {
      const sent = await options.notifier.sendTest();
      if (!sent.ok) return fail(reply, 409, sent.error);
      return reply.header("cache-control", "no-store").send(respond({ results: sent.results }));
    });
  });
}
