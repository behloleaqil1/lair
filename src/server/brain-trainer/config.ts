/**
 * The `brain_trainer:` section of data/server.yaml, Lair's own config (never
 * a project's YAML). Read again at every use, through the same file checks as
 * the rest of server.yaml. Off when the section is missing or refused.
 *
 *   brain_trainer:
 *     enabled: true
 *     image: lair-brain-trainer:1     # built from brain-trainer/ beforehand; never pulled
 *     run_hour: 3                     # local hour of the nightly run
 *     min_labels: 100                 # fewer usable labels: the run only reports
 *     test_fraction: 0.2              # newest share held out for the bench
 *     confidence_floor: 0.7           # below it a proposal is an abstain
 *     shadow: true                    # the best model writes proposals into the trace
 *     cases_file: /abs/path/cases.jsonl   # optional extra labelled cases (bench format, with "at")
 */
import { isAbsolute } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readCheckedFile, type ServerConfigFileOptions } from "../restart/server-config.js";
import { validImage } from "./container.js";

export interface BrainTrainerSettings {
  enabled: boolean;
  image: string;
  runHour: number;
  minLabels: number;
  testFraction: number;
  minTest: number;
  confidenceFloor: number;
  timeoutMinutes: number;
  shadow: boolean;
  casesFile: string | null;
}

export const BRAIN_TRAINER_OFF: BrainTrainerSettings = {
  enabled: false,
  image: "lair-brain-trainer:1",
  runHour: 3,
  minLabels: 100,
  testFraction: 0.2,
  minTest: 10,
  confidenceFloor: 0.7,
  timeoutMinutes: 15,
  shadow: true,
  casesFile: null,
};

export type BrainTrainerConfigResult =
  | { ok: true; settings: BrainTrainerSettings }
  | { ok: false; errors: string[]; settings: BrainTrainerSettings };

const Schema = z
  .object({
    enabled: z.boolean().default(false),
    image: z.string().max(300).refine(validImage, "must be an image name such as lair-brain-trainer:1").default(BRAIN_TRAINER_OFF.image),
    run_hour: z.number().int().min(0).max(23).default(BRAIN_TRAINER_OFF.runHour),
    min_labels: z.number().int().min(20).max(100_000).default(BRAIN_TRAINER_OFF.minLabels),
    test_fraction: z.number().min(0.05).max(0.5).default(BRAIN_TRAINER_OFF.testFraction),
    min_test: z.number().int().min(1).max(10_000).default(BRAIN_TRAINER_OFF.minTest),
    confidence_floor: z.number().min(0).max(1).default(BRAIN_TRAINER_OFF.confidenceFloor),
    timeout_minutes: z.number().int().min(1).max(240).default(BRAIN_TRAINER_OFF.timeoutMinutes),
    shadow: z.boolean().default(true),
    cases_file: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => isAbsolute(p) && !p.split("/").includes(".."), "must be a plain absolute path")
      .optional(),
  })
  .strict();

export function parseBrainTrainerConfig(raw: unknown): BrainTrainerConfigResult {
  const section = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).brain_trainer : undefined;
  if (section === undefined || section === null) return { ok: true, settings: BRAIN_TRAINER_OFF };
  const parsed = Schema.safeParse(section);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `brain_trainer.${i.path.join(".") || "(section)"}: ${i.message}`),
      settings: BRAIN_TRAINER_OFF,
    };
  }
  const v = parsed.data;
  return {
    ok: true,
    settings: {
      enabled: v.enabled,
      image: v.image,
      runHour: v.run_hour,
      minLabels: v.min_labels,
      testFraction: v.test_fraction,
      minTest: v.min_test,
      confidenceFloor: v.confidence_floor,
      timeoutMinutes: v.timeout_minutes,
      shadow: v.shadow,
      casesFile: v.cases_file ?? null,
    },
  };
}

/** Read and parse the section from data/server.yaml. A refused file is off, with the reason. */
export function loadBrainTrainerConfig(configPath: string, options: ServerConfigFileOptions = {}): BrainTrainerConfigResult {
  const read = readCheckedFile(configPath, options);
  if (!read.ok) return { ok: false, errors: [`data/server.yaml ${read.error}`], settings: BRAIN_TRAINER_OFF };
  if (read.text === null) return { ok: true, settings: BRAIN_TRAINER_OFF };
  let raw: unknown;
  try {
    raw = parseYaml(read.text);
  } catch (e) {
    return { ok: false, errors: [`data/server.yaml: ${e instanceof Error ? e.message : String(e)}`], settings: BRAIN_TRAINER_OFF };
  }
  return parseBrainTrainerConfig(raw);
}
