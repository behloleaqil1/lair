/**
 * The Decision Inbox (docs/design/autonomy.md §1): the only place Lair asks
 * a human. Modules raise decisions through the DecisionProducer interface
 * (or POST /api/decisions), park the work a decision blocks, and resume when
 * the answer is delivered to the handler they registered with onResolved().
 *
 * - Dedupe: one open decision per project + module + key.
 * - Expiry: an open decision past expiresAt with a default is closed as
 *   "expired" with that default as its answer; one without a default keeps
 *   waiting and is marked overdue. The kinds that always wait can't have one.
 * - Delivery: an answer counts as delivered once the producer's handler
 *   returns. Until then it is retried every sweep, and delivered when the
 *   producer registers again after a restart.
 * - Credentials: a secret goes to the SecretStore and nowhere else.
 */
import type { EventBus } from "../core/event-bus.js";
import {
  CONFIRM_KINDS,
  NEVER_DEFAULT_KINDS,
  type Decision,
  type DecisionAnswer,
  type DecisionCounts,
} from "../../shared/decision-types.js";
import type { DecisionStore, ListOptions, RaisedVia } from "./store.js";
import { SecretStoreUnavailableError, type SecretStore } from "./secrets.js";
import { DecisionError, parseAnswerInput, parseRaiseInput, parseWithdrawInput } from "./validate.js";
import type {
  AnswerContext,
  AnswerInput,
  Clock,
  DecisionProducer,
  RaiseDecisionInput,
  RaiseResult,
  ResolutionHandler,
  WithdrawInput,
} from "./types.js";

export interface DecisionInboxOptions {
  store: DecisionStore;
  secrets: SecretStore;
  events?: EventBus;
  clock?: Clock;
  /** Seconds between expiry and delivery sweeps once start()ed (default 30) */
  sweepSeconds?: number;
  /**
   * Open decisions one module may have in one project; raising more is
   * refused with 429 (default DEFAULT_MAX_OPEN_PER_SOURCE)
   */
  maxOpenPerSource?: number;
  /**
   * Open decisions raised over HTTP per project, whatever module they name
   * (the name is the caller's word); more get 429 (default
   * DEFAULT_MAX_OPEN_HTTP_PER_PROJECT)
   */
  maxOpenHttpPerProject?: number;
}

/** The actor for what the inbox does itself (defaults, overdue marks, deliveries). */
const LAIR = "lair";
/** The only one who answers: the human with an owner session (src/server/human-auth/). */
const OWNER = "owner";
const DEFAULT_SWEEP_SECONDS = 30;
export const DEFAULT_MAX_OPEN_PER_SOURCE = 50;
export const DEFAULT_MAX_OPEN_HTTP_PER_PROJECT = 20;
const MAX_USER_AGENT = 200;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "from 127.0.0.1 (user agent)" for the audit trail, printable and bounded; "" without either. */
function describeOrigin(context: AnswerContext): string {
  const printable = (text: string) => [...text].map((ch) => (ch < " " || ch === "\u007f" ? " " : ch)).join("");
  const address = context.remoteAddress ? printable(context.remoteAddress).slice(0, 64) : "";
  const agent = context.userAgent ? printable(context.userAgent).slice(0, MAX_USER_AGENT) : "";
  if (!address && !agent) return "";
  return `from ${address || "an unknown address"}${agent ? ` (${agent})` : ""}`;
}

function handlerKey(module: string, project: string | undefined): string {
  return `${module}\n${project ?? "*"}`;
}

export class DecisionInbox implements DecisionProducer {
  private store: DecisionStore;
  private secrets: SecretStore;
  private events?: EventBus;
  private clock: Clock;
  private sweepSeconds: number;
  private handlers = new Map<string, ResolutionHandler>();
  /** Classes outside the policy table already warned about */
  private flaggedClasses = new Set<string>();
  private inflight = new Map<string, Promise<boolean>>();
  private sweeping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private maxOpenPerSource: number;
  private maxOpenHttpPerProject: number;
  /** Answers whose secret is being stored: not deliverable until that succeeds */
  private settling = new Set<string>();

