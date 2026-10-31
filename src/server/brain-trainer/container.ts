/**
 * The trainer runs in a container, so the Python toolchain stays off the host.
 * The image is built beforehand from brain-trainer/ (base image pinned by
 * digest, dependencies by hash) and named by content in the config; a run
 * never pulls, has no network, a read-only root, no capabilities, never runs
 * as root, and sees two directories: the input rows (read-only) and a
 * separate one that receives the model.
 */
import { randomBytes } from "crypto";
import { dockerClientEnv, run as runProcess } from "../plan-sandbox/spawners.js";
import type { SandboxResult } from "../plan-sandbox/types.js";

export interface ContainerSpec {
  image: string;
  /** Host directory mounted read-only at /in: holds input.json */
  inputDir: string;
  /** Host directory mounted read-write at /out: receives model.json and fit.json */
  outputDir: string;
  timeoutMs: number;
}

export interface ContainerResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  /** The container could not be stopped after a timeout or overflow: it may still be running */
  cleanupFailed?: boolean;
}

/** The boundary tests fake. */
export interface TrainerContainer {
  run(spec: ContainerSpec): Promise<ContainerResult>;
}

/** The runner of `docker ...` the real container uses; tests pass a fake. */
export type ProcessRunner = (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number) => Promise<SandboxResult>;

// A local image is named by content: `sha256:<image id>` (what `docker build -q` prints) or `repo@sha256:<digest>`.
// A bare tag is mutable, so it is not accepted.
const IMAGE = /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,64})?@sha256:[0-9a-f]{64})$/;

export function validImage(image: string): boolean {
  return IMAGE.test(image);
}

const NON_ROOT_USER = /^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/;

/** `uid:gid` of the container's user. Refuses root (or an unknown id): the model is untrusted code's output, so the container is never uid 0. */
export function trainerUser(uid: number | undefined, gid: number | undefined): string {
  const user = `${uid}:${gid}`;
  if (uid === undefined || gid === undefined || !NON_ROOT_USER.test(user)) {
    throw new Error("refusing to start the trainer container as root: run Lair as a non-root user");
  }
  return user;
}

// Host paths go into `--mount key=value,...`: a comma, quote or control character would add a mount option
const MOUNT_PATH = /^[A-Za-z0-9._/@+=~ -]+$/;

function mount(source: string, target: string, readonly: boolean): string {
  if (!MOUNT_PATH.test(source) || source.includes("..")) throw new Error("the trainer's work directory has characters a mount cannot carry");
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

/** The deadline inside the container, a little under the host's, so the container ends itself first. */
export function deadlineSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs / 1000) - 10);
}

/** The `docker run` arguments. Fixed: nothing in them comes from decision data. */
export function trainerDockerArgs(spec: ContainerSpec, name: string, user: string): string[] {
  if (!NON_ROOT_USER.test(user)) throw new Error("refusing to start the trainer container as root: run Lair as a non-root user");
  return [
    "run", "--rm", "--name", name,
    "--pull", "never",
    "--network", "none",
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--user", user,
    "--mount", mount(spec.inputDir, "/in", true),
    "--mount", mount(spec.outputDir, "/out", false),
    "-w", "/out",
    spec.image,
    "/in/input.json", "/out/model.json", "/out/fit.json", String(deadlineSeconds(spec.timeoutMs)),
  ];
}

export interface DockerContainerOptions {
  docker?: string;
  hostEnv?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  /** The ids the container runs as (default: the server's own) */
  ids?: () => { uid: number | undefined; gid: number | undefined };
}

export class DockerTrainerContainer implements TrainerContainer {
  private readonly docker: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly runner: ProcessRunner;
  private readonly ids: () => { uid: number | undefined; gid: number | undefined };

  constructor(options: DockerContainerOptions = {}) {
    this.docker = options.docker ?? "docker";
    this.hostEnv = options.hostEnv ?? process.env;
    this.runner = options.runner ?? runProcess;
    this.ids = options.ids ?? (() => ({ uid: process.getuid?.(), gid: process.getgid?.() }));
  }

  async run(spec: ContainerSpec): Promise<ContainerResult> {
    if (!validImage(spec.image)) throw new Error("the trainer image must be named by content (sha256:<id> or name@sha256:<digest>)");
    const { uid, gid } = this.ids();
    const user = trainerUser(uid, gid);
    const name = `lair-brain-trainer-${randomBytes(6).toString("hex")}`;
    const env = dockerClientEnv(this.hostEnv);
    const result = await this.runner(this.docker, trainerDockerArgs(spec, name, user), env, spec.timeoutMs, 1024 * 1024);
    // Stopping the client does not stop the container: stop it by its exact name, and check that it stopped
    let cleanupFailed = false;
    if (result.timedOut || result.outputOverflow) cleanupFailed = !(await this.stop(name, env));
    return { exitCode: result.exitCode, stderr: result.stderr.slice(-2000), timedOut: result.timedOut, ...(cleanupFailed ? { cleanupFailed } : {}) };
  }

  /** True when the container is gone: killed, force-removed, or already not there. */
  private async stop(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const kill = await this.runner(this.docker, ["kill", name], env, 15_000, 1024 * 1024);
    if (kill.exitCode === 0 && !kill.timedOut) return true;
    const rm = await this.runner(this.docker, ["rm", "-f", name], env, 15_000, 1024 * 1024);
    if (rm.exitCode === 0 && !rm.timedOut) return true;
    return !rm.timedOut && /no such container/i.test(rm.stderr);
  }
}
