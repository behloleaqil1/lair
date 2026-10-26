# Lair launch kit: from working app to sellable product

Status: planned, not built. Lair itself is open source; this note is about the applications it helps build.
[quality.md](quality.md) makes the app work. This note covers everything else a product needs before people can buy
it. Each kit is a set of templates plus checks: the lifecycle module ([autonomy.md](autonomy.md) §4b) writes a design
from the template, the planner turns it into cards, and the checks verify it with evidence.

## 0. Launch readiness
- One checklist per product (lifecycle stage 9), generated from the kits the app pack enables. Each item needs
  evidence (a passing check, a link, a document version), not a tick.
- The Launch view shows a readiness score per kit and the blocking items. "Go/no-go" is a `release` decision, the
  last one.

## 1. Billing and money
- Plans, entitlements, trials, upgrades and downgrades, proration, invoices, tax, failed-payment retries, refunds and
  cancellations, through a payment-provider plugin.
- Money paths are idempotent (retries never double-charge), and webhooks are verified and replay-safe.
- Property-based tests cover amounts, currencies and periods. A daily reconciliation job compares provider records
  with the app's ledger and opens an incident on any difference.
- Entitlements are enforced on the server and covered by the "every X has a Y" invariants ([quality.md](quality.md) §3).

## 2. Product analytics
- An event plan per user journey: activation, retention, conversion, and the north-star metric.
- Events are typed and tested: a journey test asserts that its events fire. Funnels and dashboards are generated, and
  analytics respects consent.

## 3. Customer-facing surface
- Marketing site with SEO basics, pricing page, sign-up and onboarding to the first value moment.
- Help docs generated from the features, kept true by the drift check. In-app help.
- Changelog and customer release notes generated from merges and approved as docs PRs.
- Status page fed by health checks. A support inbox with ticket intake.
- Transactional email deliverability: SPF, DKIM and DMARC checked, bounce and complaint handling, unsubscribe where
  the law requires it.

## 4. Customer feedback loop
- The feedback widget ([autonomy.md](autonomy.md) §4a) also in production for signed-in customers, with consent. Feature-request
  voting, and NPS or CSAT prompts.
- All of it flows into intake, then the planner. Customers whose request shipped get notified.

## 5. Trust and compliance
- **Data map:** what personal data is stored, where, why, for how long and who processes it. It's generated from the
  schema plus annotations and kept true by the drift check.
- **Privacy operations:** data export and deletion requests are tested end to end; retention jobs are tested;
  personal data never appears in logs (a log scanner).
- **Evidence for business buyers:** Lair's signed record of every task, review, gate, merge and deploy is
  change-management evidence. Also access reviews, backup-restore drill results, a staging penetration test report,
  the uptime history from the status page, and prepared answers to common security questionnaires.
- Regulation packs per domain (e.g. email marketing, payments, health), each adding checks and checklist items.

## 6. Legal documents
- Drafts of terms of service, privacy policy, data processing agreement, cookie notice, subprocessor list, and an
  open-source licence report from the dependency scan.
- Drafts stay consistent with the data map and the actual integrations. A change to either flags the affected
  document.
- Every legal document is a `legal` decision: the human approves it, and Lair recommends a lawyer's review. Lair never
  publishes one on its own.

## 7. Market, positioning and pricing
- A research agent produces a competitor scan, positioning, an ideal-customer profile and pricing options with
  reasoning, with sources cited.
- Pricing is a `product` decision with a recommended answer, never automatic.

## 8. Experiments
- Feature flags with kill switches, A/B tests with a pre-registered metric and sample size, automatic analysis, and a
  recommendation to ship or revert as a decision.

## 9. Launch and after
- Beta and waitlist flows, a launch-day runbook, and watch dashboards. Lair's watchdog ([autonomy.md](autonomy.md) §2) runs
  production too: incidents, automatic rollback, customer-facing status updates, and postmortems.

## 10. What always stays human
These arrive only as Decision Inbox items with a recommended answer:
- pricing;
- legal approval;
- spending and creating accounts (payment provider, domains, cloud, app stores);
- the first production credentials;
- go/no-go.

## 11. Acceptance
- The demo app goes from a one-paragraph description to a launch checklist that is green with evidence for every
  enabled kit.
- The only human actions are the decisions in §10, and the billing reconciliation catches a seeded ledger mismatch.
