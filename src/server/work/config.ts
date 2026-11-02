/**
 * The project's `work_store:` block (docs/configuration.md#work-store, docs/design/work-store.md §6):
 *
 *   work_store:
 *     mode: off | observe   # default off
 *
 * off: today's files exactly; no store file is created and every work route answers 404 for the project.
 * observe: the project's store exists and follows the files one way when the owner imports; fill, the planner and
 * the tracker still read the files. `on` (fill reads the store) and `files` come with the PRs that build them.
 */
export type WorkMode = "off" | "observe";

export const WORK_MODES: readonly WorkMode[] = ["off", "observe"];

export interface WorkSettings {
  mode: WorkMode;
}

const KEYS = ["mode"];

const isMode = (value: unknown): value is WorkMode => WORK_MODES.some((mode) => mode === value);

/** The settings, or every reason the block is refused. A missing block is the default (off). */
export function parseWorkStoreConfig(raw: unknown): { ok: true; settings: WorkSettings } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, settings: { mode: "off" } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["work_store must be a mapping"] };
  const block = raw as Record<string, unknown>;
  const errors = Object.keys(block)
    .filter((key) => !KEYS.includes(key))
    .map((key) => `work_store.${key} is not a known key (known: ${KEYS.join(", ")})`);
  const mode = block.mode ?? "off";
  if (!isMode(mode)) errors.push(`work_store.mode must be one of ${WORK_MODES.join(", ")}; got ${JSON.stringify(mode)}`);
  if (errors.length > 0 || !isMode(mode)) return { ok: false, errors };
  return { ok: true, settings: { mode } };
}
