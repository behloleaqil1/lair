import { describe, expect, it } from "vitest";
import { dockerArgs } from "./spawners.js";
import type { SandboxSpec } from "./types.js";

const spec: SandboxSpec = {
  image: "plan-runner:1",
  argv: ["tofu", "plan"],
  workdir: "/tmp/lair-plan-x/code",
  pluginDir: "/srv/mirror",
  env: { AWS_SECRET_ACCESS_KEY: "do-not-print", AWS_REGION: "us-east-1" },
  egress: { hosts: ["registry.opentofu.org"] },
  timeoutMs: 1000,
};

describe("dockerArgs", () => {
  it("runs a read-only, capability-free container with no network unless one is given", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(args.slice(-3)).toEqual(["plan-runner:1", "tofu", "plan"]);
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

  it("passes environment names, never values, so no credential is in the process list", () => {
    const args = dockerArgs(spec, "lair-plan-1", "1000:1000");
    expect(args).toEqual(expect.arrayContaining(["-e", "AWS_SECRET_ACCESS_KEY"]));
    expect(args.join(" ")).not.toContain("do-not-print");
  });
});
