/**
 * The real boundary code: DockerSpawner.run, AwsCliIssuer and the sweep run
 * against stub executables (shell scripts that record how they were called and
 * what environment they got), so argv, environment, timeouts and parsing are
 * the production code's. Docker and the AWS CLI themselves are the fakes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AwsCliIssuer, DockerSpawner, dockerArgs } from "./spawners.js";
import { sweepLeftovers } from "./sweep.js";
import type { SandboxSpec } from "./types.js";

const spec: SandboxSpec = {
  image: "plan-runner:1",
  argv: ["tofu", "plan"],
  workdir: "/tmp/lair-plan-x/code",
  pluginDir: "/srv/mirror",
  env: { AWS_SECRET_ACCESS_KEY: "do-not-print", AWS_REGION: "us-east-1", PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
  egress: { hosts: ["registry.opentofu.org"] },
  timeoutMs: 1000,
};

describe("dockerArgs", () => {
  it("runs a read-only, capability-free container with no network unless one is given", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
  });

  it("runs the command under an in-container timeout a few seconds past the host's", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args.slice(-7)).toEqual(["plan-runner:1", "timeout", "-s", "KILL", "11", "tofu", "plan"]);
  });

  it("mounts the mirror read-only and the copy as the working directory", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args).toContain("/srv/mirror:/plugins:ro");
    expect(args).toContain("/tmp/lair-plan-x/code:/work");
  });

  it("uses the configured egress network", () => {
    const args = dockerArgs({ ...spec, egress: { hosts: [], network: "plan-egress" } }, "n", "1:1");
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "plan-egress"]);
  });

  it("passes credentials by name only, so none is in the process list, and fixed settings with their values", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args).toEqual(expect.arrayContaining(["-e", "AWS_SECRET_ACCESS_KEY", "-e", "AWS_REGION=us-east-1", "-e", "PATH=/usr/local/bin:/usr/bin:/bin", "-e", "HOME=/tmp"]));
    expect(args).not.toContain("PATH");
    expect(args.join(" ")).not.toContain("do-not-print");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-sandbox-stub-"));
  dirs.push(dir);
  return dir;
}

/** A `docker` that records its arguments and environment, then behaves as the `mode` file says */
function dockerStub(dir: string): string {
  const path = join(dir, "docker");
  writeFileSync(
    path,
    `#!/bin/sh
out="$(dirname "$0")"
case "$1" in
  kill) echo "$2" >> "$out/kills"; exit 0 ;;
  rm) echo "$3" >> "$out/removed"; exit 0 ;;
  ps) cat "$out/ps.txt" 2>/dev/null; exit 0 ;;
esac
printf '%s\\n' "$@" > "$out/args"
env > "$out/env"
case "$(cat "$out/mode" 2>/dev/null)" in
  sleep) exec sleep 30 ;;
  flood) exec yes x ;;
  fail) echo boom >&2; exit 3 ;;
  *) echo planned ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const read = (dir: string, name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf-8") : "");
const hostEnv = { PATH: "/usr/bin:/bin", HOME: "/home/user", DOCKER_HOST: "unix:///run/docker.sock", LAIR_SECRET_TOKEN: "control-plane-token", DATABASE_URL: "postgres://u:p@db/app" };
const runSpec: SandboxSpec = { ...spec, timeoutMs: 5000 };

describe("DockerSpawner.run", () => {
  it("runs docker with an explicit environment: nothing of the host's reaches the container, nor the client beyond its own settings", async () => {
    const dir = stubDir();
    const result = await new DockerSpawner({ docker: dockerStub(dir), hostEnv }).run(runSpec);
    expect(result).toMatchObject({ exitCode: 0, stdout: "planned\n", timedOut: false, outputOverflow: false });
    const args = read(dir, "args").split("\n");
    // the container's PATH and HOME are the fixed values, not the host's
    expect(args).toEqual(expect.arrayContaining(["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "AWS_REGION=us-east-1", "AWS_SECRET_ACCESS_KEY"]));
    expect(args).not.toContain("PATH");
    expect(args).not.toContain("HOME");
    const argv = args.join(" ");
    for (const host of ["control-plane-token", "postgres://", "unix:///run/docker.sock", "/home/user", "do-not-print"]) expect(argv).not.toContain(host);
    // the docker client gets its own settings and the credential by name, and no other host variable
    const env = read(dir, "env");
    expect(env).toContain("PATH=/usr/bin:/bin");
    expect(env).toContain("HOME=/home/user");
    expect(env).toContain("DOCKER_HOST=unix:///run/docker.sock");
    expect(env).toContain("AWS_SECRET_ACCESS_KEY=do-not-print");
    expect(env).not.toContain("control-plane-token");
    expect(env).not.toContain("DATABASE_URL");
    expect(env).not.toContain("AWS_REGION");
  });

  it("reports a non-zero exit with its output", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "mode"), "fail");
    expect(await new DockerSpawner({ docker: dockerStub(dir), hostEnv }).run(runSpec)).toMatchObject({ exitCode: 3, stderr: "boom\n", timedOut: false });
    expect(read(dir, "kills")).toBe("");
  });

  it("kills a run that outlives its timeout, by the exact container name", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "mode"), "sleep");
    const result = await new DockerSpawner({ docker: dockerStub(dir), hostEnv }).run({ ...runSpec, timeoutMs: 300 });
    expect(result).toMatchObject({ timedOut: true, outputOverflow: false });
    const args = read(dir, "args").split("\n");
    const name = args[args.indexOf("--name") + 1]!;
    expect(name).toMatch(/^lair-plan-[0-9a-f]{12}$/);
    expect(read(dir, "kills")).toBe(`${name}\n`);
  });

  it("reports output past the buffer as an overflow, not a timeout, and still kills the container", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "mode"), "flood");
    const result = await new DockerSpawner({ docker: dockerStub(dir), hostEnv, maxBuffer: 2000 }).run(runSpec);
    expect(result).toMatchObject({ outputOverflow: true, timedOut: false });
    const args = read(dir, "args").split("\n");
    expect(read(dir, "kills")).toBe(`${args[args.indexOf("--name") + 1]}\n`);
  });
});

const STS = JSON.stringify({
  Credentials: { AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "secret-example", SessionToken: "token-example", Expiration: "2026-10-30T12:15:00+00:00" },
});

function awsStub(dir: string): string {
  const path = join(dir, "aws");
  writeFileSync(
    path,
    `#!/bin/sh
out="$(dirname "$0")"
printf '%s\\n' "$@" > "$out/args"
env > "$out/env"
case "$(cat "$out/mode" 2>/dev/null)" in
  fail) echo "AccessDenied" >&2; exit 255 ;;
  junk) echo "not json" ;;
  *) cat "$out/sts.json" ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("AwsCliIssuer", () => {
  const req = { roleArn: "arn:aws:iam::123456789012:role/lair-plan", externalId: "lair-ext-1", sessionName: "lair-plan-example", seconds: 900, region: "us-east-1" };
  const awsHost = { ...hostEnv, AWS_PROFILE: "lair", AWS_CONFIG_FILE: "/home/user/.aws/config" };

  it("assumes the role with the exact arguments and parses the credentials", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "sts.json"), STS);
    const creds = await new AwsCliIssuer({ aws: awsStub(dir), hostEnv: awsHost }).issue(req);
    expect(creds).toEqual({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret-example", sessionToken: "token-example", expiresAt: "2026-10-30T12:15:00.000Z" });
    expect(read(dir, "args").trim().split("\n")).toEqual([
      "sts", "assume-role", "--output", "json", "--region", "us-east-1",
      "--role-arn", req.roleArn, "--role-session-name", "lair-plan-example", "--duration-seconds", "900", "--external-id", "lair-ext-1",
    ]);
  });

  it("gives aws its own settings and PATH and HOME, and none of Lair's other variables", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "sts.json"), STS);
    await new AwsCliIssuer({ aws: awsStub(dir), hostEnv: awsHost }).issue(req);
    const env = read(dir, "env");
    expect(env).toContain("AWS_PROFILE=lair");
    expect(env).toContain("AWS_CONFIG_FILE=/home/user/.aws/config");
    expect(env).toContain("PATH=/usr/bin:/bin");
    expect(env).not.toContain("LAIR_SECRET_TOKEN");
    expect(env).not.toContain("DATABASE_URL");
  });

  it("fails without credentials when aws exits non-zero, and does not echo its error", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "mode"), "fail");
    await expect(new AwsCliIssuer({ aws: awsStub(dir), hostEnv: awsHost }).issue(req)).rejects.toThrow("could not assume the plan role");
  });

  it.each([["not json", "junk"], ["json without credentials", "{}"], ["credentials with an empty token", JSON.stringify({ Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "", Expiration: "2026-10-30T12:15:00Z" } })]])(
    "refuses an answer it cannot read: %s",
    async (_name, body) => {
      const dir = stubDir();
      if (body === "junk") writeFileSync(join(dir, "mode"), "junk");
      else writeFileSync(join(dir, "sts.json"), body);
      await expect(new AwsCliIssuer({ aws: awsStub(dir), hostEnv: awsHost }).issue(req)).rejects.toThrow("could not read the plan role's credentials");
    },
  );

  it("leaves out the external id when none is given", async () => {
    const dir = stubDir();
    writeFileSync(join(dir, "sts.json"), STS);
    await new AwsCliIssuer({ aws: awsStub(dir), hostEnv: awsHost }).issue({ ...req, externalId: undefined });
    expect(read(dir, "args")).not.toContain("--external-id");
  });
});

