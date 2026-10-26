# Lair quality control: apps good enough to sell

Status: planned, not built. Lair itself is open source; it aims to help build applications that are good enough to
sell. This note covers how Lair makes sure what its agents build actually works. [launch-kit.md](launch-kit.md)
covers what else a product needs before it can be sold. Both extend [autonomy.md](autonomy.md) (policy merge §5,
triage §3, lifecycle §4b).

## 0. Principles
1. **Enforced by code at merge time, not by prompts.** Each check produces structured findings; policy decides which
   ones block at which tier.
2. **Stack plugins.** Each check has a generic core plus per-stack plugins (e.g. Java/Spring, TypeScript/React/Next,
   Python/FastAPI, Go). An app pack enables the plugins for its stacks, and Lair suggests them from the repository.
3. **Every check proves itself.** A check ships with a seeded-defect fixture: a tiny app containing exactly the
   defect it must catch, and a clean twin it must pass (§16).
4. **Four places checks run:** preflight (seconds, before a gate), PR gate, nightly, pre-release. The policy sets
   where each check runs and whether it blocks.

## 1. Test integrity guard
- Blocks a merge that deletes or skips tests, loosens assertions (e.g. an exact match becoming "not null", or a
  widened tolerance), adds exclusions or ignore entries, lowers coverage or performance thresholds, or catches and
  ignores errors in test code.
- Override only through a red-tier review plus a Decision Inbox item that states why.

## 2. Tests that catch bugs
- **Changed-line coverage:** a minimum per tier (defaults: red 90%, amber 80%, green 60%).
- **Mutation testing:** on the changed code nightly and on red-tier PRs (stack plugins such as PIT, Stryker,
  mutmut). Surviving mutants become tasks.
- **Property-based tests are required** for money, time zones, currencies, quotas and parsers (the design template
  flags them).

## 3. "Every X has a Y" invariants
- Lair builds an inventory from the code: routes, tables, background jobs, events, settings.
- An app pack declares invariants over that inventory. Examples:
  - every route has an authorisation test, a tenant-isolation test, an input-validation test and an audit entry;
  - every table has an owner scope and a retention rule;
  - every job has an actor and an idempotency key.
- A new route or table without its cases fails the gate and names exactly what is missing.

## 4. Contracts between parts
- **API:** the schema is generated from code, and a breaking change needs a version bump or a decision.
- **Consumer contracts:** contract tests between frontend, backend, workers and external services check paths,
  field names and casing, types, nullability and error shapes. An empty-because-misnamed field fails.
- **Config contract:** every setting or environment variable the code reads must be defined for every environment
  (dev, CI, containers, cluster manifests), and everything defined must be read somewhere. Names must match exactly.
  A secret with a hard-coded default fails outside local/test.

## 5. Framework misconfiguration rules
- Stack rule packs catch features that silently do nothing. Examples: caching or method-security annotations without
  the switch that enables them, a scheduler that is never enabled, a duplicate bean definition masked by an override
  flag, a duplicate migration version, a route prefix mismatch between client and server.
- Each rule cites the framework doc it comes from.

## 6. Database migration safety
- Versions are unique and ordered, and checked against the planner's allocated ranges.
- Changes are expand/contract (backward compatible with the running version).
- Lock-risk analysis covers large tables and indexes.
- Every migration has a tested rollback or forward-fix, plus a dry run on a production-shaped snapshot before
  release.

## 7. Honest health and errors
- A health endpoint must exercise its real dependencies, e.g. a model loaded or the database reachable. One that
  always says "healthy" fails a fault-injection test.
- An error must never come back as success: HTTP 200 with `success:false`, or swallowed exceptions, are flagged.

## 8. Spec conformance
- Before review, an agent maps every acceptance criterion of the task card to the code and to a test that proves it.
  A criterion with no test, or a change outside the card's scope, returns the PR to its author.

## 9. Real use: exploratory testing and UX
- An **exploratory tester agent** drives the running app in a real browser through every user journey of the project
  plan. It also tries edge and abuse inputs, and files bugs through intake ([autonomy.md](autonomy.md) §4a) with screenshots,
  console errors and steps.
- **UX checks:**
  - screenshot diffs per page and state;
  - accessibility to WCAG 2.2 AA (automated plus agent review);
  - empty, loading, error and permission-denied states present on every view;
  - copy review (clarity, tone, typos);
  - responsive breakpoints, and i18n readiness when the pack enables it.

## 10. Performance and cost budgets
- Response-time budgets per endpoint (p95), page-speed and Web Vitals budgets per page, bundle size, queue
  throughput, and cost per request for AI and third-party calls.
- Each is compared with the last release's baseline, and a regression beyond the tolerance blocks.
- Load tests on hot paths run nightly at the target scale from the plan.

## 11. AI feature evaluations
- Every prompt, model or retrieval change runs the feature's evaluation set: reference cases, rubric scoring by a
  judge model of a different vendor, prompt-injection and data-leak cases, and latency and cost budgets.
- A score drop beyond the tolerance blocks. Fallback behaviour is tested with the model down.

## 12. Security pipeline
- Code scanning and secret scanning; dependency vulnerability and licence scans; container image and IaC scans.
- Attack tests against staging, e.g. a baseline scanner plus an abuse-case agent per feature.
- An authorisation matrix test (every role × every route).
- A threat-model section (assets, threats, mitigations) required in every red-tier design.
- Pinned dependencies and image digests, an SBOM per release.

## 13. Production readiness
Before a service's first release:
- structured logs, metrics and traces exist;
- an alert exists for each service-level target, with a runbook per alert;
- an automated backup-and-restore drill passes;
- a kill switch exists for each risky feature;
- the gradual rollout has automatic rollback on error-rate and latency comparison.

Lair verifies each item with evidence, not a checkbox.

## 14. Quality scorecard and routing
- Tracked per project, per agent and per model:
  - escaped defects (bugs found after merge by humans, customers or production);
  - change-failure rate, rework rate, flake rate;
  - review-finding density, time to green.
- The scheduler gives each task type to the agent and model with the best recent score for it. A quality trend shows
  in the daily digest.

## 15. Flaky tests
- A test that fails and then passes on the same commit is quarantined automatically: it still runs, it no longer
  blocks, and it gets a reliability task with a deadline.
- Quarantine is capped per project. Over the cap, new feature work in that area pauses.

## 16. Acceptance
- A **seeded-defect suite**: a demo app per supported stack, with one branch per check, each containing exactly that
  check's defect.
  - Every check catches its defect, and the clean app passes all of them.
  - The suite runs in Lair's own CI, so a check can never silently stop working.
