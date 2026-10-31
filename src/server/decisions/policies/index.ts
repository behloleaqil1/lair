/**
 * Decision policies, shadow only (docs/design/decision-policies.md §3 and §5): the policy table
 * (data/policies.yaml), the rule proposer, the policy trace and the agreement view. Nothing here answers,
 * withdraws or raises a decision. Off unless data/server.yaml sets `decision_policies.enabled`: while off,
 * nothing is proposed or traced, no module updates a raised decision's evidence, and the owner-only route
 * GET /api/owner/decision-policies shows the table and that it is off.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EventBus } from "../../core/event-bus.js";
import type { HumanAuth } from "../../human-auth/index.js";
import { rejectCrossSiteRequests } from "../../origin.js";
import type { ServerConfigFileOptions } from "../../restart/server-config.js";
import type { DecisionInbox } from "../service.js";
import type { DecisionPoliciesStatus } from "../../../shared/decision-types.js";
import { agreementRows } from "./agreement.js";
import { loadDecisionPoliciesConfig } from "./config.js";
import { RuleProposer } from "./rules.js";
import { PolicyShadow, shadowSource } from "./shadow.js";
import { loadPolicyTable } from "./table.js";
import type { PolicyTable } from "./types.js";

export { agreementRows } from "./agreement.js";
export { DECISION_POLICIES_OFF, loadDecisionPoliciesConfig, parseDecisionPoliciesConfig } from "./config.js";
export { RuleProposer } from "./rules.js";
export { PolicyShadow, shadowSource } from "./shadow.js";
export { DEFAULT_POLICIES_YAML, loadPolicyTable, parsePolicyTable } from "./table.js";
export type { AgreementRow } from "./agreement.js";
export type { PolicyTable, Proposal, Proposer } from "./types.js";

/**
 * A module that re-evaluates the evidence of decisions it raised (`cause_cleared`, `linked_issue`) for the
 * rules: the agents module. It does so only while the decision policies are on.
 */
export interface EvidenceUpdates {
  useEvidenceUpdates(on: boolean): void;
}

export interface MountDecisionPoliciesOptions {
  /** data/server.yaml: off unless it sets decision_policies.enabled */
  configPath: string;
  /** data/policies.yaml; the built-in table when it does not exist */
  policiesPath: string;
  inbox: DecisionInbox;
  events: EventBus;
  humanAuth: HumanAuth;
  /** Turned on only while the policies are on */
  evidenceProducers?: EvidenceUpdates[];
  fileOptions?: ServerConfigFileOptions;
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface DecisionPoliciesOptions {
  policiesPath: string;
  inbox: DecisionInbox;
  events: EventBus;
  /** false: subscribe() does nothing, and status() reads no trace */
  enabled: boolean;
  /** Why data/server.yaml's section was refused (shown with the table) */
  configErrors?: string[];
  clock?: () => Date;
  log?: (line: string) => void;
}

export class DecisionPolicies {
  /** Read once at start: a change to the file takes effect at the next start */
  private readonly table: PolicyTable;
  private readonly source: "file" | "built-in";
  private readonly shadow: PolicyShadow;
  /** The catch-up of the last subscribe(): resolves with the rows it wrote */
  caughtUp: Promise<number> = Promise.resolve(0);

  constructor(private readonly options: DecisionPoliciesOptions) {
    const loaded = loadPolicyTable(options.policiesPath);
    this.table = loaded.table;
    this.source = loaded.source;
    const inbox = options.inbox;
    this.shadow = new PolicyShadow(
      shadowSource({
        get: (id) => inbox.get(id),
        openPage: (after, limit) => inbox.openClassified(after, limit),
        recordPolicyTrace: (row) => inbox.recordPolicyTrace(row),
        hasPolicyTrace: (id, proposer, version) => inbox.hasPolicyTrace(id, proposer, version),
      }),
      () => [new RuleProposer(() => this.table)],
      options.clock,
      options.log,
    );
    for (const error of this.table.errors) options.log?.(`decision policies: ${error}`);
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Propose for each decision raised from now on, and catch up on the open ones in the background. Returns
   * the unsubscribe, which also stops the catch-up. Off: does nothing.
   */
  subscribe(): () => void {
    if (!this.options.enabled) return () => undefined;
    let stopped = false;
    const unsubscribe = this.options.events.on("decision.raised", (event) => this.shadow.onRaised(event.data));
    this.caughtUp = this.shadow.catchUp({ stopped: () => stopped });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  status(): DecisionPoliciesStatus {
    return {
      enabled: this.options.enabled,
      source: this.source,
      version: this.table.version,
      policies: this.table.policies.map((p) => ({ id: p.id, class: p.class, codes: p.codes, answer: p.answer, state: p.state, maxTier: p.maxTier })),
      errors: [...(this.options.configErrors ?? []), ...this.table.errors],
      agreement: this.options.enabled ? agreementRows(this.options.inbox.policyAgreement()) : [],
    };
  }
}

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

export async function mountDecisionPolicies(fastify: FastifyInstance, options: MountDecisionPoliciesOptions): Promise<DecisionPolicies> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const config = loadDecisionPoliciesConfig(options.configPath, options.fileOptions);
  if (!config.ok) for (const error of config.errors) log(`decision policies off: ${error}`);
  const enabled = config.ok && config.settings.enabled;
  const policies = new DecisionPolicies({
    policiesPath: options.policiesPath,
    inbox: options.inbox,
    events: options.events,
    enabled,
    configErrors: config.ok ? [] : config.errors,
    clock: options.clock,
    log,
  });
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = options.humanAuth.requireOwner("Only a browser signed in as the owner can see the decision policies");
    app.get("/api/owner/decision-policies", { onRequest: owner }, async (_request, reply: FastifyReply) => {
      return reply.header("cache-control", "no-store").send(respond(policies.status()));
    });
  });
  if (!enabled) return policies;
  const unsubscribe = policies.subscribe();
  for (const producer of options.evidenceProducers ?? []) producer.useEvidenceUpdates(true);
  fastify.addHook("onClose", async () => {
    unsubscribe();
    for (const producer of options.evidenceProducers ?? []) producer.useEvidenceUpdates(false);
  });
  return policies;
}
