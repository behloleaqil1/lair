/**
 * The lock-file check (docs/design/deploy-aws.md §2.2 "Locked providers"):
 * every provider the plan may use is pinned in `.terraform.lock.hcl` with a
 * version and verified hashes, and is on the policy's allowed list. Together
 * with `init -lockfile=readonly -plugin-dir=<mirror>` no provider is chosen or
 * downloaded at plan time.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { normalizeProviderSource } from "../infra-policy/index.js";

export interface LockProblem {
  rule: "lock-missing" | "lock-unpinned" | "provider-not-allowed";
  detail: string;
}

const PROVIDER_BLOCK = /^provider\s+"([^"]+)"\s*\{([\s\S]*?)^\}/gm;

/** Problems with the lock file in `dir` (none means every provider is pinned, hashed and allowed) */
export async function checkLockFile(dir: string, allowedProviders: string[]): Promise<LockProblem[]> {
  let text: string;
  try {
    text = await readFile(join(dir, ".terraform.lock.hcl"), "utf-8");
  } catch {
    return [{ rule: "lock-missing", detail: ".terraform.lock.hcl not found in the root" }];
  }
  const allowed = new Set(allowedProviders.map(normalizeProviderSource));
  const problems: LockProblem[] = [];
  let found = 0;
  for (const m of text.matchAll(PROVIDER_BLOCK)) {
    found++;
    const source = m[1]!;
    const body = m[2]!;
    if (!allowed.has(normalizeProviderSource(source))) problems.push({ rule: "provider-not-allowed", detail: source });
    const pinned = /^\s*version\s*=\s*"[^"]+"/m.test(body);
    const hashed = /"(?:h1|zh):[A-Za-z0-9+/=]{8,}"/.test(body);
    if (!pinned || !hashed) problems.push({ rule: "lock-unpinned", detail: `${source} has no version or no verified hashes` });
  }
  if (found === 0) problems.push({ rule: "lock-missing", detail: "the lock file pins no provider" });
  return problems;
}
