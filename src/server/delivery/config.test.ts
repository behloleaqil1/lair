/**
 * The `delivery:` block: defaults, start order, and the errors that keep a
 * project's delivery from loading.
 */
import { describe, expect, it } from "vitest";
import { parseDeliveryConfig, pathMatches } from "./config.js";

const env = (extra: Record<string, unknown> = {}) => ({
  compose_files: ["./deploy/compose.yaml"],
  project_name: "shop-local",
  services: {
    db: null,
    api: { health: { type: "http", url: "http://localhost:8080/health" }, build: true, paths: ["api/"] },
    web: { build: true },
  },
  ...extra,
});

function errorsOf(raw: unknown): string[] {
  const parsed = parseDeliveryConfig(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseDeliveryConfig", () => {
  it("is off without a delivery block", () => {
    const parsed = parseDeliveryConfig(undefined);
    expect(parsed).toMatchObject({ ok: true, settings: { enabled: false, environments: [] } });
  });

  it("applies defaults and keeps the services in start order", () => {
    const parsed = parseDeliveryConfig({
      enabled: true,
      environments: { local: env({ start_order: ["db", "web"] }) },
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const s = parsed.settings;
    expect(s).toMatchObject({
      enabled: true,
      intervalSeconds: 30,
      dockerCmd: ["docker"],
      commandTimeoutSeconds: 300,
      buildTimeoutSeconds: 1800,
    });
    const local = s.environments[0];
    expect(local).toMatchObject({
      name: "local",
      composeFiles: ["./deploy/compose.yaml"],
      projectName: "shop-local",
      startTimeoutSeconds: 120,
      crashLoop: { maxRestarts: 3, windowMinutes: 10 },
      deploy: { auto: false, ref: "main", healthTimeoutMinutes: 5 },
    });
    // start_order first, then the rest in map order
    expect(local.services.map((x) => x.name)).toEqual(["db", "web", "api"]);
    expect(local.services[0]).toEqual({ name: "db", health: { type: "container" }, build: false, paths: [] });
    expect(local.services[2]).toEqual({
      name: "api",
      health: { type: "http", url: "http://localhost:8080/health", expectStatus: undefined, timeoutSeconds: 5 },
      build: true,
      paths: ["api/"],
    });
  });

  it("reads several compose files, a project directory and the deploy settings", () => {
    const parsed = parseDeliveryConfig({
      enabled: true,
      environments: {
        local: env({
          compose_files: ["compose.yaml", "compose.override.yaml"],
          project_directory: "/home/user/shop",
          deploy: {
            auto: true,
            ref: "release/next",
            prepare_cmd: ["git", "-C", "/home/user/shop", "merge", "--ff-only", "{sha}"],
            health_timeout_minutes: 2,
          },
        }),
      },
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.environments[0]).toMatchObject({
      composeFiles: ["compose.yaml", "compose.override.yaml"],
      projectDirectory: "/home/user/shop",
      deploy: { auto: true, ref: "release/next", healthTimeoutMinutes: 2 },
    });
  });

  it("refuses unknown keys, unsafe names and values that would read as options", () => {
    expect(errorsOf({ enabled: true, environments: { local: env({ bogus: 1 }) } })[0]).toContain("bogus");
    expect(errorsOf({ enabled: true, environments: { local: env({ project_name: "Shop Local" }) } })[0]).toContain(
      "delivery.environments.local.project_name",
    );
    expect(
      errorsOf({ enabled: true, environments: { local: env({ compose_files: ["--file=other.yaml"] }) } })[0],
    ).toContain("must not start with '-'");
    expect(errorsOf({ enabled: true, environments: { "../x": env() } })[0]).toContain("environment names");
    expect(
      errorsOf({ enabled: true, environments: { local: env({ services: { "-rm": null } }) } }).join("; "),
    ).toContain("service names");
    expect(errorsOf({ enabled: true, environments: { local: env({ deploy: { ref: "--upload-pack=x" } }) } })[0]).toContain(
      "delivery.environments.local.deploy.ref",
    );
  });

  it("checks start order, paths, auto deploy, prepare_cmd placeholders and health URLs", () => {
    const errors = errorsOf({
      enabled: true,
      environments: {
        local: env({
          start_order: ["db", "cache", "db"],
          services: {
            db: { paths: ["db/"] },
            web: { health: { type: "http", url: "ftp://localhost/health" } },
          },
          deploy: { auto: true, prepare_cmd: ["./bin/update", "{branch}"] },
        }),
      },
    });
    expect(errors).toEqual([
      "delivery.environments.local.services.db.paths: only a service with build: true is deployed",
      "delivery.environments.local.services.web.health.url: must be an http:// or https:// URL",
      "delivery.environments.local.start_order: cache is not in services",
      "delivery.environments.local.start_order: db is listed twice",
      "delivery.environments.local.deploy.auto is true but no service has build: true and paths",
      "delivery.environments.local.deploy.prepare_cmd: unknown placeholder {branch} (allowed: {sha}, {ref}, {environment}, {project})",
    ]);
  });

  it("refuses two environments on one compose project, and enabled without environments", () => {
    expect(
      errorsOf({ enabled: true, environments: { local: env(), staging: env() } }),
    ).toEqual(["delivery.environments.staging.project_name: shop-local is also used by local"]);
    expect(errorsOf({ enabled: true })).toEqual([
      "delivery.environments: enabled is true but no environment is configured",
    ]);
  });
});

describe("pathMatches", () => {
  it("matches a directory or a file, not a name that only starts the same", () => {
    expect(pathMatches("api/", "api/src/orders.ts")).toBe(true);
    expect(pathMatches("./api", "api/src/orders.ts")).toBe(true);
    expect(pathMatches("api", "api-docs/readme.md")).toBe(false);
    expect(pathMatches("shared/money.ts", "shared/money.ts")).toBe(true);
    expect(pathMatches(".", "anything/at/all")).toBe(true);
  });
});
