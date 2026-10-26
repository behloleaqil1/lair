/**
 * The dev server must stay on port 5173: the API server accepts the
 * dashboard's Origin only on 5173 (and 4777), so a fallback to 5174 would
 * get HTTP 403 on every POST and WebSocket.
 */
import { describe, it, expect } from "vitest";
import type { UserConfig } from "vite";
import viteConfig from "../../vite.config";
import { DEV_CLIENT_PORT } from "../server/origin";

describe("vite.config.ts", () => {
  it("serves the dashboard on the port the server allows, and fails if it is taken", () => {
    const server = (viteConfig as UserConfig).server;
    expect(server?.port).toBe(DEV_CLIENT_PORT);
    expect(server?.strictPort).toBe(true);
  });
});
