/**
 * Answer file: parsing, validation and watching for answer.json files that
 * supervisor runs write. The file path: any working directory the run can
 * write to (agents.session_dir, $TMPDIR, or the repository if allowed).
 *
 * Schema: {answer: string ≤ 8 KB, evidence: [{tool, args, note}] ≤ 20, confidence?}
 * Validation: a regular file ≤ 64 KB, valid JSON, fields match the schema.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, watch, type FSWatcher } from "fs";
import { dirname, join, resolve } from "path";
import type { EvidenceItem } from "../../shared/supervisor-types.js";
import { sanitizeEvidence } from "./answers.js";
import { redactText } from "./redact.js";

/** Max file size for answer.json */
export const MAX_ANSWER_FILE_BYTES = 64 * 1024;
/** Max answer text length */
export const MAX_ANSWER_TEXT_BYTES = 8 * 1024;
/** Max evidence items */
export const MAX_EVIDENCE_ITEMS = 20;
/** Debounce delay for file watching (ms) */
export const WATCH_DEBOUNCE_MS = 500;

export interface AnswerFileContent {
  answer: string;
  evidence: EvidenceItem[];
  confidence?: string;
}

export type ParseResult =
  | { ok: true; content: AnswerFileContent }
  | { ok: false; error: string };

/**
 * Read and parse an answer.json file with validation.
 * @param path Absolute path to the file
 * @param runDir The run's directory - the file must be inside it or in a subdirectory
 */
export function readAnswerFile(path: string, runDir: string | null): ParseResult {
  // Security: the file must be inside the run directory (no symlink escapes)
  if (runDir !== null) {
    const realPath = safeRealPath(path);
    if (!realPath) {
      return { ok: false, error: "the file cannot be read or does not exist" };
    }
    const realRunDir = safeRealPath(runDir);
    if (!realRunDir) {
      return { ok: false, error: "the run directory cannot be verified" };
    }
    if (!realPath.startsWith(realRunDir + "/") && realPath !== realRunDir) {
      return { ok: false, error: "the file is outside the run directory (symlink or path escape)" };
    }
  }

  // Read the file with size limit
  let content: string;
  try {
    content = readBoundedFile(path, MAX_ANSWER_FILE_BYTES);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `cannot read file: ${redactText(msg, 200)}` };
  }

  // Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: "the file is not valid JSON" };
  }

  // Validate shape
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "the file must be a JSON object" };
  }

  const obj = json as Record<string, unknown>;

  // Validate answer field
  const answer = obj.answer;
  if (typeof answer !== "string") {
    return { ok: false, error: "answer: required, must be a string" };
  }
  if (answer.length === 0) {
    return { ok: false, error: "answer: cannot be empty" };
  }
  if (answer.length > MAX_ANSWER_TEXT_BYTES) {
    return { ok: false, error: `answer: exceeds ${MAX_ANSWER_TEXT_BYTES} bytes` };
  }

  // Validate evidence field
  const evidence = obj.evidence;
  if (evidence === undefined) {
    return { ok: false, error: "evidence: required (use [] if none)" };
  }
  if (!Array.isArray(evidence)) {
    return { ok: false, error: "evidence: must be an array" };
  }
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, error: `evidence: exceeds ${MAX_EVIDENCE_ITEMS} items` };
  }

  // Use the existing sanitizeEvidence function for detailed validation
  const sanitized = sanitizeEvidence(evidence);
  if (!sanitized.ok) {
    return { ok: false, error: sanitized.error };
  }

  // Optional confidence field
  const confidence = obj.confidence;
  if (confidence !== undefined && typeof confidence !== "string") {
    return { ok: false, error: "confidence: must be a string if provided" };
  }

  // Check for unknown fields
  const knownFields = ["answer", "evidence", "confidence"];
  const unknown = Object.keys(obj).find((k) => !knownFields.includes(k));
  if (unknown) {
    return { ok: false, error: `unknown field: ${redactText(unknown, 40)}` };
  }

  return {
    ok: true,
    content: {
      answer,
      evidence: sanitized.evidence,
      confidence: typeof confidence === "string" ? confidence : undefined,
    },
  };
}

/**
 * Read a file up to maxBytes, throwing if it exceeds the limit or cannot be read.
 */
function readBoundedFile(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("file does not exist");
    throw new Error(code ?? "cannot open");
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("not a regular file");
    if (stats.size > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve a path to its real path (following symlinks), or null if it fails.
 */
function safeRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Check if an answer.json file exists and is a regular file.
 */
export function answerFileExists(dir: string): string | null {
  const path = join(dir, "answer.json");
  try {
    const stats = statSync(path);
    return stats.isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Derive the answer file path from a run's log path.
 * The answer file goes in the same directory as the log file.
 */
export function answerFilePathFromLog(logPath: string | undefined): string | null {
  if (!logPath) return null;
  return join(dirname(logPath), "answer.json");
}

/**
 * Get the run directory from a log path.
 */
export function runDirFromLog(logPath: string | undefined): string | null {
  if (!logPath) return null;
  return dirname(logPath);
}

export interface AnswerFileWatcher {
  /** Start watching for the answer file in the given directory */
  watch(dir: string, onAnswer: (path: string) => void): void;
  /** Stop watching all directories */
  stop(): void;
}

/**
 * Create a watcher that monitors directories for answer.json files.
 * Uses debouncing to handle multiple rapid file events.
 */
export function createAnswerFileWatcher(): AnswerFileWatcher {
  const watchers = new Map<string, FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  return {
    watch(dir: string, onAnswer: (path: string) => void): void {
      if (stopped) return;
      if (watchers.has(dir)) return; // Already watching

      try {
        const watcher = watch(dir, (event, filename) => {
          if (stopped) return;
          if (filename !== "answer.json") return;
          if (event !== "rename" && event !== "change") return;

          // Debounce: wait for writes to complete
          const existing = timers.get(dir);
          if (existing) clearTimeout(existing);

          timers.set(
            dir,
            setTimeout(() => {
              timers.delete(dir);
              if (stopped) return;
              const path = join(dir, "answer.json");
              try {
                const stats = statSync(path);
                if (stats.isFile()) {
                  onAnswer(path);
                }
              } catch {
                // File doesn't exist yet or was deleted
              }
            }, WATCH_DEBOUNCE_MS),
          );
        });
        watchers.set(dir, watcher);
      } catch {
        // Directory doesn't exist or can't be watched
      }
    },

    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
