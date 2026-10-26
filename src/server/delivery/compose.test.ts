/**
 * Parsers for docker compose and docker inspect output. The fixtures copy the
 * real formats (Docker 28, Compose 2.39) field for field, with invented
 * names and ids.
 */
import { describe, expect, it } from "vitest";
import {
  composeBase,
  errorLines,
  imageRepository,
  parseComposePs,
  parseInspect,
} from "./compose.js";
import type { EnvironmentSettings } from "./config.js";

const ID_API = "3f2a9c1b7d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcd";
const ID_DB = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d";
const IMAGE = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

/** One `docker compose ps --all --format json` line, as Compose 2.21+ prints it */
function psLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    Command: '"docker-entrypoint.…"',
    CreatedAt: "2026-03-01 09:00:00 +0000 UTC",
    ExitCode: 0,
    Health: "",
    ID: ID_API.slice(0, 12),
    Image: "shop-local-api",
    Labels: "com.docker.compose.project=shop-local,com.docker.compose.service=api,com.docker.compose.oneoff=False",
    LocalVolumes: "0",
    Mounts: "",
    Name: "shop-local-api-1",
    Names: "shop-local-api-1",
    Networks: "shop-local_default",
    Ports: "localhost:8080->8080/tcp",
    Project: "shop-local",
    Publishers: [{ URL: "localhost", TargetPort: 8080, PublishedPort: 8080, Protocol: "tcp" }],
    RunningFor: "2 hours ago",
    Service: "api",
    Size: "0B",
    State: "running",
    Status: "Up 2 hours (healthy)",
    ...fields,
  });
}

describe("parseComposePs", () => {
  it("reads one object per line (Compose 2.21 and later)", () => {
    const out = [
      psLine({ Health: "healthy" }),
      psLine({
        ID: ID_DB.slice(0, 12),
        Image: "postgres:16",
        Name: "shop-local-db-1",
        Names: "shop-local-db-1",
        Service: "db",
        State: "exited",
        ExitCode: 143,
        Status: "Exited (143) 5 hours ago",
      }),
      "",
    ].join("\n");
    expect(parseComposePs(out)).toEqual([
      {
        service: "api",
        name: "shop-local-api-1",
        id: ID_API.slice(0, 12),
        state: "running",
        health: "healthy",
        exitCode: 0,
        status: "Up 2 hours (healthy)",
        image: "shop-local-api",
      },
      {
        service: "db",
        name: "shop-local-db-1",
        id: ID_DB.slice(0, 12),
        state: "exited",
        health: "",
        exitCode: 143,
        status: "Exited (143) 5 hours ago",
        image: "postgres:16",
      },
    ]);
  });

  it("reads one JSON array (Compose before 2.21), and an empty answer as no containers", () => {
    const out = `[${psLine({ State: "restarting", Status: "Restarting (1) 4 seconds ago", ExitCode: 1 })}]\n`;
    expect(parseComposePs(out)).toMatchObject([{ service: "api", state: "restarting", exitCode: 1 }]);
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("[]\n")).toEqual([]);
  });

  it("refuses output that isn't JSON, so it never reads as 'no containers'", () => {
    expect(() => parseComposePs("NAME   IMAGE   STATUS\nshop-local-api-1   shop-local-api   Up\n")).toThrow(
      "not JSON",
    );
    expect(() => parseComposePs('{"Service": "api", "ID": ')).toThrow("not JSON");
    expect(() => parseComposePs("[{]")).toThrow("not JSON");
  });

  it("skips entries without a service or a container id", () => {
    const out = [psLine({ Service: "" }), psLine({ ID: "--format" }), psLine({})].join("\n");
    expect(parseComposePs(out).map((e) => e.service)).toEqual(["api"]);
  });
});

