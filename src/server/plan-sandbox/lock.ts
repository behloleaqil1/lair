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
  rule: "lock-missing" | "lock-unpinned" | "lock-malformed" | "provider-not-allowed";
  detail: string;
}

const PROVIDER_START = /^[ \t]*provider[ \t]+"([^"]+)"[ \t]*\{/gm;
/** Every line that begins with `provider`, however it is laid out */
const PROVIDER_WORD = /^[ \t]*provider\b/gm;

/** The text between the braces that open at `open` and the one that closes them, or null when they never close. Braces in strings and comments do not count. */
function balancedBody(text: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

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
  // Block by block with a brace count, so a block that closes early (or never) cannot swallow the next one
  let from = 0;
  for (;;) {
    PROVIDER_START.lastIndex = from;
    const m = PROVIDER_START.exec(text);
    if (!m) break;
    const parsed = balancedBody(text, m.index + m[0].length - 1);
    if (!parsed) return [{ rule: "lock-malformed", detail: `the block for ${m[1]!} is not closed` }];
    from = parsed.end;
    found++;
    const source = m[1]!;
    if (!allowed.has(normalizeProviderSource(source))) problems.push({ rule: "provider-not-allowed", detail: source });
    const pinned = /^\s*version\s*=\s*"[^"]+"/m.test(parsed.body);
    const hashed = /"(?:h1|zh):[A-Za-z0-9+/=]{8,}"/.test(parsed.body);
    if (!pinned || !hashed) problems.push({ rule: "lock-unpinned", detail: `${source} has no version or no verified hashes` });
  }
  // A line that starts with `provider` but was not read as a block (odd layout, nesting) is not trusted
  const starts = (text.match(PROVIDER_WORD) ?? []).length;
  if (starts !== found) return [{ rule: "lock-malformed", detail: "a provider block in the lock file could not be read" }];
  if (found === 0) problems.push({ rule: "lock-missing", detail: "the lock file pins no provider" });
  return problems;
}
