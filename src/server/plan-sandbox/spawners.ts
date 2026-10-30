/**
 * The real boundaries: `docker run` for the isolated process, `aws sts
 * assume-role` for the plan role's credentials. Both use execFile with an
 * argument list (no shell), and neither puts a credential in an argument.
 */
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import type { PlanCredentialIssuer, PlanCredentials, SandboxResult, SandboxSpawner, SandboxSpec } from "./types.js";

/** The `docker run` arguments for a spec; environment values are never among them (`-e NAME` reads the client's environment) */
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
  for (const key of Object.keys(spec.env).sort()) args.push("-e", key);
  args.push(spec.image, ...spec.argv);
  return args;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer }, (error, stdout, stderr) => {
      const e = error as { code?: unknown; killed?: boolean } | null;
      resolve({
        exitCode: !e ? 0 : typeof e.code === "number" ? e.code : 1,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: Boolean(e?.killed),
      });
    });
  });
}

export class DockerSpawner implements SandboxSpawner {
  async run(spec: SandboxSpec): Promise<SandboxResult> {
    const name = `lair-plan-${randomBytes(6).toString("hex")}`;
    const user = `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`;
    // The client needs its own PATH and daemon address; only the names in spec.env reach the container
    const clientEnv: NodeJS.ProcessEnv = { ...spec.env, PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST };
    const result = await run("docker", dockerArgs(spec, name, user), clientEnv, spec.timeoutMs, 8 * 1024 * 1024);
    if (result.timedOut) await run("docker", ["kill", name], { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST }, 15_000, 1024 * 1024);
    return result;
  }
}

export class AwsCliIssuer implements PlanCredentialIssuer {
  async issue(req: { roleArn: string; externalId?: string; sessionName: string; seconds: number; region: string }): Promise<PlanCredentials> {
    const args = [
      "sts", "assume-role", "--output", "json", "--region", req.region,
      "--role-arn", req.roleArn, "--role-session-name", req.sessionName, "--duration-seconds", String(req.seconds),
    ];
    if (req.externalId) args.push("--external-id", req.externalId);
    const result = await run("aws", args, process.env, 30_000, 1024 * 1024);
    if (result.exitCode !== 0) throw new Error("could not assume the plan role");
    try {
      const c = JSON.parse(result.stdout).Credentials;
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiresAt: new Date(c.Expiration).toISOString() };
    } catch {
      throw new Error("could not read the plan role's credentials");
    }
  }
}
