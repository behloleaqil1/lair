# Importer: Lair takes over an existing project

> Status: design. Roadmap: [ROADMAP.md](ROADMAP.md) C5. Builds on [autonomy.md §10](autonomy.md). Related:
> [app-architecture.md](app-architecture.md) (architecture recovery), [ai-roles.md](ai-roles.md), [settings-v2.md](settings-v2.md).

Most teams don't start from zero: they have a repository, a CI, scripts, environments and people. The importer
adopts all of that **without downtime and without breaking the team's current way of working**: audit first, then a
proposed setup, then shadow mode, then cutover in stages, each one reversible. Lair's first project was adopted by
hand over several weeks (an external gate queue, its own launch scripts, a hand-written config). The importer makes
that a guided process that takes hours.

## Stages

### 1. Connect (read-only)
- **Sources:** a local path, or a repository on GitHub, GitLab, Bitbucket or a plain git remote.
- **Access:** read-only at first; write access is requested only at cutover. Credentials follow
  [ai-roles.md](ai-roles.md)'s rules: the git host's own CLI login, or a token in the secret store, never in YAML.

### 2. Discover and audit
The discovery is deterministic and in code: file markers, lockfiles, CI files, Dockerfiles, charts. Agents summarise
and explain on top of it; they don't do the detecting.

| Area | What Lair finds |
|---|---|
| **Stack** | Languages, frameworks, build tools and package managers per directory (monorepos too), runtime versions |
| **How it's built and tested** | The real commands: from the CI config (GitHub Actions, GitLab CI, Jenkins, CircleCI), Makefiles, package scripts and READMEs. The test suites, their duration, and flaky tests from recent CI history |
| **How it ships** | Dockerfiles, Compose, Kubernetes manifests and Helm, Terraform/OpenTofu, PaaS configs; environments and how a deploy is triggered |
| **How the team works** | Branch model, PR rules and branch protection, CODEOWNERS, commit conventions, release tags, issue tracker |
| **Health** | Dependency vulnerabilities, secrets in history, test coverage gaps, failing or skipped tests on main, migrations, licence issues |
| **Architecture recovery** | Modules and services and their dependencies, data stores, APIs. A C4 sketch, the implicit decisions written up as ADRs marked "recovered", and the hot spots (churn × complexity) |
| **Risk map** | The paths that touch auth, billing, data, migrations, infrastructure and security become the RED/AMBER/GREEN review tiers |

The output is an **audit report** in the repository (`docs/lair/audit.md`): what was found, what's risky, and what
Lair recommends fixing first.

### 3. Propose the setup
From the audit, Lair proposes a complete project configuration, shown in Settings v2 as a reviewable draft:
- **Gate pipelines** that wrap the project's existing commands. Its CI stays the source of truth; nothing is
  rewritten.
- **Review tiers** from the risk map, with reviewers from the AI roles.
- **Agents** and their roles; delivery targets from what ships today; fitness functions from the recovered
  architecture.
- **A first backlog:** open issues, audit findings and TODOs, as cards for the planner (C1).

The owner accepts, edits or rejects each part. One Decision Inbox item lists the questions Lair could not answer
itself.

### 4. Shadow mode
Lair runs beside the team's process for an agreed period (default: 2 weeks, or N PRs):
- **Gates:** for every PR (human or agent), Lair runs its gates and reviews in observe mode and compares them with
  the existing CI and the human reviews. A disagreement is a finding: a missing test command, a flaky suite, a
  review Lair would have missed.
- **Agents** work only on GREEN cards, on branches, through normal PRs that the team reviews.
- **A shadow report** gives agreement rates and the gaps to fix before cutover.

### 5. Cutover, in stages
Each stage is an owner decision, needs the shadow report's thresholds, and can be undone with one click:

| Stage | What changes |
|---|---|
| Gates | Lair's gates become required checks (beside the existing CI or instead of it) |
| Reviews | Lair's reviewers fill required review slots per tier; humans stay on RED if the owner wants |
| Merges | The merge policy merges what passes |
| Planning | The planner turns the backlog into cards (C1) |
| Delivery | Lair runs deploys (C7) |

Humans keep working throughout: Lair respects branch protection, CODEOWNERS and human PRs, and never force-pushes
or rewrites history.

### 6. Rollback
Undoing any stage restores the previous required checks and settings exactly; history is kept. Removing Lair
entirely leaves the repository as it was, plus the docs it added.

## What makes an adoption succeed

These come from adopting Lair's first project by hand. Each was a problem there before it was a section here.

