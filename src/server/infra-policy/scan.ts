/**
 * The static policy scan (docs/design/deploy-aws.md §2.1). It reads the
 * infrastructure code of a root directory, and of every local module the
 * root calls, and never runs anything: no plan, no init, no provider.
 *
 * Refused unless the owner allows it in the project config:
 *  - `external` data sources, `http` data sources, `local-exec` provisioners
 *    (on `null_resource`, `terraform_data` or any other resource);
 *  - a provider whose source is not in `allowed_providers`;
 *  - a remote module whose source is not in `allowed_modules`;
 *  - a local module outside the root, or a source that is not a literal.
 * Code the scan cannot read is refused as well (fail closed).
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { HclError, parseHcl, parseHclJson, type Block, type Value } from "./hcl.js";
import type { InfraPolicySettings } from "./config.js";

export type Rule =
  | "denied-external-data"
  | "denied-http-data"
  | "denied-local-exec"
  | "provider-not-allowed"
  | "module-not-allowed"
  | "module-outside-root"
  | "source-not-literal"
  | "unreadable";

export interface Violation {
  rule: Rule;
  /** Path relative to the scanned root */
  file: string;
  line: number;
  /** The block's address (`data.http.health`, `module.net.null_resource.x`), when it has one */
  address?: string;
  detail: string;
}

export interface ScanResult {
  ok: boolean;
  violations: Violation[];
  /** Denied blocks the owner allowed by address: shown, not refused */
  allowed: Violation[];
  filesScanned: number;
  modulesScanned: number;
}

/** Bounds on what one scan reads */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_MODULE_DEPTH = 8;

const CODE_FILE = /\.(tf|tofu)(\.json)?$/;
const DEFAULT_HOST = "registry.opentofu.org";
const EXTERNAL = `${DEFAULT_HOST}/hashicorp/external`;
const HTTP = `${DEFAULT_HOST}/hashicorp/http`;

/** `hashicorp/aws` and `registry.opentofu.org/hashicorp/aws` are the same provider */
export function normalizeProviderSource(source: string): string {
  const parts = source.trim().toLowerCase().split("/");
  return parts.length === 2 ? `${DEFAULT_HOST}/${parts.join("/")}` : parts.join("/");
}

function stringOf(v: Value | undefined): string | null {
  return v?.kind === "string" && !v.interpolated ? v.value : null;
}

interface Scan {
  rootReal: string;
  settings: InfraPolicySettings;
  allowedProviders: Set<string>;
  violations: Violation[];
  allowed: Violation[];
  files: number;
  modules: number;
  /** Real paths of the modules being scanned now (a module that calls itself is a loop) */
  active: Set<string>;
}

function fileOf(scan: Scan, dir: string, name: string): string {
  return relative(scan.rootReal, join(dir, name)) || name;
}

function readBlocks(scan: Scan, dir: string, name: string): Block[] | null {
  const path = join(dir, name);
  const file = fileOf(scan, dir, name);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
    const text = readFileSync(path, "utf-8");
    return name.endsWith(".json") ? parseHclJson(text) : parseHcl(text);
  } catch (e) {
    scan.violations.push({
      rule: "unreadable",
      file,
      line: e instanceof HclError ? e.line : 1,
      detail: e instanceof HclError ? e.message : "cannot be read",
    });
    return null;
  }
}

function report(scan: Scan, address: string, v: Violation): void {
  if (scan.settings.allow.includes(address)) scan.allowed.push(v);
  else scan.violations.push(v);
}

function inside(rootReal: string, path: string): boolean {
  return path === rootReal || path.startsWith(rootReal + sep);
}

function moduleAllowed(source: string, allowed: string[]): boolean {
  return allowed.some((entry) => (entry.endsWith("/") ? source.startsWith(entry) : source === entry));
}

function scanDir(scan: Scan, dir: string, chain: string, depth: number): void {
  const real = realpathSync(dir);
  if (scan.active.has(real)) {
    scan.violations.push({ rule: "unreadable", file: relative(scan.rootReal, real) || ".", line: 1, detail: "module calls itself" });
    return;
  }
  scan.active.add(real);
  try {
    scanDirBody(scan, dir, chain, depth);
  } finally {
    scan.active.delete(real);
  }
}

