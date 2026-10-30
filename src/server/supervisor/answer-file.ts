/**
 * Answer file: parsing, validation and reading of answer.json files that
 * supervisor runs write. The server creates a per-run folder before spawn,
 * passes the exact answer file path in LAIR_ANSWER_FILE and the prompt,
 * and reads only that path.
 *
 * Schema: {answer: string ≤ 8 KB, evidence: [{tool, args, note}] ≤ 20, confidence?}
 * Validation: a regular file ≤ 64 KB, valid JSON, fields match the schema.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import type { EvidenceItem } from "../../shared/supervisor-types.js";
import { sanitizeEvidence } from "./answers.js";
import { redactText } from "./redact.js";

/** Max file size for answer.json */
export const MAX_ANSWER_FILE_BYTES = 64 * 1024;
/** Max answer text length in bytes (not UTF-16 code units) */
export const MAX_ANSWER_TEXT_BYTES = 8 * 1024;
/** Max evidence items */
export const MAX_EVIDENCE_ITEMS = 20;
/** After taking an answer, wait this long for mtime to stabilise (ms) */
export const MTIME_STABLE_MS = 500;

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

  // Read the file with size limit, O_NOFOLLOW to prevent TOCTOU symlink attacks
  let content: string;
  try {
    content = readBoundedFileNoFollow(path, MAX_ANSWER_FILE_BYTES);
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
  // S2: Use Buffer.byteLength for correct UTF-8 byte counting
  const answerBytes = Buffer.byteLength(answer, "utf8");
  if (answerBytes > MAX_ANSWER_TEXT_BYTES) {
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
 * Read a file up to maxBytes without following symlinks (O_NOFOLLOW).
 * Throws if the file is a symlink, exceeds the limit, or cannot be read.
 */
function readBoundedFileNoFollow(path: string, maxBytes: number): string {
  // O_NOFOLLOW is not available on all platforms; fall back to O_RDONLY when not defined
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("file does not exist");
    if (code === "ELOOP") throw new Error("file is a symlink (O_NOFOLLOW)");
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
 * Create a per-run folder for the supervisor run's answer file.
 * The folder is created with mode 0700 and an unguessable name.
 * @param dataDir The supervisor data directory (e.g., config.agents_dir or a supervisor-runs subdir)
 * @param runId The run's ID
 * @returns The absolute path to the run folder, or null if creation failed
 */
export function createRunFolder(dataDir: string, runId: string): string | null {
  const random = randomBytes(8).toString("hex");
  const folderName = `run-${runId.slice(0, 8)}-${random}`;
  const folderPath = join(dataDir, "supervisor-runs", folderName);
  try {
    mkdirSync(dirname(folderPath), { recursive: true, mode: 0o755 });
    mkdirSync(folderPath, { mode: 0o700 });
    return folderPath;
  } catch {
    return null;
  }
}

/**
 * Get the answer file path for a run folder.
 */
export function answerFilePath(runFolder: string): string {
  return join(runFolder, "answer.json");
}

/**
 * Get the path for a taken answer file (renamed after reading).
 */
export function takenAnswerFilePath(runFolder: string): string {
  return join(runFolder, "answer.taken.json");
}

/**
 * Take an answer file: read it, validate it, and rename it to prevent re-reads.
 * Returns the parsed content if successful, or an error.
 */
export function takeAnswerFile(runFolder: string): ParseResult & { renamed?: boolean } {
  const path = answerFilePath(runFolder);
  const takenPath = takenAnswerFilePath(runFolder);

  const parsed = readAnswerFile(path, runFolder);
  if (!parsed.ok) {
    return parsed;
  }

  // Rename to prevent re-reads
  let renamed = false;
  try {
    renameSync(path, takenPath);
    renamed = true;
  } catch {
    // Rename failed, but we have the content; proceed anyway
  }

  return { ...parsed, renamed };
}

/**
 * Check if an answer file exists and is a regular file.
 */
export function answerFileExists(runFolder: string): boolean {
  const path = answerFilePath(runFolder);
  try {
    const stats = statSync(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Get the mtime of the answer file, or null if it doesn't exist.
 */
export function answerFileMtime(runFolder: string): number | null {
  const path = answerFilePath(runFolder);
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Clean up a run folder: remove the answer files and the folder itself.
 * Best effort; does not throw on failure.
 */
export function cleanupRunFolder(runFolder: string): void {
  try {
    const path = answerFilePath(runFolder);
    const takenPath = takenAnswerFilePath(runFolder);
    try { unlinkSync(path); } catch { /* ignore */ }
    try { unlinkSync(takenPath); } catch { /* ignore */ }
    rmdirSync(runFolder);
  } catch {
    // Best effort cleanup
  }
}
