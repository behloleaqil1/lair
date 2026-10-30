/**
 * The trainer runs in a container, so the Python toolchain stays off the host.
 * The image is built beforehand from brain-trainer/ (pinned dependencies); a
 * run never pulls, has no network, a read-only root, no capabilities, and sees
 * one directory: the input rows in, the model out.
 */
import { randomBytes } from "crypto";
import { dockerClientEnv, run } from "../plan-sandbox/spawners.js";

export interface ContainerSpec {
  image: string;
  /** Host directory mounted at /work: holds input.json, receives model.json and fit.json */
  workdir: string;
  timeoutMs: number;
}

export interface ContainerResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

/** The boundary tests fake. */
export interface TrainerContainer {
  run(spec: ContainerSpec): Promise<ContainerResult>;
}

const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64})?(@sha256:[0-9a-f]{64})?$/;

export function validImage(image: string): boolean {
  return IMAGE.test(image);
}

/** The `docker run` arguments. Fixed: nothing in them comes from decision data. */
export function trainerDockerArgs(spec: ContainerSpec, name: string, user: string): string[] {
  return [
    "run", "--rm", "--name", name,
    "--pull", "never",
    "--network", "none",
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g",
    "--user", user,
    "-v", `${spec.workdir}:/work`,
    "-w", "/work",
    spec.image,
    "/work/input.json", "/work/model.json", "/work/fit.json",
  ];
}

export class DockerTrainerContainer implements TrainerContainer {
  constructor(
    private readonly docker = "docker",
    private readonly hostEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(spec: ContainerSpec): Promise<ContainerResult> {
    if (!validImage(spec.image)) throw new Error("the trainer image name is not valid");
    const name = `lair-brain-trainer-${randomBytes(6).toString("hex")}`;
    const user = `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`;
    const env = dockerClientEnv(this.hostEnv);
    const result = await run(this.docker, trainerDockerArgs(spec, name, user), env, spec.timeoutMs, 1024 * 1024);
    // Stopping the client does not stop the container: remove it by its exact name
    if (result.timedOut || result.outputOverflow) await run(this.docker, ["kill", name], env, 15_000, 1024 * 1024);
    return { exitCode: result.exitCode, stderr: result.stderr.slice(-2000), timedOut: result.timedOut };
  }
}
