/**
 * Answer file (supervisor.chat.answer_file): a supervisor run may answer by
 * writing answer.json instead of running `lair supervisor answer`. The server
 * creates a private per-run folder before the run starts, passes the exact
 * file path in LAIR_ANSWER_FILE and the prompt, and reads only that path,
 * once the run has ended or at the question's deadline.
 *
 * Schema: {answer: string of at most 8 KB, evidence: [{tool, args, note}], at most 20}; nothing else.
 * Validation: a regular file (no symlink) inside the run folder, at most 64 KB, valid JSON of that shape.
 *
 * Every call is async (fs/promises): they run on the chat's check timer and in request paths.
 */
import { constants } from "fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "fs/promises";
import { join } from "path";
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
/** The folder, under a project's agents_dir, that holds the per-run folders */
export const RUN_FOLDERS_DIR = "supervisor-runs";
/** A per-run folder's name: run-<first 8 hex of the turn id>-<16 random hex> */
const RUN_FOLDER_NAME = /^run-[0-9a-f]{8}-[0-9a-f]{16}$/;

export interface AnswerFileContent {
  answer: string;
  evidence: EvidenceItem[];
}

/** ok; or missing (no file: not an error); or invalid, with why */
export type ParseResult =
  | { ok: true; content: AnswerFileContent }
  | { ok: false; missing: boolean; error: string };

const invalid = (error: string): ParseResult => ({ ok: false, missing: false, error });

/**
 * Read and validate an answer.json file.
 * @param path Absolute path to the file
 * @param runDir The run's folder: the file must resolve inside it
 */
export async function readAnswerFile(path: string, runDir: string): Promise<ParseResult> {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true, error: "the file does not exist" };
    return invalid(`cannot read file: ${(e as NodeJS.ErrnoException).code ?? "cannot stat"}`);
  }
  // The file must be inside the run folder (no symlink or path escape)
  const realPath = await safeRealPath(path);
  const realRunDir = await safeRealPath(runDir);
  if (!realRunDir) return invalid("the run directory cannot be verified");
  if (!realPath || !realPath.startsWith(realRunDir + "/")) {
    return invalid("the file is outside the run directory (symlink or path escape)");
  }

  let content: string;
  try {
    content = await readBoundedFileNoFollow(path, MAX_ANSWER_FILE_BYTES);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(`cannot read file: ${redactText(msg, 200)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return invalid("the file is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return invalid("the file must be a JSON object");
  }
  const obj = json as Record<string, unknown>;

  const unknown = Object.keys(obj).find((k) => k !== "answer" && k !== "evidence");
  if (unknown !== undefined) return invalid(`unknown field: ${redactText(unknown, 40)}`);

  const answer = obj.answer;
  if (typeof answer !== "string") return invalid("answer: required, must be a string");
  if (answer.length === 0) return invalid("answer: cannot be empty");
  if (Buffer.byteLength(answer, "utf8") > MAX_ANSWER_TEXT_BYTES) {
    return invalid(`answer: exceeds ${MAX_ANSWER_TEXT_BYTES} bytes`);
  }

  const evidence = obj.evidence;
  if (evidence === undefined) return invalid("evidence: required (use [] if none)");
  if (!Array.isArray(evidence)) return invalid("evidence: must be an array");
  if (evidence.length > MAX_EVIDENCE_ITEMS) return invalid(`evidence: exceeds ${MAX_EVIDENCE_ITEMS} items`);
  const sanitized = sanitizeEvidence(evidence);
  if (!sanitized.ok) return invalid(sanitized.error);

  return { ok: true, content: { answer, evidence: sanitized.evidence } };
}

/**
 * Read a file up to maxBytes without following a symlink (O_NOFOLLOW).
 * Throws if the file is a symlink, not a regular file, over the limit, or cannot be read.
 */
async function readBoundedFileNoFollow(path: string, maxBytes: number): Promise<string> {
  // O_NOFOLLOW is not defined on every platform; then the realpath check above is the guard
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("file does not exist");
    if (code === "ELOOP") throw new Error("file is a symlink (O_NOFOLLOW)");
    throw new Error(code ?? "cannot open");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("not a regular file");
    if (stats.size > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`);
    // One byte past the limit tells a file that grew after the stat
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`);
    return buffer.subarray(0, length).toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function safeRealPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Create a private per-run folder for the run's answer file: mode 0700, an unguessable name,
 * under <agentsDir>/supervisor-runs. Returns its absolute path, or null when it can't be made.
 */
export async function createRunFolder(agentsDir: string, turnId: string): Promise<string | null> {
  const prefix = turnId.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8).padEnd(8, "0");
  const folderPath = join(agentsDir, RUN_FOLDERS_DIR, `run-${prefix}-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(join(agentsDir, RUN_FOLDERS_DIR), { recursive: true, mode: 0o755 });
    await mkdir(folderPath, { mode: 0o700 });
    return folderPath;
  } catch {
    return null;
  }
}

/** The answer file's path in a run folder. */
export function answerFilePath(runFolder: string): string {
  return join(runFolder, "answer.json");
}

/** Where an answer file is moved once taken, so it is never read twice. */
export function takenAnswerFilePath(runFolder: string): string {
  return join(runFolder, "answer.taken.json");
}

/** Read and validate the run folder's answer file, then move it aside so it is never read twice. */
export async function takeAnswerFile(runFolder: string): Promise<ParseResult> {
  const parsed = await readAnswerFile(answerFilePath(runFolder), runFolder);
  if (!parsed.ok) return parsed;
  // The content is in hand: a failed move only means the folder's cleanup removes it
  await rename(answerFilePath(runFolder), takenAnswerFilePath(runFolder)).catch(() => undefined);
  return parsed;
}

/** Remove a run folder and whatever the run left in it (symlinks are removed, never followed). Never throws. */
export async function cleanupRunFolder(runFolder: string): Promise<void> {
  await rm(runFolder, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Remove every per-run folder under <agentsDir>/supervisor-runs: at start, after recover() closed the
 * questions still pending, no folder there belongs to a question that can still be answered. Only
 * directories with a run folder's name are touched. Returns how many were removed; never throws.
 */
export async function sweepRunFolders(agentsDir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(join(agentsDir, RUN_FOLDERS_DIR), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_FOLDER_NAME.test(entry.name)) continue;
    await cleanupRunFolder(join(agentsDir, RUN_FOLDERS_DIR, entry.name));
    removed += 1;
  }
  return removed;
}
