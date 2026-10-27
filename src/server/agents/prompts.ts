/**
 * The prompt files in a project's prompts_dir, for the Agents view's "Load a
 * prompt" select (GET /api/agents/prompts and /api/agents/prompts/file?name=,
 * owner only, see routes.ts).
 *
 * Only basenames leave this module, never a path. A name is one plain file
 * name: letters, digits, '.', '_' and '-', starting with a letter or digit,
 * with no "..", so it can't name a separator, a parent or a hidden file. An
 * entry is listed and read only when it is a regular file directly in the
 * directory, or a symlink to one there: agents write to prompts_dir, so a
 * symlink one plants to a file elsewhere (a key, a token) is never read into
 * the owner's browser and from there into another agent's prompt. A file is
 * opened without following a final symlink and without blocking on a FIFO,
 * checked again on the open descriptor, and read up to MAX_PROMPT_FILE_BYTES,
 * the size of a run's prompt (so a loaded file always fits a run request).
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "fs";
import { dirname, join } from "path";
import type { PromptFileText, PromptFileView } from "../../shared/agents-types.js";

/** The most a prompt file may hold: a run's prompt is at most this many characters */
export const MAX_PROMPT_FILE_BYTES = 200_000;
/** The most files a listing returns, newest first */
export const MAX_PROMPT_FILES_LISTED = 200;
/** The most directory entries a listing looks at */
const MAX_ENTRIES_SCANNED = 2000;
/** 255 characters: a file name's usual limit, and room for Lair's own <task>-<agent>-<run>.txt */
const PROMPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** A refused or failed prompt file request, with the HTTP status the routes answer with. */
export class PromptFileError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PromptFileError";
  }
}

export const PROMPT_NAME_RULE =
  "one file name of 1-255 letters, digits, '.', '_' or '-', starting with a letter or digit, with no '..'";

/** True for a name that can only mean a file directly in prompts_dir (see PROMPT_NAME_RULE). */
export function isValidPromptName(name: unknown): name is string {
  return typeof name === "string" && PROMPT_NAME.test(name) && !name.includes("..");
}

/** The directory's real path, or null when it doesn't exist or isn't a directory. */
function realDirectory(dir: string): string | null {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The regular file `name` stands for in `real` (the directory's real path):
 * the entry itself, or the target of a symlink whose real path is directly in
 * the directory. Anything else is refused.
 */
function resolveEntry(real: string, name: string): { path: string; stats: Stats } {
  const path = join(real, name);
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch {
    throw new PromptFileError(404, `No prompt file ${name} in prompts_dir`);
  }
  if (entry.isSymbolicLink()) {
    let target: string;
    try {
      target = realpathSync(path);
    } catch {
      throw new PromptFileError(404, `Prompt file ${name} is a link to nothing`);
    }
    // Never say where it points: the target is outside what the owner asked for
    if (dirname(target) !== real) throw new PromptFileError(403, `${name} links to a file outside prompts_dir: refused`);
    let stats: Stats;
    try {
      stats = lstatSync(target);
    } catch {
      throw new PromptFileError(404, `Prompt file ${name} is a link to nothing`);
    }
    if (!stats.isFile()) throw new PromptFileError(403, `${name} is not a regular file: refused`);
    return { path: target, stats };
  }
  if (!entry.isFile()) throw new PromptFileError(403, `${name} is not a regular file: refused`);
  return { path, stats: entry };
}

/** The regular files in `dir` (prompts_dir), newest first: names, sizes and times, no paths. */
export function listPromptFiles(dir: string): PromptFileView[] {
  const real = realDirectory(dir);
  if (!real) return [];
  const files: PromptFileView[] = [];
  const handle = opendirSync(real);
  try {
    for (let scanned = 0; scanned < MAX_ENTRIES_SCANNED; scanned++) {
      const entry = handle.readSync();
      if (!entry) break;
      if (!isValidPromptName(entry.name)) continue;
      try {
        const { stats } = resolveEntry(real, entry.name);
        files.push({
          name: entry.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          tooLarge: stats.size > MAX_PROMPT_FILE_BYTES,
        });
      } catch {
        // Not a regular file of this directory: not offered
      }
    }
  } finally {
    handle.closeSync();
  }
  return files
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name))
    .slice(0, MAX_PROMPT_FILES_LISTED);
}

/** One prompt file's text, by its basename in `dir` (prompts_dir). */
export function readPromptFile(dir: string, name: string): PromptFileText {
  if (!isValidPromptName(name)) throw new PromptFileError(400, `Invalid prompt file name: ${PROMPT_NAME_RULE}`);
  const real = realDirectory(dir);
  if (!real) throw new PromptFileError(404, "prompts_dir does not exist yet");
  const { path } = resolveEntry(real, name);
  let fd: number;
  try {
    // O_NOFOLLOW: a link swapped in after the check isn't followed; O_NONBLOCK: a FIFO can't hang the server
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new PromptFileError(403, `${name} could not be opened as a regular file: refused`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new PromptFileError(403, `${name} is not a regular file: refused`);
    const tooLarge = () =>
      new PromptFileError(413, `${name} is larger than ${MAX_PROMPT_FILE_BYTES} bytes, the most a run's prompt may hold`);
    if (stats.size > MAX_PROMPT_FILE_BYTES) throw tooLarge();
    // One byte more than the cap: a file that grew while being read is refused too
    const buffer = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_PROMPT_FILE_BYTES) throw tooLarge();
    return { name, size: length, text: buffer.subarray(0, length).toString("utf-8") };
  } finally {
    closeSync(fd);
  }
}