  constructor(options: DecisionInboxOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.events = options.events;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sweepSeconds = options.sweepSeconds ?? DEFAULT_SWEEP_SECONDS;
    this.maxOpenPerSource = options.maxOpenPerSource ?? DEFAULT_MAX_OPEN_PER_SOURCE;
    this.maxOpenHttpPerProject = options.maxOpenHttpPerProject ?? DEFAULT_MAX_OPEN_HTTP_PER_PROJECT;
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Where credentials go, for the UI. */
  get secretStoreDescription(): string {
    return this.secrets.description;
  }

  // ============ PRODUCER INTERFACE ============

  /** A module inside the server asks. */
  raise(input: RaiseDecisionInput): Promise<RaiseResult> {
    return this.raiseVia(input, "server");
  }

  /**
   * POST /api/decisions asks: the caller is unknown, so besides the
   * per-module cap, every HTTP caller shares one cap per project. It can't
   * ask in the name of a module inside Lair that follows its answers (one
   * with a handler): such an answer would act for the owner. And no answer
   * to a decision raised this way is ever handed to a module (deliverNow).
   */
  raiseFromHttp(input: RaiseDecisionInput): Promise<RaiseResult> {
    return this.raiseVia(input, "http");
  }

  /** Whether a module inside the server follows answers under this name (in any project). */
  private followed(module: string): boolean {
    for (const key of this.handlers.keys()) {
      if (key.slice(0, key.indexOf("\n")) === module) return true;
    }
    return false;
  }

  private async raiseVia(input: RaiseDecisionInput, via: RaisedVia): Promise<RaiseResult> {
    let parsed = parseRaiseInput(input, this.clock.now());
    let structureRefusal: string | undefined;
    if (!parsed.ok && via === "server") {
      // A module inside Lair never loses a real decision to a bad class, evidence or effect: raise it plain and say why
      const plain = parseRaiseInput(withoutStructure(input), this.clock.now());
      if (plain.ok) {
        structureRefusal = parsed.errors.join("; ");
        console.warn(
          `[decisions] ${plain.value.source.module} raised ${plain.value.key} with a structure the schema refused, so it is raised without it: ${structureRefusal}`,
        );
        parsed = plain;
      }
    }
    if (!parsed.ok) {
      throw new DecisionError(400, `Invalid decision: ${parsed.errors.join("; ")}`);
    }
    if (via === "http" && this.followed(parsed.value.source.module)) {
      throw new DecisionError(
        403,
        `source.module: ${parsed.value.source.module} is a module inside Lair: only it raises its own decisions (over HTTP, name your own module)`,
      );
    }
    const at = this.iso();
    const outcome = this.store.raise(parsed.value, at, {
      via,
      maxOpenPerSource: this.maxOpenPerSource,
      maxOpenHttpPerProject: this.maxOpenHttpPerProject,
    });
    if (outcome.kind === "capped") {
      const who = outcome.by === "http" ? "HTTP callers already have" : `${parsed.value.source.module} already has`;
      throw new DecisionError(
        429,
        `${who} ${outcome.open} open decisions in ${parsed.value.project} ` +
          `(the limit is ${outcome.limit}): wait for answers or withdraw some first`,
      );
    }
    const { decision, addedBlocks } = outcome;
    const created = outcome.kind === "created";
    const { module, ref } = decision.source;
    if (created) {
      if (decision.class !== undefined && decision.classKnown === false && !this.flaggedClasses.has(decision.class)) {
        this.flaggedClasses.add(decision.class);
        console.warn(`[decisions] ${module} raised class ${decision.class}, which is not in the policy table (docs/design/decision-policies.md §2)`);
      }
      const expiry = decision.expiresAt
        ? `; expires ${decision.expiresAt}${decision.defaultOptionId ? `, then ${decision.defaultOptionId} applies` : ", then it keeps waiting"}`
        : "";
      this.store.addAudit(decision.id, {
        at,
        action: "raised",
        actor: module,
        detail: `${decision.attention === "notice" ? "notice" : `${decision.kind} decision`} raised by ${module} (${ref}), recommending ${decision.recommended.optionId}${expiry}${decision.class !== undefined && decision.classKnown === false ? `; class ${decision.class} is not in the policy table` : ""}`,
      });
      if (structureRefusal !== undefined) {
        this.store.addAudit(decision.id, {
          at,
          action: "structure_refused",
          actor: module,
          detail: `raised without class, evidence and effects: ${structureRefusal}`.slice(0, 1000),
        });
        await this.events?.emit("decision.structure_refused", {
          decisionId: decision.id,
          project: decision.project,
          module,
          ref,
          key: decision.key,
          errors: structureRefusal.slice(0, 1000),
        });
      }
      await this.events?.emit("decision.raised", {
        decisionId: decision.id,
        project: decision.project,
        kind: decision.kind,
        attention: decision.attention,
        title: decision.title,
        module,
        ref,
        key: decision.key,
        blocks: decision.blocks,
        expiresAt: decision.expiresAt ?? null,
      });
    } else if (addedBlocks.length > 0) {
      this.store.addAudit(decision.id, {
        at,
        action: "raised_again",
        actor: module,
        detail: `raised again by ${module} (${parsed.value.source.ref}); now also blocks ${addedBlocks.join(", ")}`,
      });
    }
    return { decision: this.store.get(decision.id, at)!, created };
  }

  async withdraw(id: string, raw: WithdrawInput): Promise<Decision> {
    const parsed = parseWithdrawInput(raw);
    if (!parsed.ok) throw new DecisionError(400, `Invalid withdrawal: ${parsed.errors.join("; ")}`);
    const { module, reason } = parsed.value;
    const decision = this.store.get(id);
    if (!decision) throw new DecisionError(404, "Decision not found");
    if (decision.source.module !== module) {
      throw new DecisionError(403, `Only the module that raised this decision (${decision.source.module}) can withdraw it`);
    }
    const at = this.iso();
    if (
      decision.status !== "open" ||
      !this.store.closeDecision(id, { status: "withdrawn", at, withdrawnReason: reason, delivered: true })
    ) {
      throw new DecisionError(409, `Decision is ${this.store.get(id)?.status ?? decision.status}, not open`);
    }
    this.store.addAudit(id, { at, action: "withdrawn", actor: module, detail: `withdrawn by ${module}: ${reason}` });
    await this.events?.emit("decision.withdrawn", {
      decisionId: id,
      project: decision.project,
      kind: decision.kind,
      module,
      reason,
    });
    return this.get(id)!;
  }

  /** The most urgent open decision that blocks `ref`, or null when the work may go on. */
  blockedOn(ref: string): Decision | null {
    return this.store.blocking(ref, this.iso())[0] ?? null;
  }

  /** The latest decision `module` raised with `key` in `project` (an open one first), or null. */
  find(project: string, module: string, key: string): Decision | null {
    return this.store.find(project, module, key, this.iso());
  }

  /** The open decisions `module` raised in `project`, oldest first. */
  openOf(project: string, module: string): Decision[] {
    return this.store.openOf(project, module, this.iso());
  }

  onResolved(module: string, handler: ResolutionHandler, options: { project?: string } = {}): () => void {
    const key = handlerKey(module, options.project);
    this.handlers.set(key, handler);
    // Answers given while nobody listened (e.g. before a restart)
    this.deliverPending(module).catch((e) => console.error(`[decisions] delivery to ${module} failed:`, e));
    return () => {
      if (this.handlers.get(key) === handler) this.handlers.delete(key);
    };
  }

  // ============ READS ============

  /** One decision with its audit trail. */
  get(id: string): Decision | null {
    const decision = this.store.get(id, this.iso());
    return decision ? { ...decision, audit: this.store.audit(id) } : null;
  }

  /** Open first by urgency (soonest expiry, then oldest), then the rest, newest first. */
  list(options: ListOptions = {}): Decision[] {
    return this.store.list(options, this.iso());
  }

  counts(project?: string): DecisionCounts {
    return this.store.counts(this.iso(), project);
  }

  // ============ ANSWERS ============

  /**
   * The owner's answer. Validates it against the decision and closes it
   * (the first answer wins), then hands a credentials answer's secret to the
   * secret store, and only then records it and resumes the producer. When
   * the secret store fails, the decision is open again (503). `context`
   * (where the request came from) goes into the audit entry.
   */
  async answer(id: string, raw: AnswerInput, context: AnswerContext = {}): Promise<Decision> {
    const parsed = parseAnswerInput(raw);
    if (!parsed.ok) throw new DecisionError(400, `Invalid answer: ${parsed.errors.join("; ")}`);
    const input = parsed.value;
    const decision = this.store.get(id);
    if (!decision) throw new DecisionError(404, "Decision not found");
    if (decision.status !== "open") throw new DecisionError(409, `Decision is ${decision.status}, not open`);

    const option = decision.options.find((o) => o.id === input.optionId);
    if (!option) {
      throw new DecisionError(
        400,
        `optionId: not an option of this decision (${decision.options.map((o) => o.id).join(", ")})`,
      );
    }
    if (CONFIRM_KINDS.includes(decision.kind) && input.confirm !== true) {
      throw new DecisionError(400, `confirm: answering a ${decision.kind} decision needs confirm: true`);
    }

    if (decision.kind === "credentials" && input.note !== undefined) {
      throw new DecisionError(400, "note: credentials decisions take no note (a secret could end up in it)");
    }
    const suppliesSecret = option.suppliesSecret === true;
    if (input.secret !== undefined && !suppliesSecret) {
      throw new DecisionError(
        400,
        decision.kind === "credentials"
          ? "secret: only an option that supplies the secret takes a value"
          : "secret: only credentials decisions take a secret",
      );
    }
    const secret = input.secret;
    if (suppliesSecret && (secret === undefined || secret.trim() === "")) {
      throw new DecisionError(400, "secret: this option supplies the secret, so it needs the value");
    }

    const at = this.iso();
    const answer: DecisionAnswer = {
      optionId: option.id,
      ...(input.note ? { note: input.note } : {}),
      ...(suppliesSecret ? { secretSupplied: true } : {}),
    };
    // Close first: only the answer that wins hands its secret on
    if (!this.store.closeDecision(id, { status: "answered", at, answer, answeredBy: OWNER })) {
      throw new DecisionError(409, `Decision is ${this.store.get(id)?.status ?? "closed"}, not open`);
    }
    if (suppliesSecret && secret !== undefined) {
      this.settling.add(id);
      try {
        await this.secrets.put(decision.secretName!, secret);
      } catch (e) {
        this.store.reopenDecision(id, at);
        // Only our own error type is known to carry no value; say nothing else about others
        const why = e instanceof SecretStoreUnavailableError ? e.message : "it failed";
        throw new DecisionError(503, `The secret store could not take the secret: ${why}`);
      } finally {
        this.settling.delete(id);
      }
    }

    const parts = [`chose ${option.id} (${option.label})`];
    if (suppliesSecret) parts.push(`the secret went to the secret store as ${decision.secretName}`);
    if (input.note) parts.push(`note: ${input.note}`);
    const from = describeOrigin(context);
    if (from) parts.push(from);
    this.store.addAudit(id, { at, action: "answered", actor: OWNER, detail: parts.join("; ") });
    await this.events?.emit("decision.answered", {
      decisionId: id,
      project: decision.project,
      kind: decision.kind,
      module: decision.source.module,
      optionId: option.id,
      by: OWNER,
      secretSupplied: suppliesSecret,
    });
    await this.deliver(id);
    return this.get(id)!;
  }

  // ============ EXPIRY AND DELIVERY ============

  /**
   * Close the open decisions past their expiry that have a default (status
   * expired, the default as the answer, then delivered); mark the others
   * overdue, once. Both show in the audit trail.
   */
  async expireDue(): Promise<{ expired: number; overdue: number }> {
    const now = this.iso();
    let expired = 0;
    let overdue = 0;
    for (const decision of this.store.due(now)) {
      const option = decision.options.find((o) => o.id === decision.defaultOptionId);
      if (option && !NEVER_DEFAULT_KINDS.includes(decision.kind)) {
        const closed = this.store.closeDecision(decision.id, {
          status: "expired",
          at: now,
          answer: { optionId: option.id },
          answeredBy: LAIR,
        });
        if (!closed) continue;
        expired++;
        this.store.addAudit(decision.id, {
          at: now,
          action: "expired",
          actor: LAIR,
          detail: `unanswered at its expiry (${decision.expiresAt}); its default ${option.id} (${option.label}) applies`,
        });
        await this.events?.emit("decision.expired", {
          decisionId: decision.id,
          project: decision.project,
          kind: decision.kind,
          module: decision.source.module,
          optionId: option.id,
        });
        await this.deliver(decision.id);
      } else if (this.store.markOverdue(decision.id, now)) {
        overdue++;
        const why = NEVER_DEFAULT_KINDS.includes(decision.kind)
          ? `${decision.kind} decisions never default`
          : "it has no default";
        this.store.addAudit(decision.id, {
          at: now,
          action: "overdue",
          actor: LAIR,
          detail: `past its expiry (${decision.expiresAt}) and still waiting for an answer: ${why}`,
        });
      }
    }
    return { expired, overdue };
  }

  private handlerFor(module: string, project: string): ResolutionHandler | undefined {
    return this.handlers.get(handlerKey(module, project)) ?? this.handlers.get(handlerKey(module, undefined));
  }

  /** Deliver one answered or expired decision to its producer, if it listens. True when delivered. */
  private deliver(id: string): Promise<boolean> {
    const running = this.inflight.get(id);
    if (running) return running;
    const delivery = this.deliverNow(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, delivery);
    return delivery;
  }

  private async deliverNow(id: string): Promise<boolean> {
    const decision = this.store.get(id, this.iso());
    const answer = decision?.answer;
    if (!decision || decision.deliveredAt || !answer || this.settling.has(id)) return false;
    if (decision.status !== "answered" && decision.status !== "expired") return false;
    const outcome = decision.status === "expired" ? "expired" : "answered";
    const module = decision.source.module;
    if (decision.raisedVia === "http") {
      // Its module name is only what the caller said: no module inside Lair acts on its answer (or its default)
      const at = this.iso();
      if (this.store.markDelivered(id, at)) {
        this.store.addAudit(id, {
          at,
          action: "delivered",
          actor: LAIR,
          detail: `not handed to ${module}: it was raised over HTTP, so no module inside Lair acts on its answer (its caller reads it from the API)`,
        });
      }
      return false;
    }
    const handler = this.handlerFor(module, decision.project);
    if (!handler) return false;
    // A supplied secret must still be there (the server can restart between the answer and storing it,
    // and the in-memory store forgets on restart): if not, the human has to supply it again
    if (answer.secretSupplied && decision.secretName && !(await this.secrets.has(decision.secretName))) {
      if (decision.answeredAt && this.store.reopenDecision(id, decision.answeredAt)) {
        this.store.addAudit(id, {
          at: this.iso(),
          action: "reopened",
          actor: LAIR,
          detail: `the secret store has no ${decision.secretName} any more, so the answer can't be used: answer again`,
        });
      }
      return false;
    }
    try {
      await handler({
        decision,
        outcome,
        optionId: answer.optionId,
        note: answer.note,
        secretSupplied: answer.secretSupplied === true,
        by: decision.answeredBy ?? LAIR,
      });
    } catch (e) {
      const error = message(e);
      if (this.store.markDeliveryFailed(id, error) !== error) {
        this.store.addAudit(id, {
          at: this.iso(),
          action: "delivery_failed",
          actor: LAIR,
          detail: `${module} could not take the answer (retried every sweep): ${error}`,
        });
      }
      console.warn(`[decisions] ${module} could not take the answer to ${id}: ${error}`);
      return false;
    }
    const at = this.iso();
    if (this.store.markDelivered(id, at)) {
      this.store.addAudit(id, { at, action: "delivered", actor: LAIR, detail: `delivered to ${module}` });
    }
    return true;
  }

  /** Deliver every answer still waiting for its producer (of one module, or all). */
  async deliverPending(module?: string): Promise<number> {
    let delivered = 0;
    for (const decision of this.store.undelivered(module)) {
      if (await this.deliver(decision.id)) delivered++;
    }
    // Wait for deliveries already in flight too, so callers see a settled state
    await Promise.all([...this.inflight.values()]);
    return delivered;
  }

  /** expireDue() then deliverPending(). Concurrent calls share the sweep in progress. */
  sweep(): Promise<void> {
    if (!this.sweeping) {
      this.sweeping = (async () => {
        await this.expireDue();
        await this.deliverPending();
      })().finally(() => {
        this.sweeping = null;
      });
    }
    return this.sweeping;
  }

  /** Sweep now, then every sweepSeconds, until stop(). */
  start(): void {
    if (this.timer) return;
    const run = () => this.sweep().catch((e) => console.error("[decisions] sweep failed:", e));
    void run();
    this.timer = setInterval(run, this.sweepSeconds * 1000);
    this.timer.unref();
  }

  /** Stop sweeping; resolves once a sweep in progress has finished. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.sweeping?.catch(() => undefined);
    await Promise.all([...this.inflight.values()]).catch(() => undefined);
  }
}

/** The same input without class, evidence and the effect of each option. */
function withoutStructure(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete rest.class;
  delete rest.evidence;
  if (Array.isArray(rest.options)) {
    rest.options = rest.options.map((o) => {
      if (typeof o !== "object" || o === null) return o;
      const option: Record<string, unknown> = { ...(o as Record<string, unknown>) };
      delete option.effect;
      return option;
    });
  }
  return rest;
}