describe("parseInspect", () => {
  const inspect = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify(
      [
        {
          Id: ID_API,
          Created: "2026-03-01T09:00:00.000000000Z",
          Name: "/shop-local-api-1",
          RestartCount: 7,
          State: {
            Status: "running",
            Running: true,
            Paused: false,
            Restarting: false,
            OOMKilled: false,
            Dead: false,
            Pid: 4242,
            ExitCode: 0,
            Error: "",
            StartedAt: "2026-03-01T09:00:01.000000000Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            ...state,
          },
          Image: IMAGE,
          Config: { Image: "shop-local-api", Labels: { "com.docker.compose.service": "api" } },
          HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
          ...extra,
        },
      ],
      null,
      4,
    );

  it("reads the restart count (top level) and the image", () => {
    expect(parseInspect(inspect({}))).toEqual([
      {
        id: ID_API,
        name: "shop-local-api-1",
        restartCount: 7,
        status: "running",
        restarting: false,
        exitCode: 0,
        error: "",
        health: undefined,
        imageId: IMAGE,
        imageRef: "shop-local-api",
      },
    ]);
  });

  it("reads State.Health and the last failing check's output", () => {
    const [entry] = parseInspect(
      inspect({
        Health: {
          Status: "unhealthy",
          FailingStreak: 3,
          Log: [
            { Start: "a", End: "b", ExitCode: 0, Output: "" },
            { Start: "c", End: "d", ExitCode: 1, Output: "curl: (7) Failed to connect\n" },
          ],
        },
      }),
    );
    expect(entry.health).toEqual({ status: "unhealthy", failingStreak: 3, lastFailure: "curl: (7) Failed to connect" });
  });

  it("reads a restarting container and Docker's error", () => {
    const [entry] = parseInspect(
      inspect({ Status: "restarting", Restarting: true, ExitCode: 1, Error: "OCI runtime create failed" }),
    );
    expect(entry).toMatchObject({ status: "restarting", restarting: true, exitCode: 1, error: "OCI runtime create failed" });
  });

  it("reads what it found when a container is gone (exit 1 still prints an array)", () => {
    expect(parseInspect("[]\n")).toEqual([]);
    expect(parseInspect("")).toEqual([]);
    expect(() => parseInspect("[{")).toThrow("not JSON");
  });
});

describe("composeBase", () => {
  it("passes the project name, each compose file and the project directory as separate arguments", () => {
    const env = {
      name: "local",
      composeFiles: ["compose.yaml", "compose.override.yaml"],
      projectName: "shop-local",
      projectDirectory: "/home/user/shop",
    } as EnvironmentSettings;
    expect(composeBase(["docker"], env)).toEqual([
      "docker",
      "compose",
      "-p",
      "shop-local",
      "-f",
      "compose.yaml",
      "-f",
      "compose.override.yaml",
      "--project-directory",
      "/home/user/shop",
    ]);
    expect(composeBase(["podman"], { ...env, projectDirectory: undefined, composeFiles: ["c.yaml"] })).toEqual([
      "podman",
      "compose",
      "-p",
      "shop-local",
      "-f",
      "c.yaml",
    ]);
  });
});

describe("imageRepository", () => {
  it("drops the tag, keeps a registry port, and refuses digests and option-like refs", () => {
    expect(imageRepository("shop-local-api")).toBe("shop-local-api");
    expect(imageRepository("example/api:dev")).toBe("example/api");
    expect(imageRepository("localhost:5000/api")).toBe("localhost:5000/api");
    expect(imageRepository("localhost:5000/api:1.2")).toBe("localhost:5000/api");
    expect(imageRepository("example/api@sha256:abc")).toBeNull();
    expect(imageRepository("--output=x")).toBeNull();
  });
});

describe("errorLines", () => {
  it("keeps the last lines that read like errors, without colour codes", () => {
    const log = [
      "listening on :8080",
      "\u001b[31mERROR\u001b[0m connect ECONNREFUSED db:5432",
      "retrying",
      "FATAL: password authentication failed",
      "",
    ].join("\n");
    expect(errorLines(log)).toEqual([
      "ERROR connect ECONNREFUSED db:5432",
      "FATAL: password authentication failed",
    ]);
  });

  it("falls back to the last lines when none reads like an error, and caps the count", () => {
    const log = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    expect(errorLines(log, 3)).toEqual(["line 27", "line 28", "line 29"]);
  });
});