function scanDirBody(scan: Scan, dir: string, chain: string, depth: number): void {
  scan.modules++;

  const names = readdirSync(dir)
    .filter((n) => CODE_FILE.test(n))
    .sort();
  const files: { name: string; blocks: Block[] }[] = [];
  for (const name of names) {
    if (scan.files >= MAX_FILES) {
      scan.violations.push({ rule: "unreadable", file: fileOf(scan, dir, name), line: 1, detail: `more than ${MAX_FILES} files` });
      return;
    }
    scan.files++;
    const blocks = readBlocks(scan, dir, name);
    if (blocks) files.push({ name, blocks });
  }

  // Local provider names -> sources, from every required_providers of this module
  const sources = new Map<string, string>();
  const at = (name: string, block: Block) => ({ file: fileOf(scan, dir, name), line: block.line });
  for (const { name, blocks } of files) {
    for (const terraform of blocks.filter((b) => b.type === "terraform")) {
      for (const rp of terraform.blocks.filter((b) => b.type === "required_providers")) {
        for (const [local, value] of rp.attrs) {
          const declared = value.kind === "object" ? value.attrs.get("source") : undefined;
          if (value.kind === "object" && declared === undefined) {
            sources.set(local, normalizeProviderSource(`hashicorp/${local}`));
            continue;
          }
          const literal = stringOf(declared);
          if (literal === null) {
            scan.violations.push({ rule: "source-not-literal", ...at(name, rp), detail: `provider ${local}: source is not a plain string` });
          } else sources.set(local, normalizeProviderSource(literal));
        }
      }
    }
  }
  const sourceOf = (local: string) => sources.get(local) ?? normalizeProviderSource(`hashicorp/${local}`);

  const usedProviders = new Map<string, { file: string; line: number }>();
  const note = (local: string, where: { file: string; line: number }) => {
    // "terraform" is the built-in provider (terraform_data, terraform_remote_state)
    if (local !== "terraform" && !usedProviders.has(local)) usedProviders.set(local, where);
  };
  for (const local of sources.keys()) note(local, { file: fileOf(scan, dir, names[0] ?? ""), line: 1 });

  for (const { name, blocks } of files) {
    for (const block of blocks) {
      const where = at(name, block);
      if (block.type === "provider" && block.labels[0]) {
        note(block.labels[0], where);
      } else if ((block.type === "resource" || block.type === "data") && block.labels.length === 2) {
        const [type, rname] = block.labels;
        const meta = block.attrs.get("provider");
        const metaLocal = meta?.kind === "other" ? /^[A-Za-z_][A-Za-z0-9_-]*/.exec(meta.raw)?.[0] : undefined;
        const local = metaLocal ?? type.split("_")[0];
        note(local, where);
        const address = `${chain}${block.type === "data" ? "data." : ""}${type}.${rname}`;
        if (block.type === "data") {
          const source = sourceOf(local);
          if (type === "external" || source === EXTERNAL) {
            report(scan, address, { rule: "denied-external-data", ...where, address, detail: "external data sources run any program" });
          } else if (type === "http" || source === HTTP) {
            report(scan, address, { rule: "denied-http-data", ...where, address, detail: "http data sources call any URL" });
          }
        }
        for (const p of block.blocks) {
          if (p.type === "provisioner" && p.labels[0] === "local-exec") {
            report(scan, address, { rule: "denied-local-exec", file: where.file, line: p.line, address, detail: "local-exec runs a command on the machine that plans or applies" });
          }
        }
      } else if (block.type === "module" && block.labels.length === 1) {
        scanModule(scan, dir, chain, depth, block, where);
      }
    }
  }

  for (const [local, where] of usedProviders) {
    const source = sourceOf(local);
    if (!scan.allowedProviders.has(source)) {
      scan.violations.push({ rule: "provider-not-allowed", ...where, detail: `provider ${source} is not in allowed_providers` });
    }
  }
}

function scanModule(scan: Scan, dir: string, chain: string, depth: number, block: Block, where: { file: string; line: number }): void {
  const address = `${chain}module.${block.labels[0]}`;
  const source = stringOf(block.attrs.get("source"));
  if (source === null) {
    scan.violations.push({ rule: "source-not-literal", ...where, address, detail: "module source is missing or not a plain string" });
    return;
  }
  if (!(source.startsWith("./") || source.startsWith("../"))) {
    if (!moduleAllowed(source, scan.settings.allowedModules)) {
      scan.violations.push({ rule: "module-not-allowed", ...where, address, detail: `module source ${source} is not in allowed_modules` });
    }
    return;
  }
  const target = resolve(dir, source);
  let real: string;
  try {
    real = existsSync(target) ? realpathSync(target) : "";
  } catch {
    real = "";
  }
  if (!real || !inside(scan.rootReal, real)) {
    scan.violations.push({ rule: "module-outside-root", ...where, address, detail: "local module is missing or outside the root" });
    return;
  }
  if (depth >= MAX_MODULE_DEPTH) {
    scan.violations.push({ rule: "unreadable", ...where, address, detail: `modules nested deeper than ${MAX_MODULE_DEPTH}` });
    return;
  }
  scanDir(scan, real, `${address}.`, depth + 1);
}

/** Scan one root directory. Never throws for bad code: that is a violation. */
export function scanRoot(root: string, settings: InfraPolicySettings): ScanResult {
  const scan: Scan = {
    rootReal: "",
    settings,
    allowedProviders: new Set(settings.allowedProviders.map(normalizeProviderSource)),
    violations: [],
    allowed: [],
    files: 0,
    modules: 0,
    active: new Set(),
  };
  try {
    scan.rootReal = realpathSync(root);
    scanDir(scan, scan.rootReal, "", 0);
  } catch {
    scan.violations.push({ rule: "unreadable", file: ".", line: 1, detail: "the root cannot be read" });
  }
  return {
    ok: scan.violations.length === 0,
    violations: scan.violations,
    allowed: scan.allowed,
    filesScanned: scan.files,
    modulesScanned: scan.modules,
  };
}

/** What an agent sees of a refusal: the rule names, nothing else. */
export function agentMessage(result: ScanResult): string {
  const rules = [...new Set(result.violations.map((v) => v.rule))].sort();
  return `policy violation: ${rules.join(", ")}`;
}
