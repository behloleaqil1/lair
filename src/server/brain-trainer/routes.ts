/**
 * Owner-only routes (/api/owner is an OWNER_ONLY prefix):
 *
 *   GET  /api/owner/brain-trainer       status: runs over time, the model that shadows, shadow agreement per class
 *   POST /api/owner/brain-trainer/run   {}: start a run now in the background (409 while off or already running)
 *
 * Neither route answers or changes a decision, and none promotes a model.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { BrainTrainer } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

export async function registerBrainTrainerRoutes(fastify: FastifyInstance, auth: HumanAuth, trainer: BrainTrainer): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = auth.requireOwner("Only a browser signed in as the owner can see and start the brain trainer");

    app.get("/api/owner/brain-trainer", { onRequest: owner }, async (_request, reply) => {
      return reply.header("cache-control", "no-store").send(respond(trainer.status()));
    });

    app.post("/api/owner/brain-trainer/run", { onRequest: owner, bodyLimit: 1024 }, async (_request, reply) => {
      const status = trainer.status();
      if (!status.enabled) return fail(reply, 409, "The brain trainer is off: set brain_trainer.enabled in data/server.yaml");
      if (status.running) return fail(reply, 409, "A run is already going");
      void trainer.runNow();
      return reply.code(202).send(respond({ started: true }));
    });
  });
}