describe("sweepLeftovers", () => {
  it("removes leftover plan copies and containers, and nothing else", async () => {
    const dir = stubDir();
    const tmp = join(dir, "tmp");
    mkdirSync(join(tmp, "lair-plan-abc123", "code"), { recursive: true });
    mkdirSync(join(tmp, "lair-plan-Zz9Y8x"));
    mkdirSync(join(tmp, "other-dir"));
    mkdirSync(join(tmp, "lair-plan-notarandomsuffix"));
    writeFileSync(join(tmp, "lair-plan-file12"), "a file, not a copy");
    writeFileSync(join(dir, "ps.txt"), "lair-plan-0123456789ab\nsomeone-elses\nlair-plan-fedcba987654\nlair-plan-x\n");
    const swept = await sweepLeftovers({ tmpDir: tmp, docker: dockerStub(dir), hostEnv });
    expect(swept).toEqual({ dirs: 2, containers: 2 });
    expect(existsSync(join(tmp, "lair-plan-abc123"))).toBe(false);
    expect(existsSync(join(tmp, "lair-plan-Zz9Y8x"))).toBe(false);
    for (const kept of ["other-dir", "lair-plan-notarandomsuffix", "lair-plan-file12"]) expect(existsSync(join(tmp, kept))).toBe(true);
    expect(read(dir, "removed")).toBe("lair-plan-0123456789ab\nlair-plan-fedcba987654\n");
  });

  it("still sweeps the directories when docker is not there", async () => {
    const dir = stubDir();
    mkdirSync(join(dir, "lair-plan-abc123"));
    expect(await sweepLeftovers({ tmpDir: dir, docker: join(dir, "no-such-docker"), hostEnv })).toEqual({ dirs: 1, containers: 0 });
  });
});