### A baseline before agents touch code
- **Main must be green, or its failures known.** The importer runs the full suite on main first. Every failure is
  recorded as *pre-existing*, so triage never blames an agent's PR for it, and the first cards fix main.
  - In the first adoption, main failed a docs-catalogue test for a day unnoticed, and every PR's gate inherited the
    failure.
  - A nightly main check keeps this true after cutover.
- **Flaky tests are measured, not guessed:** from CI history and a few repeated runs. They are quarantined into a list
  the gates know about, and each gets a fix card.
- **A safety net where there is none:** hot spots with no tests (high churn, low coverage) get characterisation tests
  before agents change them.

### The project's knowledge, written down
- **A knowledge base in the repository** (`docs/lair/`). Agents read it in every brief, and it is kept current as
  PRs merge:
  - conventions (code style, patterns, naming, test style, error handling, commit and PR rules);
  - a domain glossary;
  - the recovered architecture and ADRs;
  - "how to run X locally";
  - known pitfalls.
- **Learned from the team's own history:** what reviewers flag again and again in past PRs becomes the reviewer
  checklist for this project, and repeated agent mistakes become brief rules (the learning loop, C8).

### A reproducible environment
- **The project runs the same way for agents and gates as for people.** The importer:
  - finds or writes a dev environment (devcontainer, Compose services, Nix);
  - maps `.env.example` to the secret store;
  - starts the services the tests need (databases, caches, queues).
- **Capacity planning:** from the measured suite durations, Lair estimates gate minutes per day at the target pace
  and recommends runners (CI minutes, a second machine, a node). Then the first week isn't spent waiting on one
  machine.

### Work in flight and the team's tools
- **Open PRs and branches** are listed. Each is adopted (Lair runs gates and reviews on it), left to its human
  author, or closed, by the owner's decision.
- **Issue trackers** (GitHub Issues, Jira, Linear) are connected two-way. Cards link to issues, and issue updates
  flow back.
- **People and roles:** owners, reviewers and CODEOWNERS are mapped to the review tiers. Notifications go where the
  team is (Slack, Teams, e-mail, ntfy). Agent PRs are labelled.
- **Freeze windows and working hours** are respected: no merges during a release freeze, and RED merges only while a
  human reviewer is around, if the owner wants that.

### Proof it works: metrics before and after
- **A baseline is taken at audit time from history:**
  - the DORA metrics: lead time, deploy frequency, change failure rate, time to restore;
  - PR cycle time, reverts, escaped bugs and test health.
- **A weekly report compares** the baseline with the period since cutover, plus the cost (AI usage and gate minutes
  per merged PR).
- **The first Lair PR is a dry run:** a docs-only change that goes through push, gates, review and merge, to prove
  the whole path before real work does.

### Scale, many repositories, legacy code
- **Large codebases:** discovery and architecture recovery work in slices (per module or service, hot spots first),
  with a code index so agents search it in seconds instead of scanning it.
  - In the first adoption, a search across 69 checkouts hung a planner run for 45 minutes.
- **Several repositories as one system:** a polyrepo is adopted as one project with cross-repo contracts and
  consumer-driven contract tests, so a change in one repository gates against its consumers.
- **Partial adoption:** one service or directory of a monorepo can be adopted first, and the rest later.
- **Legacy stacks** with little tooling get the same stages. Where Lair can't run something automatically, it says so
  in the audit and asks for the command instead of guessing.

### Data, security and compliance
- **Sensitive data:** discovery flags personal data (schemas, fixtures, logs), licences and data-residency
  constraints. Sensitive paths can be excluded from agents entirely (a deny list), and secrets never enter an agent's
  context.
- **Continuous re-audit:** the audit re-runs monthly and on large changes. It reports drift from the ADRs, new
  vulnerabilities and growing hot spots as cards.

## Acceptance (summary)
- An evaluation set of public repositories adopted end to end into shadow mode, each with the correct build and test
  commands found and the first gate passing:
  - a Java/TypeScript monorepo, a Python web app, Go microservices on Kubernetes, a Rails app and a Node service with
    Terraform.
- The audit finds the planted defects in a seeded test repository: a secret in history, a skipped test on main, a
  vulnerable dependency and a migration without a test.
- Before cutover, main's pre-existing failures and flaky tests are recorded, and none of them fails an agent PR in
  shadow mode.
- The knowledge base exists and is cited in agent briefs. The weekly report shows the before/after DORA metrics.
- Shadow mode reports agreement with the existing CI per PR. Cutover of each stage is reversible in a test that
  restores the exact previous configuration.
