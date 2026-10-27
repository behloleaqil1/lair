# Lair Roadmap

> What is built, what is next, and in which order. The design notes in this folder say *how* each part works; this
> file says *when* and *what must be true first*. Where this file and the code disagree, the code is right.

Lair's goal: a developer describes an application, or points Lair at a repository, and Lair runs the whole development
lifecycle with coding agents. The developer answers only the questions that are theirs (pricing, legal, spend,
accounts, credentials, go/no-go) in the Decision Inbox.

## Built

| Module | Spec | Code | What it does |
|---|---|---|---|
| Watchdog and playbooks | [autonomy.md §2](autonomy.md) | `src/server/watchdog/` | Detects stalls and known failure classes and runs playbooks (observe or act); escalations become decisions |
| Delivery | [autonomy.md §7](autonomy.md), [platform.md §10](platform.md) | `src/server/delivery/` | Docker Compose environments: status, Up/Down/Restart, holds, crash loops, deploy after a merge with rollback |
| Gate pipelines and runners | [runners.md](runners.md) | `src/server/gates/` | Pipelines as config; GitHub Actions first (self-hosted only for private repositories), the local machine last; minutes budget |
| Decision Inbox and owner credential | [autonomy.md §1](autonomy.md) | `src/server/decisions/`, `src/server/human-auth/` | The one place a human decides; owner-only actions need a signed-in browser session (header, not cookie) |
| Reviews and policy merge | [autonomy.md §5](autonomy.md) | `src/server/review/` | Risk tiers, reviewers per tier, approvals bound to the head commit, test integrity check, merge executor with an email allow-list |

In review (open pull requests): **agents** (claims, pid-owned locks, session recovery, failover, budgets;
[autonomy.md §6](autonomy.md)) and **triage** (failure classes, narrow re-checks, bisect and revert;
[autonomy.md §3](autonomy.md)). The planner's first step, Lair keeping fill's tasks file with a supervised planner
agent ([planner.md](planner.md), `src/server/planner/`), is in review too; step 1 below builds on it.

## Next, in order

Each step lists what must exist first. One module per pull request, each with its own acceptance tests.

| # | Module | Spec | Needs first | Acceptance (summary) |
|---|---|---|---|---|
| 1 | **Planner**: documents become work | [autonomy.md §4](autonomy.md) | agents, review | Cards extracted from a versioned document, each tracing to its section; dependencies and merge order; cards assigned to agents through the agents module |
| 2 | **Intake**: feature requests and bug reports | [autonomy.md §4a](autonomy.md) | planner, Decision Inbox | Requests from the UI, an in-app widget and importers become triaged cards or decisions; duplicates merged |
| 3 | **Lifecycle**: documents first | [autonomy.md §4b](autonomy.md) | planner, review | Audit, project plan, architecture and feature designs written by an author agent, critiqued by two reviewer agents (one a different model), open questions as decisions with recommended answers; docs PRs when a merge changes a boundary; a drift check |
| 4 | **Kickstart and projects** | [phase5-deploy.md §3](phase5-deploy.md), [platform.md §10, M5](platform.md) | lifecycle, planner, git-host integration | "New project": create or connect a repository, choose or detect a template, describe the product; Lair drafts the spec and plan for approval, then runs the build |
| 5 | **Importer**: take over an existing project | [autonomy.md §10](autonomy.md) | lifecycle (audit stage) | An existing repository and its scripts adopted with no downtime: audit first, then plan; shadow mode, then cutover with rollback |
| 6 | **lair-node**: run work on other machines | [node.md](node.md), [platform.md M1/M3](platform.md) | runners | A standard-library Go binary; the runners module's Lair-machines step; capacity reporting; unplugging a node reschedules its work |
| 7 | **Kubernetes and PaaS deploy targets** | [platform.md §10, M4](platform.md) | delivery | `helm upgrade` per role, rollout checks, `helm rollback`; strategies (rolling, blue-green, canary); promotion as a policy-gated step |
| 8 | **Knowledge and learning loop** | [autonomy.md §8](autonomy.md) | triage, review | Lessons from incidents and reviews turned into checks, playbooks and brief rules; a weekly digest |
| 9 | **Quality** | [quality.md](quality.md) | review, triage | Contracts, migration safety, honest health, spec conformance, exploratory and UX testing, performance and cost budgets, AI evaluations, a security pipeline, a quality scorecard |
| 10 | **Release** (for Lair itself) | [autonomy.md §9](autonomy.md), [platform.md M7](platform.md) | review | Packaging, signed releases, an SBOM, release notes, docs and examples |
| 11 | **Launch kit** (for the apps Lair builds) | [launch-kit.md](launch-kit.md) | quality, delivery | Billing and money, product analytics, the customer-facing surface, a feedback loop, launch readiness |
| 12 | **Teams and scale** | [platform.md M6](platform.md) | the rest | Postgres, roles and permissions, SSO, high availability, quotas |
| — | **Hands-off day** (end-to-end acceptance) | [autonomy.md §11](autonomy.md) | 1–5 at least | A project runs a full day with no human input except Decision Inbox answers |

