/**
 * The real boundaries: `docker run` for the isolated process, `aws sts
 * assume-role` for the plan role's credentials. Both use execFile with an
 * argument list (no shell). Neither child inherits Lair's environment: the
 * docker client gets only its own settings (and the credential names the
 * container is to receive), `aws` gets only the AWS settings it needs.
 */
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { PLAIN_ENV_NAMES, type PlanCredentialIssuer, type PlanCredentials, type SandboxResult, type SandboxSpawner, type SandboxSpec } from "./types.js";

/** Slack between the host's timeout (which stops the container) and the in-container one, which is the backstop if Lair dies */
const IN_CONTAINER_GRACE_SECONDS = 10;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The `docker run` arguments for a spec. Fixed settings carry their value
 * (`-e NAME=value`, so nothing is read from the docker client's environment);
 * credentials are passed by name (`-e NAME`) so they are not in the process list.
 * The command runs under `timeout` so a container outlives a dead Lair by seconds, not a whole plan.
 */
export function dockerArgs(spec: SandboxSpec, name: string, user: string): string[] {
  const args = [
    "run", "--rm", "--name", name,
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g",
    "--user", user,
    "--network", spec.egress.network ?? "none",
    "-v", `${spec.workdir}:/work`,
    "-v", `${spec.pluginDir}:/plugins:ro`,
    "-w", "/work",
  ];
  for (const key of Object.keys(spec.env).sort()) args.push("-e", PLAIN_ENV_NAMES.has(key) ? `${key}=${spec.env[key]}` : key);
  const seconds = Math.ceil(spec.timeoutMs / 1000) + IN_CONTAINER_GRACE_SECONDS;
  args.push(spec.image, "timeout", "-s", "KILL", String(seconds), ...spec.argv);
  return args;
}

/** What the docker client itself needs to find its daemon and config: nothing of the container's environment */
const DOCKER_CLIENT_VARS = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];

function pick(from: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const n of names) if (from[n] !== undefined) out[n] = from[n];
  return out;
}

/** The docker client's own environment, taken from the host and nothing else */
export function dockerClientEnv(host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pick(host, DOCKER_CLIENT_VARS);
}

export function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer }, (error, stdout, stderr) => {
      const e = error as { code?: unknown; killed?: boolean } | null;
      // Node also sets `killed` when it stops a child for exceeding maxBuffer: that is an overflow, not a timeout
      const overflow = e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      resolve({
        exitCode: !e ? 0 : typeof e.code === "number" ? e.code : 1,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: Boolean(e?.killed) && !overflow,
        outputOverflow: overflow,
      });
    });
  });
}

export interface DockerSpawnerOptions {
  /** The docker executable (default `docker`) */
  docker?: string;
  /** Output kept per run before the process is stopped */
  maxBuffer?: number;
  /** Where the client's own settings come from (default Lair's environment) */
  hostEnv?: NodeJS.ProcessEnv;
}

export class DockerSpawner implements SandboxSpawner {
  private readonly docker: string;
  private readonly maxBuffer: number;
  private readonly hostEnv: NodeJS.ProcessEnv;

  constructor(options: DockerSpawnerOptions = {}) {
    this.docker = options.docker ?? "docker";
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.hostEnv = options.hostEnv ?? process.env;
  }

  async run(spec: SandboxSpec): Promise<SandboxResult> {
    const name = `lair-plan-${randomBytes(6).toString("hex")}`;
    const user = `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`;
    const client = dockerClientEnv(this.hostEnv);
    // Values the container is to get by name come from the spec, never from the host: only credentials are by name
    const byName: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(spec.env)) if (!PLAIN_ENV_NAMES.has(k)) byName[k] = v;
    const result = await run(this.docker, dockerArgs(spec, name, user), { ...client, ...byName }, spec.timeoutMs, this.maxBuffer);
    // Stopping the client does not stop the container: remove it by its exact name
    if (result.timedOut || result.outputOverflow) await run(this.docker, ["kill", name], client, 15_000, 1024 * 1024);
    return result;
  }
}

/** The settings `aws` needs to find its own configuration; Lair's other variables are not passed to it */
function awsCliEnv(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = Object.keys(host).filter((n) => n.startsWith("AWS_") || n === "PATH" || n === "HOME");
  return pick(host, names);
}

export interface AwsCliIssuerOptions {
  /** The aws executable (default `aws`) */
  aws?: string;
  hostEnv?: NodeJS.ProcessEnv;
}

export class AwsCliIssuer implements PlanCredentialIssuer {
  private readonly aws: string;
  private readonly hostEnv: NodeJS.ProcessEnv;

  constructor(options: AwsCliIssuerOptions = {}) {
    this.aws = options.aws ?? "aws";
    this.hostEnv = options.hostEnv ?? process.env;
  }

  async issue(req: { roleArn: string; externalId?: string; sessionName: string; seconds: number; region: string }): Promise<PlanCredentials> {
    const args = [
      "sts", "assume-role", "--output", "json", "--region", req.region,
      "--role-arn", req.roleArn, "--role-session-name", req.sessionName, "--duration-seconds", String(req.seconds),
    ];
    if (req.externalId) args.push("--external-id", req.externalId);
    const result = await run(this.aws, args, awsCliEnv(this.hostEnv), 30_000, 1024 * 1024);
    if (result.exitCode !== 0) throw new Error("could not assume the plan role");
    try {
      const c = JSON.parse(result.stdout).Credentials;
      const expiresAt = new Date(c.Expiration).toISOString();
      if (![c.AccessKeyId, c.SecretAccessKey, c.SessionToken].every((v) => typeof v === "string" && v.length > 0)) throw new Error("incomplete");
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiresAt };
    } catch {
      throw new Error("could not read the plan role's credentials");
    }
  }
}
