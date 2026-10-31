/**
 * The brain trainer (docs/design/decision-policies.md §5-§6, stage C): a
 * nightly classifier trained in a container on the answered decisions,
 * scored on the brain bench with a time split, versioned, and run in shadow
 * mode only. Off unless data/server.yaml sets `brain_trainer.enabled`.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { ServerConfigFileOptions } from "../restart/server-config.js";
import { DockerTrainerContainer, type TrainerContainer } from "./container.js";
import { registerBrainTrainerRoutes } from "./routes.js";
import { BrainTrainer, type Timers } from "./service.js";
import type { DecisionReader } from "./shadow.js";

export { BrainTrainer } from "./service.js";
export { BRAIN_TRAINER_OFF, parseBrainTrainerConfig } from "./config.js";

export interface MountBrainTrainerOptions {
  /** data/server.yaml */
  configPath: string;
  /** data/brain */
  dataDir: string;
  /** The trainer wraps it in a get/list-only object, so it never holds the means to answer */
  decisions: DecisionReader;
  events: EventBus;
  humanAuth: HumanAuth;
  container?: TrainerContainer;
  clock?: () => Date;
  timers?: Timers;
  fileOptions?: ServerConfigFileOptions;
  log?: (line: string) => void;
}

export async function mountBrainTrainer(fastify: FastifyInstance, options: MountBrainTrainerOptions): Promise<BrainTrainer> {
  const trainer = new BrainTrainer({ ...options, container: options.container ?? new DockerTrainerContainer() });
  // (BrainTrainer reads decisions only through readOnlyDecisions: an object with get and list and nothing else)
  await registerBrainTrainerRoutes(fastify, options.humanAuth, trainer);
  const unsubscribe = trainer.subscribe();
  trainer.start();
  fastify.addHook("onClose", async () => {
    unsubscribe();
    trainer.stop();
  });
  return trainer;
}
