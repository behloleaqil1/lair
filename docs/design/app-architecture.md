# The architecture stage: how Lair designs the applications it builds

> Status: design. Roadmap: [ROADMAP.md](ROADMAP.md) C3 (lifecycle, documents first) and C4 (kickstart). Related:
> [autonomy.md §4b](autonomy.md), [quality.md](quality.md), [ai-roles.md](ai-roles.md).

An enterprise-grade application starts with decisions, not code. Before any builder agent writes a line, Lair runs an
architecture stage. It turns the requirements into quality attributes, weighs real alternatives, records each
decision as an ADR, chooses the stack, and produces a reference architecture that the later stages build to and are
checked against. The stage is done by agents (an architect role, critiqued by reviewer roles), with the owner deciding
only what is theirs: cost, risk appetite, vendors, compliance.

## What the stage produces

| Artifact | Contents |
|---|---|
| **Requirements and quality attributes** | Functional scope, users and load (now and in 2 years), and quality attributes as measurable scenarios ("p95 search under 300 ms at 200 req/s", "RPO 5 min", "tenant data isolated"), constraints (budget, team, regulation, data residency) |
| **Options and trade-offs** | 2-4 candidate architectures scored against the quality attributes (a lightweight ATAM: sensitivity points, risks, non-risks), with a recommendation and why the others lost |
| **ADRs** | One per decision, in the MADR format: context, the options, the decision, consequences, status, and links to the requirement it serves. ADRs are versioned in the repo (`docs/adr/`); a later change supersedes an ADR, never edits it |
| **Stack** | Language and frameworks, data stores, messaging, identity, observability, CI/CD, hosting, each with its ADR. Chosen for the requirements and the team's AI tools, not by habit |
| **Reference architecture** | C4-model diagrams (context, containers, components), module and service boundaries, data ownership, the API style (REST, gRPC, events), tenancy, security model (threat model, STRIDE), and the deployment topology |
| **Fitness functions** | The decisions made executable: architecture tests (dependency rules, layering, no cycles), performance and cost budgets, security checks. Run in every gate, so drift is caught at the PR that causes it |
| **Delivery blueprint** | The infrastructure as code, pipelines and environments the kickstart creates (below) |

## The range of architectures Lair can choose and build

Lair recommends what fits; it has no favourite. Each style below has a blueprint: an ADR template, a reference
layout, fitness functions and a delivery setup.

- **Modular monolith:** the default for most new products. One deployable with enforced module boundaries, so it can
  split later.
- **Microservices:** when independent scaling, team autonomy or fault isolation justify the cost. Service boundaries
  come from the domain (bounded contexts); there is a contract per service, consumer-driven contract tests, a service
  mesh only when needed, and data owned per service.
- **Event-driven and streaming:** queues and logs (Kafka, NATS, RabbitMQ, cloud queues), outbox and sagas,
  idempotency, replay.
- **Serverless and edge:** functions and managed services where load is spiky or the team is small.
- **AI-native components:**
  - retrieval (RAG) with an evaluation set;
  - agent workflows with guardrails and tool permissions;
  - model serving or hosted APIs;
  - prompt and model versioning;
  - evaluation gates (accuracy, cost, latency) in CI, as in [quality.md](quality.md).
- **Data:**
  - relational first, document, search, cache and time-series where a requirement asks for them;
  - migrations with safety checks;
  - multi-tenancy (row-level security, schema or database per tenant) chosen by ADR.
- **Hosting:**
  - Kubernetes (Helm or Kustomize, autoscaling, rollouts and rollback; roadmap C7);
  - PaaS (Fly, Render, Cloud Run, App Runner);
  - VMs with Compose;
  - IaC with Terraform or OpenTofu.

  Environments: preview per PR, staging, production.
- **Cross-cutting concerns:**
  - identity (OIDC, SSO), secrets management;
  - observability (OpenTelemetry traces, metrics, logs, SLOs and alerts);
  - product analytics (roadmap C10);
  - backups and DR;
  - cost budgets.

## How the stage runs

1. **Gather.** The architect agent drafts requirements and quality attributes from the owner's description (or from
   the importer's audit of an existing repository) and asks the owner only for what it cannot infer. This happens as
   one Decision Inbox item with all the questions.
2. **Propose.** Options and a recommendation, the draft ADRs and the stack.
3. **Critique.** Two reviewer roles, one on a different AI tool or model where the team has one, challenge each ADR
   against the quality attributes. Their findings are answered in the ADR or sent back.
4. **Decide.** Choices with cost, vendor or risk weight go to the owner as decisions, each with the trade-off in one
   paragraph. The rest are accepted by the review policy.
5. **Freeze and enforce.** The reference architecture and fitness functions are merged first. From then on every
   gate runs the fitness functions, and the planner (C1) cuts the build into cards along the module and service
   boundaries.
6. **Evolve.** A change that breaks a fitness function, or a new requirement, starts a new ADR (superseding the old
   one) through the same propose-critique-decide loop. The supervisor flags drift it sees in gates and reviews.

## Acceptance (summary)

- From a one-page product description, Lair produces the full artifact set in the repository, with every ADR linked
  to a requirement and at least two options considered for each significant decision.
- The same description with different quality attributes (e.g. 50 users vs 5 million, one region vs data residency in
  three) leads to different, justified architectures. That is checked on a fixed evaluation set of product briefs.
- Each blueprint (modular monolith, microservices on Kubernetes, serverless, an AI-native service) kickstarts a
  repository whose first pipeline passes, with fitness functions failing a PR that breaks a recorded decision.
