import { describe, expect, it } from "vitest";
import { parseInfraPolicyConfig } from "./config.js";

describe("parseInfraPolicyConfig", () => {
  it("is off with nothing allowed when the block is missing", () => {
    const r = parseInfraPolicyConfig(undefined);
    expect(r).toEqual({
      ok: true,
      settings: { enabled: false, roots: [], allowedProviders: [], allowedModules: [], allow: [] },
    });
  });

  it("reads every key", () => {
    const r = parseInfraPolicyConfig({
      enabled: true,
      roots: ["/srv/infra"],
      allowed_providers: ["hashicorp/aws"],
      allowed_modules: ["terraform-aws-modules/vpc/aws"],
      allow: ["data.http.health"],
    });
    expect(r).toMatchObject({ ok: true, settings: { enabled: true, allowedProviders: ["hashicorp/aws"], allow: ["data.http.health"] } });
  });

  it("refuses unknown keys, relative roots, and enabled without roots", () => {
    expect(parseInfraPolicyConfig({ enabled: true, roots: ["/a"], typo: 1 })).toMatchObject({ ok: false });
    expect(parseInfraPolicyConfig({ roots: ["infra"] })).toEqual({
      ok: false,
      errors: ["infra_policy.roots[0]: must be an absolute path"],
    });
    expect(parseInfraPolicyConfig({ enabled: true })).toEqual({
      ok: false,
      errors: ["infra_policy: enabled is true but no roots are configured"],
    });
  });
});
