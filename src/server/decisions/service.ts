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
import type { DecisionStore, ListOptions } from "./store.js";
import { SecretStoreUnavailableError, type SecretStore } from "./secrets.js";
import { DecisionError, parseAnswerInput, parseRaiseInput, parseWithdrawInput } from "./validate.js";
import type {
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
}

/** The actor for what the inbox does itself (defaults, overdue marks, deliveries). */
const LAIR = "lair";
const DEFAULT_SWEEP_SECONDS = 30;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  private inflight = new Map<string, Promise<boolean>>();
  private sweeping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: DecisionInboxOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.events = options.events;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sweepSeconds = options.sweepSeconds ?? DEFAULT_SWEEP_SECONDS;
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Where credentials go, for the UI. */
  get secretStoreDescription(): string {
    return this.secrets.description;
  }

  // ============ PRODUCER INTERFACE ============

  async raise(input: RaiseDecisionInput): Promise<RaiseResult> {
    const parsed = parseRaiseInput(input, this.clock.now());
    if (!parsed.ok) {
      throw new DecisionError(400, `Invalid decision: ${parsed.errors.join("; ")}`);
    }
    const at = this.iso();
    const { decision, created, addedBlocks } = this.store.raise(parsed.value, at);
    const { module, ref } = decision.source;
    if (created) {
      const expiry = decision.expiresAt
        ? `; expires ${decision.expiresAt}${decision.defaultOptionId ? `, then ${decision.defaultOptionId} applies` : ", then it keeps waiting"}`
        : "";
      this.store.addAudit(decision.id, {
        at,
        action: "raised",
        actor: module,
        detail: `${decision.kind} decision raised by ${module} (${ref}), recommending ${decision.recommended.optionId}${expiry}`,
      });
      await this.events?.emit("decision.raised", {
        decisionId: decision.id,
        project: decision.project,
        kind: decision.kind,
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

  /** A human's answer. Validates it against the decision, stores it, then resumes the producer. */
  async answer(id: string, raw: AnswerInput): Promise<Decision> {
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

    const suppliesSecret = option.suppliesSecret === true;
    if (input.secret !== undefined && !suppliesSecret) {
      throw new DecisionError(
        400,
        decision.kind === "credentials"
          ? "secret: only an option that supplies the secret takes a value"
          : "secret: only credentials decisions take a secret",
      );
    }
    if (suppliesSecret) {
      const secret = input.secret;
      if (secret === undefined || secret.trim() === "") {
        throw new DecisionError(400, "secret: this option supplies the secret, so it needs the value");
      }
      if (input.note?.includes(secret)) {
        throw new DecisionError(400, "note: must not contain the secret");
      }
      try {
        await this.secrets.put(decision.secretName!, secret);
      } catch (e) {
        // Only our own error type is known to carry no value; say nothing else about others
        const why = e instanceof SecretStoreUnavailableError ? e.message : "it failed";
        throw new DecisionError(503, `The secret store could not take the secret: ${why}`);
      }
    }

    const by = input.by ?? "owner";
    const at = this.iso();
    const answer: DecisionAnswer = {
      optionId: option.id,
      ...(input.note ? { note: input.note } : {}),
      ...(suppliesSecret ? { secretSupplied: true } : {}),
    };
    if (!this.store.closeDecision(id, { status: "answered", at, answer, answeredBy: by })) {
      throw new DecisionError(409, `Decision is ${this.store.get(id)?.status ?? "closed"}, not open`);
    }
    const parts = [`chose ${option.id} (${option.label})`];
    if (suppliesSecret) parts.push(`the secret went to the secret store as ${decision.secretName}`);
    if (input.note) parts.push(`note: ${input.note}`);
    this.store.addAudit(id, { at, action: "answered", actor: by, detail: parts.join("; ") });
    await this.events?.emit("decision.answered", {
      decisionId: id,
      project: decision.project,
      kind: decision.kind,
      module: decision.source.module,
      optionId: option.id,
      by,
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
    if (!decision || decision.deliveredAt || !answer) return false;
    if (decision.status !== "answered" && decision.status !== "expired") return false;
    const outcome = decision.status === "expired" ? "expired" : "answered";
    const module = decision.source.module;
    const handler = this.handlerFor(module, decision.project);
    if (!handler) return false;
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
