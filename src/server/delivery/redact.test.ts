/**
 * Redaction of what delivery stores and shows. Token-shaped values are built
 * at runtime so the source never contains one.
 */
import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

const word = ["s3cr3t", "value"].join("-");

describe("redact", () => {
  it("removes the user and password from URLs", () => {
    expect(redact(`git pull https://deploy:${word}@git.example.com/shop.git main`)).toBe(
      "git pull https://***:***@git.example.com/shop.git main",
    );
    expect(redact(`postgres://shop:${word}@db:5432/shop`)).toBe("postgres://***:***@db:5432/shop");
    expect(redact("http://localhost:8080/health")).toBe("http://localhost:8080/health");
  });

  it("removes common token shapes", () => {
    const github = ["ghp", "A".repeat(36)].join("_");
    const aws = ["AKIA", "B".repeat(16)].join("");
    expect(redact(`token ${github} used`)).toBe("token ghp_*** used");
    expect(redact(`key ${aws}`)).toBe("key AKIA***");
    expect(redact(`Authorization: Bearer ${"c".repeat(30)}`)).toBe("Authorization: Bearer ***");
  });

  it("removes values whose key names a secret, and leaves the rest", () => {
    expect(redact(`DB_PASSWORD=${word} denied`)).toBe("DB_PASSWORD=*** denied");
    expect(redact(`--build-arg NPM_TOKEN=${word}`)).toBe("--build-arg NPM_TOKEN=***");
    expect(redact(`api_key: "${word}"`)).toBe("api_key: ***");
    expect(redact("FATAL: missing table orders")).toBe("FATAL: missing table orders");
  });
});
