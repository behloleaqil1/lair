import { describe, expect, it } from "vitest";
import { parseTofuRunnerConfig } from "./config.js";

const VALID = {
  enabled: true,
  apply_role_arn: "arn:aws:iam::123456789012:role/lair-apply",
  external_id: "lair-apply-ext",
  state_bucket: "lair-state-123456789012",
  environments: ["staging"],
  plan_dir: "/var/lib/lair/plans",
};

describe("tofu_runner config", () => {
  it("is off and in observe mode by default", () => {
    expect(parseTofuRunnerConfig(undefined)).toMatchObject({ ok: true, settings: { enabled: false, mode: "observe" } });
    expect(parseTofuRunnerConfig(VALID)).toMatchObject({ ok: true, settings: { enabled: true, mode: "observe", applyTimeoutSeconds: 1800 } });
  });

  it.each([
    ["no apply role", { apply_role_arn: undefined }, "apply_role_arn"],
    ["a role that is not an ARN", { apply_role_arn: "lair-apply" }, "apply_role_arn"],
    ["no external id", { external_id: undefined }, "external_id"],
    ["no bucket", { state_bucket: undefined }, "state_bucket"],
    ["a bucket name with a slash", { state_bucket: "bucket/path" }, "state_bucket"],
    ["no environments", { environments: [] }, "environments"],
    ["an environment with a path in it", { environments: ["../prod"] }, "environments"],
    ["duplicate environments", { environments: ["staging", "staging"] }, "unique"],
    ["no plan directory", { plan_dir: undefined }, "plan_dir"],
    ["a relative plan directory", { plan_dir: "plans" }, "plan_dir"],
    ["a plan directory with ..", { plan_dir: "/var/lib/../etc" }, "plan_dir"],
    ["an unknown mode", { mode: "auto" }, "mode"],
    ["an unknown key", { force: true }, "force"],
    ["an apply timeout over the role's hour", { apply_timeout_seconds: 7200 }, "apply_timeout_seconds"],
  ])("refuses %s", (_name, patch, text) => {
    const out = parseTofuRunnerConfig({ ...VALID, ...patch });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain(text);
  });
});
