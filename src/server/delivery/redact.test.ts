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

  it("removes JWTs, PEM private keys, Authorization headers of any scheme, npm and Google keys", () => {
    const part = (c: string) => c.repeat(20);
    const jwt = ["eyJ" + part("a"), part("b"), part("c")].join(".");
    expect(redact(`cookie session=${jwt}; Path=/`)).toBe("cookie session=eyJ***; Path=/");
    // Built from pieces so this file never contains a PEM header itself
    const marker = (edge: string, kind: string) => ["-----" + edge, kind, "PRIVATE", "KEY-----"].join(" ").replace("  ", " ");
    const pem = [marker("BEGIN", "RSA"), part("M"), part("N"), marker("END", "RSA")].join("\n");
    expect(redact(`key:\n${pem}\ndone`)).toBe(`key:\n${marker("BEGIN", "RSA")}***\ndone`);
    expect(redact(`${marker("BEGIN", "")} ${part("Q")}`)).toBe(`${marker("BEGIN", "")}***`);
    expect(redact(`Authorization: token ${part("d")}`)).toBe("Authorization: token ***");
    expect(redact(`authorization=${part("e")}`)).toBe("authorization=***");
    const npm = ["npm", "F".repeat(36)].join("_");
    const google = ["AIza", "G".repeat(35)].join("");
    expect(redact(`//registry.example.com/:_authToken=${npm}`)).not.toContain(npm);
    expect(redact(`key=${google}`)).toBe("key=AIza***");
  });

  it("removes values whose key names a secret, and leaves the rest", () => {
    expect(redact(`DB_PASSWORD=${word} denied`)).toBe("DB_PASSWORD=*** denied");
    expect(redact(`--build-arg NPM_TOKEN=${word}`)).toBe("--build-arg NPM_TOKEN=***");
    expect(redact(`api_key: "${word}"`)).toBe("api_key: ***");
    expect(redact(`--password=${word}`)).toBe("--password=***");
    expect(redact(`access_token: ${word}`)).toBe("access_token: ***");
    expect(redact("FATAL: missing table orders")).toBe("FATAL: missing table orders");
  });

  it("matches whole key names, so counts and limits that only contain a secret word stay", () => {
    expect(redact("tokens: 1500")).toBe("tokens: 1500");
    expect(redact("token_count=3 max_tokens=4096")).toBe("token_count=3 max_tokens=4096");
    expect(redact("password_policy: strict")).toBe("password_policy: strict");
  });
});
