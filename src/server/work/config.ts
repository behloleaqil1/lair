/**
 * The project's `work_store:` block (docs/configuration.md#work-store, docs/design/work-store.md §6):
 *
 *   work_store:
 *     mode: off | observe   # default off
 *     files: follow         # default follow
 *
 * off: today's files exactly; no store file is created; the status says off, and every other work route answers 404.
 * observe: the project's store exists and follows the files one way: on the owner's import, and once the owner applied
 * one, by itself (`files: follow`: bus reports and run facts at once, the files when they change). Fill, the planner
 * and the tracker still read the files. `on` (fill reads the store), `files: mirror` and `none` come with the PRs that
 * build them.
 */
export type WorkMode = "off" | "observe";
export type WorkFiles = "follow";

export const WORK_MODES: readonly WorkMode[] = ["off", "observe"];
export const WORK_FILES: readonly WorkFiles[] = ["follow"];

export interface WorkSettings {
  mode: WorkMode;
  files: WorkFiles;
}

const KEYS = ["mode", "files"];

const isMode = (value: unknown): value is WorkMode => WORK_MODES.some((mode) => mode === value);
const isFiles = (value: unknown): value is WorkFiles => WORK_FILES.some((files) => files === value);

/** The settings, or every reason the block is refused. A missing block is the default (off). */
export function parseWorkStoreConfig(raw: unknown): { ok: true; settings: WorkSettings } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, settings: { mode: "off", files: "follow" } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["work_store must be a mapping"] };
  const block = raw as Record<string, unknown>;
  const errors = Object.keys(block)
    .filter((key) => !KEYS.includes(key))
    .map((key) => `work_store.${key} is not a known key (known: ${KEYS.join(", ")})`);
  const mode = block.mode ?? "off";
  const files = block.files ?? "follow";
  if (!isMode(mode)) errors.push(`work_store.mode must be one of ${WORK_MODES.join(", ")}; got ${JSON.stringify(mode)}`);
  if (!isFiles(files)) errors.push(`work_store.files must be ${WORK_FILES.join(", ")} (mirror and none come with a later version); got ${JSON.stringify(files)}`);
  if (errors.length > 0 || !isMode(mode) || !isFiles(files)) return { ok: false, errors };
  return { ok: true, settings: { mode, files } };
}
