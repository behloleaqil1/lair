/**
 * Decision policies, shadow only (docs/design/decision-policies.md §3 and §5): the policy table
 * (data/policies.yaml), the rule proposer, the policy trace and the agreement view. Nothing here answers,
 * withdraws or raises a decision. Owner-only route: GET /api/owner/decision-policies.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EventBus } from "../../core/event-bus.js";
import type { HumanAuth } from "../../human-auth/index.js";
import { rejectCrossSiteRequests } from "../../origin.js";
import type { DecisionInbox } from "../service.js";
import type { DecisionPoliciesStatus } from "../../../shared/decision-types.js";
import { agreementRows } from "./agreement.js";
import { RuleProposer } from "./rules.js";
import { PolicyShadow, shadowSource } from "./shadow.js";
import { loadPolicyTable } from "./table.js";
import type { PolicyTable } from "./types.js";

export { agreementRows } from "./agreement.js";
export { RuleProposer } from "./rules.js";
export { PolicyShadow, shadowSource } from "./shadow.js";
export { DEFAULT_POLICIES_YAML, loadPolicyTable, parsePolicyTable } from "./table.js";
export type { AgreementRow } from "./agreement.js";
export type { PolicyTable, Proposal, Proposer } from "./types.js";

export interface MountDecisionPoliciesOptions {
  /** data/policies.yaml; the built-in table when it does not exist */
  policiesPath: string;
  inbox: DecisionInbox;
  events: EventBus;
  humanAuth: HumanAuth;
  clock?: () => Date;
  log?: (line: string) => void;
}

export class DecisionPolicies {
  /** Read once at start: a change to the file takes effect at the next start */
  private readonly table: PolicyTable;
  private readonly source: "file" | "built-in";
  private readonly shadow: PolicyShadow;

  constructor(private readonly options: Omit<MountDecisionPoliciesOptions, "humanAuth">) {
    const loaded = loadPolicyTable(options.policiesPath);
    this.table = loaded.table;
    this.source = loaded.source;
    const inbox = options.inbox;
    this.shadow = new PolicyShadow(
      shadowSource({
        get: (id) => inbox.get(id),
        list: (o) => inbox.list(o),
        recordPolicyTrace: (row) => inbox.recordPolicyTrace(row),
        hasPolicyTrace: (id, proposer, version) => inbox.hasPolicyTrace(id, proposer, version),
      }),
      () => [new RuleProposer(() => this.table)],
      options.clock,
      options.log,
    );
    for (const error of this.table.errors) options.log?.(`decision policies: ${error}`);
  }

  subscribe(): () => void {
    this.shadow.catchUp();
    return this.options.events.on("decision.raised", (event) => this.shadow.onRaised(event.data));
  }

  status(): DecisionPoliciesStatus {
    return {
      source: this.source,
      version: this.table.version,
      policies: this.table.policies.map((p) => ({ id: p.id, class: p.class, codes: p.codes, answer: p.answer, state: p.state, maxTier: p.maxTier })),
      errors: this.table.errors,
      agreement: agreementRows(this.options.inbox.policyTraces()),
    };
  }
}

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

export async function mountDecisionPolicies(fastify: FastifyInstance, options: MountDecisionPoliciesOptions): Promise<DecisionPolicies> {
  const policies = new DecisionPolicies(options);
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = options.humanAuth.requireOwner("Only a browser signed in as the owner can see the decision policies");
    app.get("/api/owner/decision-policies", { onRequest: owner }, async (_request, reply: FastifyReply) => {
      return reply.header("cache-control", "no-store").send(respond(policies.status()));
    });
  });
  const unsubscribe = policies.subscribe();
  fastify.addHook("onClose", async () => unsubscribe());
  return policies;
}
