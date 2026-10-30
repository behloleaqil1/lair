/**
 * The static policy scan (docs/design/deploy-aws.md §2.1). It reads the
 * infrastructure code of a root directory, and of every local module the
 * root calls, and never runs anything: no plan, no init, no provider.
 *
 * Refused unless the owner allows it in the project config:
 *  - `external` data sources and `http` data sources, also inside a `check` block;
 *  - provisioners (`local-exec`, `remote-exec`, `file`, any other), on any
 *    resource and in a `removed` block;
 *  - a provider whose source is not in `allowed_providers`;
 *  - a remote module whose source is not in `allowed_modules`;
 *  - a local module outside the root, or a source that is not a literal;
 *  - a block of a type the scan does not know, or with the wrong labels.
 * Code the scan cannot read, or that is bigger than the limits, is refused
 * as well (fail closed). The scan is asynchronous and bounded in total bytes
 * and in time, so code written by an agent cannot stall the server.
 */
import { lstat, readFile, readdir, realpath } from "fs/promises";
import { join, relative, resolve, sep } from "path";
import { BENIGN_BLOCKS, HclError, blockHash, parseHcl, parseHclJson, type Block, type Value } from "./hcl.js";
import type { InfraPolicySettings } from "./config.js";

export type Rule =
  | "denied-external-data"
  | "denied-http-data"
  | "denied-local-exec"
  | "denied-remote-exec"
  | "denied-file-provisioner"
  | "denied-provisioner"
  | "provider-not-allowed"
  | "module-not-allowed"
  | "module-outside-root"
  | "source-not-literal"
  | "unknown-block"
  | "invalid-config"
  | "unreadable";

export interface Violation {
  rule: Rule;
  /** Path relative to the scanned root */
  file: string;
  line: number;
  /** The address of the block (`data.http.health`, `module.net.null_resource.x`), when it has one */
  address?: string;
  /** The hash of that block's content: what an `allow` entry names */
  hash?: string;
  /** An `allow` entry names this address but not this content: the block changed after it was allowed */
  changedSinceAllowed?: true;
  detail: string;
}

export interface ScanResult {
  ok: boolean;
  violations: Violation[];
  /** Denied blocks the owner allowed (address and content hash): shown, not refused */
  allowed: Violation[];
  filesScanned: number;
  modulesScanned: number;
}

export interface ScanOptions {
  /** Milliseconds; the scan's clock (a test passes a fake one) */
  now?: () => number;
  /** The whole scan must end within this many milliseconds */
  deadlineMs?: number;
  /** The scan reads at most this many bytes of code in total */
  maxTotalBytes?: number;
}

/** Bounds on what one scan reads */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_MODULE_DEPTH = 8;
export const SCAN_DEADLINE_MS = 10_000;

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

/** The text of a value that is not a plain string (HCL: a reference; JSON: a string) */
function textOf(v: Value | undefined): string | undefined {
  return v?.kind === "other" ? v.raw : v?.kind === "string" ? v.value : undefined;
}

class ScanLimit extends Error {}

interface Scan {
  /** The root as configured (an `allow` entry names it) */
  root: string;
  rootReal: string;
  settings: InfraPolicySettings;
  allowedProviders: Set<string>;
  violations: Violation[];
  allowed: Violation[];
  files: number;
  modules: number;
  bytes: number;
  maxTotalBytes: number;
  now: () => number;
  deadlineAt: number;
  /** Set when the timer ran out: every loop stops at its next check */
  stopped: boolean;
  /** Real paths of the modules being scanned now (a module that calls itself is a loop) */
  active: Set<string>;
}

/** Throws when the scan is out of time */
function tick(scan: Scan): void {
  if (scan.stopped || scan.now() > scan.deadlineAt) throw new ScanLimit("scan limit");
}

/** A top-level block, as an `allow` entry names it */
interface Top {
  address: string;
  hash: string;
}

function fileOf(scan: Scan, dir: string, name: string): string {
  return relative(scan.rootReal, join(dir, name)) || name;
}

