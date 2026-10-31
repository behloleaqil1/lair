/**
 * Input validation for the Decision Inbox, like watchdog/config.ts: zod for
 * shapes, then the rules that span fields (the recommended option exists, a
 * default is allowed for this kind, ...). Every error names its field.
 *
 * Error messages never repeat a value from the input, so a secret sent in
 * the wrong field can't come back in a response or a log line.
 */
import { z } from "zod";
import {
  DECISION_ATTENTIONS,
  DECISION_KINDS,
  NEVER_DEFAULT_KINDS,
  type DecisionAttention,
  type DecisionEvidence,
  type DecisionKind,
  type DecisionLink,
  type DecisionOption,
} from "../../shared/decision-types.js";
import { ClassSchema, EffectSchema, EvidenceSchema, structureErrors } from "./structure.js";
import type { AnswerInput, WithdrawInput } from "./types.js";

/** An error with the HTTP status the routes answer with. */
export class DecisionError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OPTION_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MODULE = /^[a-z][a-z0-9_-]{0,39}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;
const DECISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for the ids decisions get (lowercase UUIDs). */
export function isDecisionId(id: unknown): id is string {
  return typeof id === "string" && DECISION_ID.test(id);
}

/** Control characters other than tab and newlines (when allowed). */
export function hasControlCharacters(text: string, allowNewlines: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20) {
      if (allowNewlines && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !hasControlCharacters(s, false), "must be one line without control characters");

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !hasControlCharacters(s, true), "must not contain control characters");

const OptionSchema = z
  .object({
    id: z.string().regex(OPTION_ID, "use lowercase letters, digits, '_' and '-', starting with a letter (at most 40)"),
    label: oneLine(120),
    consequences: text(1000),
    suppliesSecret: z.boolean().optional(),
    effect: EffectSchema.optional(),
  })
  .strict();

/** An IPv4 address as four numbers, or null. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

/**
 * Names that only resolve on this machine or a local network (special-use
 * and common home-network domains), and public wildcard-DNS services that
 * answer with whatever address is in the name or with 127.0.0.1.
 */
const PRIVATE_NAMES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "lan",
  "arpa",
  "localtest.me",
  "lvh.me",
  "nip.io",
  "sslip.io",
  "xip.io",
];

/**
 * True for hosts on this machine or a private network: localhost, the names
 * in PRIVATE_NAMES and anything under them, single-label names, loopback,
 * private, link-local and unique-local addresses (also IPv4-mapped IPv6).
 * Pass a URL's `hostname` (the URL parser has already turned 2130706433,
 * 0x7f000001, 0177.0.0.1 and 127.1 into 127.0.0.1). A link to one of them
 * could lead the owner's browser to a local listener an agent runs.
 */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "" || PRIVATE_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) return true;
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique local (fc00::/7), link local (fe80::/10), IPv4-mapped
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true;
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      const dotted = ipv4(mapped);
      if (dotted) return privateIpv4(dotted);
      const words = mapped.split(":");
      if (words.length === 2) {
        const hi = parseInt(words[0], 16);
        const lo = parseInt(words[1], 16);
        return privateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
      }
      return true;
    }
    return false;
  }
  // A name without a dot resolves on the local network, if at all
  return !host.includes(".");
}

const LinkSchema = z
  .object({
    label: oneLine(120),
    url: z
      .string()
      .max(2000)
      .refine((u) => {
        try {
          const protocol = new URL(u).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      }, "must be an http or https URL")
      .refine((u) => {
        try {
          const url = new URL(u);
          if (url.protocol !== "http:" && url.protocol !== "https:") return true; // reported above
          return !isPrivateHost(url.hostname);
        } catch {
          return true; // reported above
        }
      }, "must not point at this machine or a private network (localhost, *.local, *.internal, *.lan, *.arpa, wildcard DNS such as nip.io, names without a dot, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16)"),
  })
  .strict();

const RaiseSchema = z
  .object({
    project: z.string().regex(PROJECT, "must be a project name (letters, digits, '.', '_' and '-')"),
    kind: z.enum(DECISION_KINDS),
    attention: z.enum(DECISION_ATTENTIONS).default("action"),
    title: oneLine(200),
    context: text(20000),
    options: z.array(OptionSchema).min(1).max(10),
    recommended: z
      .object({
        optionId: z.string().min(1).max(40),
        reasoning: text(2000),
      })
      .strict(),
    source: z
      .object({
        module: z.string().regex(MODULE, "use lowercase letters, digits, '_' and '-', starting with a letter"),
        ref: oneLine(200),
      })
      .strict(),
    key: oneLine(200),
    blocks: z.array(oneLine(200)).max(50).default([]),
    links: z.array(LinkSchema).max(20).default([]),
    secretName: z.string().regex(SECRET_NAME, "use letters, digits, '_', '.' and '-'").optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    defaultOptionId: z.string().min(1).max(40).optional(),
    class: ClassSchema.optional(),
    evidence: EvidenceSchema.optional(),
  })
  .strict();

/** A raise() input after validation, with defaults applied and times normalised. */
export interface ValidRaise {
  project: string;
  kind: DecisionKind;
  attention: DecisionAttention;
  title: string;
  context: string;
  options: DecisionOption[];
  recommended: { optionId: string; reasoning: string };
  source: { module: string; ref: string };
  key: string;
  blocks: string[];
  links: DecisionLink[];
  secretName?: string;
  expiresAt?: string;
  defaultOptionId?: string;
  class?: string;
  evidence?: DecisionEvidence;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function zodErrors(error: z.ZodError, prefix = ""): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `${prefix}${path || "(body)"}: ${issue.message}`;
  });
}

