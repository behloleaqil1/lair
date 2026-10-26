import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { LAIR_VERSION } from "./version.js";

describe("LAIR_VERSION", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as { version: string };
    expect(LAIR_VERSION).toBe(pkg.version);
  });
});
