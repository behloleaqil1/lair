/**
 * Startup sweep after a crash: a Lair that died mid-plan leaves a code copy in
 * the temp directory and possibly a container that runs until its in-container
 * timeout. Both are named `lair-plan-*`; this removes what is left. It assumes
 * one Lair per machine, which is how it is installed.
 */
import { lstat, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dockerClientEnv, run } from "./spawners.js";

const DIR_NAME = /^lair-plan-[A-Za-z0-9]{6}$/;
const CONTAINER_NAME = /^lair-plan-[0-9a-f]{12}$/;

export interface SweepOptions {
  tmpDir?: string;
  docker?: string;
  hostEnv?: NodeJS.ProcessEnv;
}

export async function sweepLeftovers(options: SweepOptions = {}): Promise<{ dirs: number; containers: number }> {
  const dir = options.tmpDir ?? tmpdir();
  let dirs = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!DIR_NAME.test(name)) continue;
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory()) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    dirs++;
  }
  const docker = options.docker ?? "docker";
  const env = dockerClientEnv(options.hostEnv ?? process.env);
  let containers = 0;
  const listed = await run(docker, ["ps", "-a", "--filter", "name=lair-plan-", "--format", "{{.Names}}"], env, 15_000, 1024 * 1024);
  if (listed.exitCode === 0) {
    for (const name of listed.stdout.split("\n").map((l) => l.trim()).filter((l) => CONTAINER_NAME.test(l))) {
      const removed = await run(docker, ["rm", "-f", name], env, 15_000, 1024 * 1024);
      if (removed.exitCode === 0) containers++;
    }
  }
  return { dirs, containers };
}