## Rules every new module follows

The reviews of the first modules found the same classes of defect again and again. A new module meets these before
review:

1. **Every state-changing route names its caller.** The caller is one of three things:
   - the owner, through `src/server/human-auth/` (`requireOwner()`, with the route prefix added to
     `OWNER_ONLY_PREFIXES`);
   - an in-process producer interface;
   - a signed result (`gates/signature.ts`).

   A name in the request body, or the absence of an Origin header, proves nothing: any local process, including the
   agents Lair supervises, can send it.
2. **Agents are the untrusted party.** Never pass the server's environment, tokens or secrets to agent processes, and
   never trust text an agent writes (logs, usage lines, trailers, labels) as evidence of anything it gains from.
3. **Commands are argv arrays, never shell strings.** No value from a request, a file, a log or git becomes an option
   (refuse a leading `-`).
4. **Tests go through production code.** Fake only the process spawner, the clock and remote APIs. A test that would
   still pass with the feature removed is a defect, and so is wiring that exists only in tests.
5. **Bounded input.** Truncate lines before regular expressions, cap sizes, use iterative parsers, and give every
   command a timeout.
6. **Restarts are part of the design.** State that matters is in the store with a schema version and a migration.
   Operations interrupted by a restart are resumed or rolled back, never left half done.
7. **No private details and no AI attribution** in code, tests, docs or commits ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
8. **CI is the test runner.** Typecheck, lint, tests and build on Node 22 and 24 must be green before review.

## UI consolidation (when a project's agents move to Lair)

Some views exist twice because Lair grew next to the tools it replaces: the old view shows the state the previous
launcher keeps, and the new one shows Lair's. They stay apart while both run, so the owner can see each, and they merge
once a project's agents run under Lair.

| Today | After the move |
|---|---|
| **Dragons** (the roster; Start and Stop through the project's own start command) and **Agents** (runs Lair supervises) | One **Dragons** view with Lair's state per agent: claim, recoveries, budget; Start and Stop through Lair |
| **PRs** (mergeable and gate) and **Reviews** (tier, reviewers, findings, merge policy) | One **Pull requests** view; "merge ready" comes from the review policy |
| **Inbox** (the owner's message file) and **Decisions** | **Decisions** only; owner messages go through the command bar |
| **Orchestrator** (an external orchestration loop) | Removed once that loop's duties (reviews, merges, triage) run in Lair |
| **Machines** (SSH machines) and **Nodes** (lair-node) | One **Machines** view once lair-node runs jobs |
| **Processes** (the previous launcher's helper loops) | Only the processes Lair supervises; retired loops disappear |
| **Gates** (an external gate queue) and **Pipelines** | One **Gates** view once the project's gates run as Lair pipelines |