/** Validate what a producer passes to raise(). `now` decides whether expiresAt is in the future. */
export function parseRaiseInput(raw: unknown, now: number): Parsed<ValidRaise> {
  const parsed = RaiseSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const value = parsed.data;
  const errors: string[] = [];

  const ids = value.options.map((o) => o.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) errors.push(`options: duplicate option id ${duplicate}`);
  if (!ids.includes(value.recommended.optionId)) {
    errors.push("recommended.optionId: must be one of the options");
  }

  const supplying = value.options.filter((o) => o.suppliesSecret === true);
  if (value.kind === "credentials") {
    if (!value.secretName) errors.push("secretName: a credentials decision needs the name its secret is stored under");
    if (supplying.length === 0) {
      errors.push("options: a credentials decision needs an option with suppliesSecret: true");
    }
  } else {
    if (value.secretName !== undefined) errors.push("secretName: only credentials decisions take a secret");
    if (supplying.length > 0) errors.push("options: only credentials decisions have options that supply a secret");
  }

  let expiresAt: string | undefined;
  if (value.expiresAt !== undefined) {
    const at = Date.parse(value.expiresAt);
    if (!Number.isFinite(at)) {
      errors.push("expiresAt: not a valid time");
    } else if (at <= now) {
      errors.push("expiresAt: must be in the future");
    } else {
      expiresAt = new Date(at).toISOString();
    }
  }

  // A notice asks nothing: it can't stand for a question that always waits for a human, or apply a default
  if (value.attention === "notice") {
    if (NEVER_DEFAULT_KINDS.includes(value.kind)) {
      errors.push(`attention: a ${value.kind} decision always needs an answer, so it can't be a notice`);
    }
    if (value.defaultOptionId !== undefined) errors.push("attention: a notice has no default (nothing is decided for you)");
  }

  errors.push(
    ...structureErrors({ class: value.class, evidence: value.evidence, options: value.options, module: value.source.module }),
  );

  if (value.defaultOptionId !== undefined) {
    if (NEVER_DEFAULT_KINDS.includes(value.kind)) {
      errors.push(`defaultOptionId: ${value.kind} decisions can't have a default: they always wait for a human`);
    } else if (!ids.includes(value.defaultOptionId)) {
      errors.push("defaultOptionId: must be one of the options");
    } else if (value.expiresAt === undefined) {
      errors.push("defaultOptionId: a default applies at expiry, so it needs expiresAt");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      project: value.project,
      kind: value.kind,
      attention: value.attention,
      title: value.title,
      context: value.context,
      options: value.options.map((o) => ({
        id: o.id,
        label: o.label,
        consequences: o.consequences,
        ...(o.suppliesSecret ? { suppliesSecret: true } : {}),
        ...(o.effect ? { effect: o.effect } : {}),
      })),
      recommended: value.recommended,
      source: value.source,
      key: value.key,
      blocks: [...new Set(value.blocks)],
      links: value.links,
      secretName: value.secretName,
      expiresAt,
      defaultOptionId: value.defaultOptionId,
      ...(value.class !== undefined ? { class: value.class } : {}),
      ...(value.evidence !== undefined ? { evidence: value.evidence } : {}),
    },
  };
}

const AnswerSchema = z
  .object({
    optionId: z.string().min(1).max(40),
    note: z
      .string()
      .max(2000)
      .refine((s) => !hasControlCharacters(s, true), "must not contain control characters")
      .optional(),
    confirm: z.boolean().optional(),
    secret: z.string().min(1).max(10000).optional(),
  })
  .strict();

/** Validate an answer. The shape only; the decision's own rules are checked by the inbox. */
export function parseAnswerInput(raw: unknown): Parsed<AnswerInput> {
  const parsed = AnswerSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const { note, ...rest } = parsed.data;
  return { ok: true, value: { ...rest, ...(note && note.trim() ? { note } : {}) } };
}

const WithdrawSchema = z
  .object({
    module: z.string().regex(MODULE, "use lowercase letters, digits, '_' and '-', starting with a letter"),
    reason: text(1000),
  })
  .strict();

export function parseWithdrawInput(raw: unknown): Parsed<WithdrawInput> {
  const parsed = WithdrawSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  return { ok: true, value: parsed.data };
}
