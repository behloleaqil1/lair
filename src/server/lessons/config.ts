/**
 * The `lessons:` block of a project config, validated with defaults applied.
 * See docs/configuration.md (once this module is documented).
 *
 * lessons:
 *   enabled: true      # Whether lessons are loaded and matched
 */
import { z } from "zod";

export const LessonsSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

export type LessonsSettings = z.infer<typeof LessonsSchema>;

export type ParseResult = { ok: true; settings: LessonsSettings } | { ok: false; errors: string[] };

/**
 * Parse a project's `lessons:` block (absent: every default).
 */
export function parseLessonsConfig(raw: unknown): ParseResult {
  const parsed = LessonsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `lessons.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  return { ok: true, settings: parsed.data };
}

/**
 * Every default (a project without the block).
 */
export function defaultLessonsSettings(): LessonsSettings {
  const parsed = parseLessonsConfig(undefined);
  if (!parsed.ok) throw new Error("the lessons defaults are invalid");
  return parsed.settings;
}