async function readBlocks(scan: Scan, dir: string, name: string): Promise<Block[] | null> {
  const path = join(dir, name);
  const file = fileOf(scan, dir, name);
  tick(scan);
  try {
    const st = await lstat(path);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
    scan.bytes += st.size;
    if (scan.bytes > scan.maxTotalBytes) throw new ScanLimit("scan limit");
    const text = await readFile(path, "utf-8");
    tick(scan);
    if (text.length > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
    return name.endsWith(".json") ? parseHclJson(text) : parseHcl(text);
  } catch (e) {
    if (e instanceof ScanLimit) throw e;
    scan.violations.push({
      rule: "unreadable",
      file,
      line: e instanceof HclError ? e.line : 1,
      detail: e instanceof HclError ? e.message : "cannot be read",
    });
    return null;
  }
}

/** A denied use: allowed only by an entry for this root, address and content hash */
function report(scan: Scan, top: Top, v: Violation): void {
  const found: Violation = { ...v, address: top.address, hash: top.hash };
  const named = scan.settings.allow.filter((a) => a.root === scan.root && a.address === top.address);
  if (named.some((a) => a.hash === top.hash)) scan.allowed.push(found);
  else if (named.length > 0) {
    scan.violations.push({ ...found, changedSinceAllowed: true, detail: `${v.detail}; the block changed since it was allowed` });
  } else scan.violations.push(found);
}

function inside(rootReal: string, path: string): boolean {
  return path === rootReal || path.startsWith(rootReal + sep);
}

function moduleAllowed(source: string, allowed: string[]): boolean {
  // a source that climbs out of an allowed prefix with .. is not under it
  if (source.split("/").includes("..")) return false;
  return allowed.some((entry) => (entry.endsWith("/") ? source.startsWith(entry) : source === entry));
}

function provisionerRule(kind: string): { rule: Rule; detail: string } {
  if (kind === "local-exec") return { rule: "denied-local-exec", detail: "local-exec runs a command on the machine that plans or applies" };
  if (kind === "remote-exec") return { rule: "denied-remote-exec", detail: "remote-exec runs commands on hosts the code names" };
  if (kind === "file") return { rule: "denied-file-provisioner", detail: "the file provisioner copies files to hosts the code names" };
  return { rule: "denied-provisioner", detail: `the ${kind} provisioner is not allowed` };
}

async function scanDir(scan: Scan, dir: string, chain: string, depth: number): Promise<void> {
  const real = await realpath(dir);
  if (scan.active.has(real)) {
    scan.violations.push({ rule: "unreadable", file: relative(scan.rootReal, real) || ".", line: 1, detail: "module calls itself" });
    return;
  }
  scan.active.add(real);
  try {
    await scanDirBody(scan, dir, chain, depth);
  } finally {
    scan.active.delete(real);
  }
}

async function scanDirBody(scan: Scan, dir: string, chain: string, depth: number): Promise<void> {
  scan.modules++;

  const names = (await readdir(dir)).filter((n) => CODE_FILE.test(n)).sort();
  const files: { name: string; blocks: Block[] }[] = [];
  for (const name of names) {
    if (scan.files >= MAX_FILES) {
      scan.violations.push({ rule: "unreadable", file: fileOf(scan, dir, name), line: 1, detail: `more than ${MAX_FILES} files` });
      return;
    }
    scan.files++;
    const blocks = await readBlocks(scan, dir, name);
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

  const malformed = (where: { file: string; line: number }, block: Block) => {
    scan.violations.push({ rule: "unknown-block", ...where, detail: `a ${block.type} block with ${block.labels.length} labels is not understood` });
  };
  /** The provider a resource or data block uses: its `provider` meta-argument (a reference in HCL, a string in JSON) or its type prefix */
  const localOf = (block: Block, type: string) => {
    const text = textOf(block.attrs.get("provider"));
    return (text !== undefined ? /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text)?.[0] : undefined) ?? type.split("_")[0];
  };
  const checkData = (type: string, local: string, top: Top, where: { file: string; line: number }) => {
    const source = sourceOf(local);
    if (type === "external" || source === EXTERNAL) {
      report(scan, top, { rule: "denied-external-data", ...where, detail: "external data sources run any program" });
    } else if (type === "http" || source === HTTP) {
      report(scan, top, { rule: "denied-http-data", ...where, detail: "http data sources call any URL" });
    }
  };
  /** Everything nested in a resource, data, check or removed block: provisioners at any depth, and data sources scoped to a check */
  const walk = (block: Block, top: Top, name: string) => {
    for (const child of block.blocks) {
      const where = at(name, child);
      if (child.type === "provisioner") {
        if (child.labels.length !== 1) malformed(where, child);
        else report(scan, top, { ...provisionerRule(child.labels[0]), ...where });
      } else if (child.type === "data" && block.type === "check") {
        if (child.labels.length !== 2) {
          malformed(where, child);
          continue;
        }
        const [type, dname] = child.labels;
        const local = localOf(child, type);
        note(local, where);
        checkData(type, local, { address: `${top.address}.data.${type}.${dname}`, hash: top.hash }, where);
      } else walk(child, top, name);
    }
  };

  for (const { name, blocks } of files) {
    for (const block of blocks) {
      tick(scan);
      const where = at(name, block);
      if (block.type === "provider") {
        if (block.labels.length !== 1) malformed(where, block);
        else note(block.labels[0], where);
      } else if (block.type === "resource" || block.type === "data") {
        if (block.labels.length !== 2) {
          malformed(where, block);
          continue;
        }
        const [type, rname] = block.labels;
        const local = localOf(block, type);
        note(local, where);
        const top = { address: `${chain}${block.type === "data" ? "data." : ""}${type}.${rname}`, hash: blockHash(block) };
        if (block.type === "data") checkData(type, local, top, where);
        walk(block, top, name);
      } else if (block.type === "check") {
        if (block.labels.length !== 1) {
          malformed(where, block);
          continue;
        }
        walk(block, { address: `${chain}check.${block.labels[0]}`, hash: blockHash(block) }, name);
      } else if (block.type === "removed") {
        if (block.labels.length !== 0) {
          malformed(where, block);
          continue;
        }
        const from = textOf(block.attrs.get("from"));
        walk(block, { address: `${chain}removed${from ? `.${from}` : ""}`, hash: blockHash(block) }, name);
      } else if (block.type === "module") {
        if (block.labels.length !== 1) malformed(where, block);
        else await scanModule(scan, dir, chain, depth, block, where);
      } else if (!BENIGN_BLOCKS.has(block.type)) {
        scan.violations.push({ rule: "unknown-block", ...where, detail: `a ${block.type} block is not understood` });
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

async function scanModule(scan: Scan, dir: string, chain: string, depth: number, block: Block, where: { file: string; line: number }): Promise<void> {
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
  let real: string;
  try {
    real = await realpath(resolve(dir, source));
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
  await scanDir(scan, real, `${address}.`, depth + 1);
}

/** Scan one root directory. Never throws for bad code: that is a violation. */
export async function scanRoot(root: string, settings: InfraPolicySettings, options: ScanOptions = {}): Promise<ScanResult> {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? SCAN_DEADLINE_MS;
  const scan: Scan = {
    root,
    rootReal: "",
    settings,
    allowedProviders: new Set(settings.allowedProviders.map(normalizeProviderSource)),
    violations: [],
    allowed: [],
    files: 0,
    modules: 0,
    bytes: 0,
    maxTotalBytes: options.maxTotalBytes ?? MAX_TOTAL_BYTES,
    now,
    deadlineAt: now() + deadlineMs,
    stopped: false,
    active: new Set(),
  };
  let limitReported = false;
  const limit = () => {
    if (!limitReported) scan.violations.push({ rule: "unreadable", file: ".", line: 1, detail: "scan limit" });
    limitReported = true;
  };
  const body = (async () => {
    try {
      scan.rootReal = await realpath(root);
      await scanDir(scan, scan.rootReal, "", 0);
    } catch (e) {
      if (e instanceof ScanLimit) limit();
      else scan.violations.push({ rule: "unreadable", file: ".", line: 1, detail: "the root cannot be read" });
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(() => {
      scan.stopped = true;
      resolveTimeout();
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    await Promise.race([body, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (scan.stopped) limit();
  const violations = [...scan.violations];
  return {
    ok: violations.length === 0,
    violations,
    allowed: [...scan.allowed],
    filesScanned: scan.files,
    modulesScanned: scan.modules,
  };
}

/** What an agent sees of a refusal: the rule names, nothing else. */
export function agentMessage(result: ScanResult): string {
  const rules = [...new Set(result.violations.map((v) => v.rule))].sort();
  return `policy violation: ${rules.join(", ")}`;
}
