/**
 * Every version of a project file Settings accepted, in
 * data/config-history/<project>/: `<version>.yaml` (the text) and
 * `<version>.json` (when, what, the hash, and who: the owner session's
 * public id, never its value). Both mode 0600; the newest `keep` (50) stay.
 */
import { readdirSync, rmSync } from "fs";
import { join } from "path";
import type { HistoryAction, HistoryVersion } from "../../shared/settings-types.js";
import { isSafeProjectName } from "../config.js";
import { checkDirectory, readProjectFile, sha256, writeFileAtomic } from "./files.js";

export const VERSION_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
const ACTIONS: readonly HistoryAction[] = ["create", "save", "restore", "file"];
const MAX_META_BYTES = 4096;

export interface ConfigHistoryOptions {
  /** data/config-history */
  dir: string;
  /** How the directory is shown in messages */
  shown?: string;
  keep?: number;
  maxBytes: number;
  clock?: { now(): number };
}

function isVersion(value: unknown): value is HistoryVersion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    VERSION_PATTERN.test(v.version) &&
    typeof v.at === "string" &&
    typeof v.hash === "string" &&
    typeof v.bytes === "number" &&
    ACTIONS.includes(v.action as HistoryAction) &&
    (v.by === null || typeof v.by === "string")
  );
}

export class ConfigHistory {
  private readonly keep: number;
  private readonly clock: { now(): number };
  private readonly shown: string;
  private last = 0;

  constructor(private readonly options: ConfigHistoryOptions) {
    this.keep = options.keep ?? 50;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.shown = options.shown ?? "data/config-history";
  }

  private dirOf(project: string, create: boolean): string | null {
    if (!isSafeProjectName(project)) throw new Error(`invalid project name: ${project}`);
    const dir = join(this.options.dir, project);
    try {
      checkDirectory(this.options.dir, this.shown, create);
      checkDirectory(dir, `${this.shown}/${project}`, create);
    } catch (e) {
      if (!create && e instanceof Error && e.message.endsWith("does not exist")) return null;
      throw e;
    }
    return dir;
  }

  /** The kept versions, newest first. */
  list(project: string): HistoryVersion[] {
    const dir = this.dirOf(project, false);
    if (!dir) return [];
    const versions: HistoryVersion[] = [];
    for (const file of readdirSync(dir)) {
      const match = /^(.+)\.json$/.exec(file);
      if (!match || !VERSION_PATTERN.test(match[1])) continue;
      try {
        const meta = JSON.parse(readProjectFile(join(dir, file), file, MAX_META_BYTES) ?? "null") as unknown;
        if (isVersion(meta) && meta.version === match[1]) versions.push(meta);
      } catch {
        // A broken entry is skipped
      }
    }
    return versions.sort((a, b) => b.version.localeCompare(a.version));
  }

  /**
   * A version's record and text, or null when it is not kept. A note (a
   * version found on disk with a secret in it) has a record and no text.
   */
  read(project: string, version: string): { info: HistoryVersion; yaml: string | null } | null {
    if (!VERSION_PATTERN.test(version)) return null;
    const info = this.list(project).find((v) => v.version === version);
    const dir = this.dirOf(project, false);
    if (!info || !dir) return null;
    if (info.redacted) return { info, yaml: null };
    const yaml = readProjectFile(join(dir, `${version}.yaml`), `${version}.yaml`, this.options.maxBytes);
    return yaml === null ? null : { info, yaml };
  }

  private nextVersion(): string {
    // Strictly increasing within this process, so names sort in the order they were made
    const now = Math.max(this.clock.now(), this.last + 1);
    this.last = now;
    const stamp = new Date(now).toISOString().replace(/[-:.]/g, "");
    const random = Math.floor(Math.random() * 0x1000000)
      .toString(16)
      .padStart(6, "0");
    return `${stamp}-${random}`;
  }

  /**
   * Keep `yaml` as a new version; older ones past `keep` are removed. With
   * `yaml` null, only a note is kept (when, what, the hash of the text in
   * `meta.hash`): the text is never written.
   */
  record(
    project: string,
    yaml: string | null,
    meta: { action: HistoryAction; by: string | null; restoredFrom?: string; hash?: string },
  ): HistoryVersion {
    const dir = this.dirOf(project, true)!;
    const version = this.nextVersion();
    const info: HistoryVersion = {
      version,
      at: new Date(this.clock.now()).toISOString(),
      action: meta.action,
      by: meta.by,
      hash: yaml === null ? (meta.hash ?? "") : sha256(yaml),
      bytes: yaml === null ? 0 : Buffer.byteLength(yaml, "utf-8"),
      ...(meta.restoredFrom ? { restoredFrom: meta.restoredFrom } : {}),
      ...(yaml === null ? { redacted: true } : {}),
    };
    if (yaml !== null) writeFileAtomic(join(dir, `${version}.yaml`), yaml, { mode: 0o600 });
    writeFileAtomic(join(dir, `${version}.json`), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    this.prune(dir, project);
    return info;
  }

  private prune(dir: string, project: string): void {
    for (const old of this.list(project).slice(this.keep)) {
      rmSync(join(dir, `${old.version}.json`), { force: true });
      rmSync(join(dir, `${old.version}.yaml`), { force: true });
    }
  }
}
