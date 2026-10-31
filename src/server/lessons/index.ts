/**
 * The lessons module (docs/design/autonomy.md §8).
 *
 * Lessons are what Lair learns from incidents and operational experience:
 * - A signal (how to detect the situation)
 * - A cause (what causes it)
 * - A response (what to do when it happens)
 * - Prevention (how to prevent it)
 *
 * Built-in lessons (L1-L28) ship with Lair. Project lessons are proposed
 * by incidents and approved by the owner.
 *
 * This is PR 1 of the C8 epic (knowledge and learning loop):
 * - The lessons store and built-in lessons
 * - Read API + a Knowledge view in the dashboard
 * - Owner-only writes: approve, retire, edit
 *
 * PR 2 adds: incident -> lesson (automatic proposals)
 * PR 3 adds: lessons in judgment (supervisor cites lessons)
 */
import type { FastifyInstance } from "fastify";
import type { HumanAuth } from "../human-auth/index.js";
import { LessonsStore } from "./store.js";
import { loadBuiltinLessons } from "./builtin-lessons.js";
import { registerLessonsRoutes } from "./routes.js";
import { defaultLessonsSettings, type LessonsSettings } from "./config.js";

export { LessonsStore } from "./store.js";
export { BUILTIN_LESSONS, loadBuiltinLessons } from "./builtin-lessons.js";
export { parseLessonsConfig, defaultLessonsSettings, LessonsSchema } from "./config.js";
export type { LessonsSettings } from "./config.js";

export interface MountLessonsOptions {
  /** data/lessons.db in the server; ":memory:" in tests */
  dbPath: string;
  humanAuth: HumanAuth;
  defaultProject(): string;
  /** Get a project's lessons settings */
  settings?: (project: string) => LessonsSettings;
  projectsDir?: string;
  clock?: () => number;
}

export interface LessonsModule {
  store: LessonsStore;
  /** The number of built-in lessons loaded on start (0 if already present) */
  builtInLoaded: number;
}

export async function mountLessons(fastify: FastifyInstance, options: MountLessonsOptions): Promise<LessonsModule> {
  const clock = options.clock ?? Date.now;
  const store = new LessonsStore(options.dbPath);

  // Load built-in lessons (insert missing, update outdated content)
  const builtInLoaded = loadBuiltinLessons(store, clock);

  const settings = options.settings ?? (() => defaultLessonsSettings());

  await registerLessonsRoutes(fastify, {
    store,
    auth: options.humanAuth,
    settings,
    defaultProject: options.defaultProject,
    projectsDir: options.projectsDir,
    clock,
  });

  fastify.addHook("onClose", async () => {
    store.close();
  });

  return { store, builtInLoaded };
}

/**
 * Mount the lessons module only when a project turned it on (`lessons.enabled:
 * true`). Off (the default): no database file is created, nothing is seeded
 * and no /api/lessons route exists.
 */
export async function mountLessonsWhenEnabled(
  fastify: FastifyInstance,
  options: MountLessonsOptions & { enabled: boolean },
): Promise<LessonsModule | null> {
  if (!options.enabled) return null;
  return mountLessons(fastify, options);
}
