import { describe, expect, it } from "vitest";
import { parseInfraPolicyConfig } from "./config.js";

const HASH = "a".repeat(64);

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
      allowed_providers: ["hashicorp/aws", "registry.example.com/org/thing"],
      allowed_modules: ["terraform-aws-modules/vpc/aws", "git::https://example.com/org/", "https://example.com/org/mods/"],
      allow: [{ root: "/srv/infra", address: "data.http.health", hash: HASH }],
    });
    expect(r).toMatchObject({
      ok: true,
      settings: { enabled: true, allowedProviders: ["hashicorp/aws", "registry.example.com/org/thing"], allow: [{ address: "data.http.health", hash: HASH }] },
    });
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

  it("refuses allowed_providers entries that are not a provider source", () => {
    for (const bad of ["/", "hashicorp", "hashicorp/", "git::https://", "a b/c", ""]) {
      expect(parseInfraPolicyConfig({ enabled: true, roots: ["/a"], allowed_providers: [bad] }), bad).toMatchObject({ ok: false });
    }
  });

  it("refuses allowed_modules entries that would allow a whole host or scheme", () => {
    for (const bad of ["/", "git::https://", "https://github.com/", "git::https://github.com/", "github.com/", "example.com", "./local", "../up", "/abs/path", "a/../b/", "a b/c/d"]) {
      expect(parseInfraPolicyConfig({ enabled: true, roots: ["/a"], allowed_modules: [bad] }), bad).toMatchObject({ ok: false });
    }
  });

  it("refuses an allow entry without a hash, with a short hash, or for a root that is not configured", () => {
    const base = { enabled: true, roots: ["/a"] };
    expect(parseInfraPolicyConfig({ ...base, allow: ["data.http.health"] })).toMatchObject({ ok: false });
    expect(parseInfraPolicyConfig({ ...base, allow: [{ root: "/a", address: "x.y" }] })).toMatchObject({ ok: false });
    expect(parseInfraPolicyConfig({ ...base, allow: [{ root: "/a", address: "x.y", hash: "abc" }] })).toMatchObject({ ok: false });
    expect(parseInfraPolicyConfig({ ...base, allow: [{ root: "/b", address: "x.y", hash: HASH }] })).toEqual({
      ok: false,
      errors: ["infra_policy.allow[0].root: must be one of roots"],
    });
  });
});
