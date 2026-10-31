/**
 * A private copy of an infrastructure root, taken before the scan, and the
 * hash that ties the copy to what the scan read (the time-of-check/time-of-use
 * note in docs/design/deploy-aws.md §2.1). The copy leaves out what must not
 * reach a plan: state files, `.env` files, `.git` and `.terraform`. A symlink
 * or a special file is refused, never followed.
 */
import { createHash } from "crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const MAX_FILES = 2000;
const MAX_BYTES = 32 * 1024 * 1024;
const SKIP_DIR = new Set([".git", ".terraform"]);

function skipped(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || /\.tfstate(\.|$)/.test(name);
}

export class SnapshotRefused extends Error {}

/** Hash of the root's files (paths and contents), copying them into `dest` when given. */
export async function snapshotRoot(root: string, dest?: string): Promise<string> {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  async function walk(rel: string): Promise<void> {
    const entries = (await readdir(join(root, rel))).sort();
    if (dest) await mkdir(join(dest, rel), { recursive: true });
    for (const name of entries) {
      const path = join(rel, name);
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        if (!SKIP_DIR.has(name)) await walk(path);
      } else if (info.isFile()) {
        if (skipped(name)) continue;
        if (++files > MAX_FILES) throw new SnapshotRefused("too many files");
        bytes += info.size;
        if (bytes > MAX_BYTES) throw new SnapshotRefused("too much data");
        const content = await readFile(join(root, path));
        hash.update(`${path}\0${content.length}\0`).update(content);
        if (dest) await writeFile(join(dest, path), content, { mode: 0o600 });
      } else {
        throw new SnapshotRefused(`not a regular file: ${path}`);
      }
    }
  }
  await walk("");
  return hash.digest("hex");
}
