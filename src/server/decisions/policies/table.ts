/**
 * Load and validate the policy table: data/policies.yaml when present, else the built-in table (C1-C4, C11
 * in shadow). Validation fails closed: an entry with any problem is refused and listed in `errors`; a file
 * that cannot be read or parsed gives no policies at all.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { parse } from "yaml";
import { z } from "zod";
import { KNOWN_DECISION_CLASSES } from "../structure.js";
import { CONDITION_OPS, POLICY_STATES, type Policy, type PolicyTable } from "./types.js";

export const MAX_POLICIES_BYTES = 256 * 1024;

const ID = /^[a-z][a-z0-9_-]{0,59}$/;
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const FACT = /^[a-z][a-z0-9_]{0,59}$/;
const OPTION = /^[A-Za-z0-9_.:-]{1,80}$/;

const Scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
const ConditionSchema = z
  .object({ fact: z.string().regex(FACT), op: z.enum(CONDITION_OPS), value: z.union([Scalar, z.array(z.union([z.string().max(200), z.number().finite(), z.boolean()])).max(20)]).optional() })
  .strict()
  .superRefine((c, ctx) => {
    const needsValue = c.op !== "present";
    if (needsValue && c.value === undefined) ctx.addIssue({ code: "custom", message: `${c.op} needs a value` });
    if (c.op === "in" && !Array.isArray(c.value)) ctx.addIssue({ code: "custom", message: "in needs a list" });
    if (c.op !== "in" && Array.isArray(c.value)) ctx.addIssue({ code: "custom", message: `${c.op} takes one value` });
    if (["gt", "gte", "lt", "lte"].includes(c.op) && typeof c.value !== "number") {
      ctx.addIssue({ code: "custom", message: `${c.op} compares numbers` });
    }
  });

const PolicySchema = z
  .object({
    id: z.string().regex(ID, "use lowercase letters, digits, '_' and '-'"),
    class: z.string(),
    codes: z.array(z.string().regex(CODE)).max(20).default([]),
    answer: z.string().regex(OPTION),
    reason_code: z.string().regex(CODE),
    state: z.enum(POLICY_STATES),
    max_tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    when: z.array(ConditionSchema).max(10).default([]),
    unless: z.array(ConditionSchema).max(10).default([]),
    expires: z.string().optional(),
  })
  .strict();

const FileSchema = z.object({ version: z.literal(1), policies: z.array(z.unknown()).max(200) }).strict();

function hash(policies: Policy[]): string {
  return createHash("sha256").update(JSON.stringify(policies)).digest("hex").slice(0, 8);
}

function issue(path: (string | number)[], message: string): string {
  return `${path.join(".") || "(entry)"}: ${message}`;
}

/** Parse YAML text into a table. Never throws. */
export function parsePolicyTable(text: string): PolicyTable {
  const empty = (error: string): PolicyTable => ({ policies: [], errors: [error], version: hash([]) });
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return empty(`the file is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }
  const file = FileSchema.safeParse(raw);
  if (!file.success) {
    const first = file.error.issues[0];
    return empty(`the file must be {version: 1, policies: [...]}: ${issue(first.path, first.message)}`);
  }
  const policies: Policy[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  file.data.policies.forEach((entry, index) => {
    const parsed = PolicySchema.safeParse(entry);
    const label = typeof (entry as { id?: unknown } | null)?.id === "string" ? (entry as { id: string }).id : `#${index + 1}`;
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      errors.push(`policy ${label}: ${issue(first.path, first.message)}`);
      return;
    }
    const p = parsed.data;
    const known = Object.hasOwn(KNOWN_DECISION_CLASSES, p.class) ? KNOWN_DECISION_CLASSES[p.class] : undefined;
    const problems: string[] = [];
    if (!known) problems.push(`class: ${p.class} is not in the policy table of classes`);
    else for (const code of p.codes) if (!known.codes.includes(code)) problems.push(`codes: ${p.class} has no evidence code ${code}`);
    if (seen.has(p.id)) problems.push("id: used twice");
    if (p.expires !== undefined && Number.isNaN(Date.parse(p.expires))) problems.push("expires: not an ISO-8601 time");
    if (problems.length > 0) {
      errors.push(`policy ${p.id}: ${problems[0]}`);
      return;
    }
    seen.add(p.id);
    policies.push({
      id: p.id,
      class: p.class,
      codes: p.codes,
      answer: p.answer,
      reasonCode: p.reason_code,
      state: p.state,
      maxTier: p.max_tier,
      when: p.when,
      unless: p.unless,
      ...(p.expires !== undefined ? { expires: p.expires } : {}),
    });
  });
  return { policies, errors, version: hash(policies) };
}

/**
 * Rules C1-C4 and C11 of the design, in shadow. Each answer is the one every recorded answer gave; the
 * guards are the design's own (§2) as far as the evidence carries them.
 */
export const DEFAULT_POLICIES_YAML = `# Decision policy table (docs/design/decision-policies.md). Shadow only: nothing here answers a decision.
version: 1
policies:
  # C1: every profile of an agent is failing or rate limited. A provider limit clears by itself.
  - id: c1-wait
    class: agents.provider_limit
    codes: [provider_rate_limit, provider_quota]
    answer: wait
    reason_code: provider_limit_clears
    state: shadow
    max_tier: 1
    unless:
      - { fact: cause_cleared, op: eq, value: true }
  # C2: a self-check is failing and an issue already tracks it.
  - id: c2-noted
    class: supervisor.check_failing
    codes: [check_failing]
    answer: noted
    reason_code: known_cause_tracked
    state: shadow
    max_tier: 1
    when:
      - { fact: linked_issue, op: present }
  # C3: ready work but nothing started, after the playbook already ran twice.
  - id: c3-stand-down
    class: watchdog.idle_capacity
    codes: [idle_capacity]
    answer: stand_down
    reason_code: playbook_already_ran
    state: shadow
    max_tier: 1
    when:
      - { fact: playbook_attempts, op: gte, value: 2 }
    unless:
      - { fact: running_count, op: eq, value: 0 }
  # C4: an orphaned claim whose release was refused because a runner is alive.
  - id: c4-stand-down
    class: watchdog.orphan_claim
    codes: [claim_orphan]
    answer: stand_down
    reason_code: runner_alive
    state: shadow
    max_tier: 1
    when:
      - { fact: process_found, op: eq, value: true }
  # C11: an agent cannot start (probe failed) or a fill waits too long. The cause is transient: only while the
  # task's run is below its third attempt; from the third on (or with no attempt count) it is left to you.
  - id: c11-keep-held
    class: agents.cannot_start
    codes: [probe_failed, fill_waiting]
    answer: keep_held
    reason_code: probe_error_transient
    state: shadow
    max_tier: 1
    unless:
      - { fact: attempt_count, op: gte, value: 3 }
`;

/** data/policies.yaml when it exists, else the built-in table. A file that is too large or unreadable gives no policies. */
export function loadPolicyTable(path: string): { table: PolicyTable; source: "file" | "built-in" } {
  if (!existsSync(path)) return { table: parsePolicyTable(DEFAULT_POLICIES_YAML), source: "built-in" };
  try {
    if (statSync(path).size > MAX_POLICIES_BYTES) {
      return { table: { policies: [], errors: [`the file is larger than ${MAX_POLICIES_BYTES} bytes`], version: hash([]) }, source: "file" };
    }
    return { table: parsePolicyTable(readFileSync(path, "utf8")), source: "file" };
  } catch (e) {
    return { table: { policies: [], errors: [`the file could not be read: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)], version: hash([]) }, source: "file" };
  }
}
