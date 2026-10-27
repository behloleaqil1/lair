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

## Acceptance (summary)
- An evaluation set of public repositories adopted end to end into shadow mode, each with the correct build and test
  commands found and the first gate passing:
  - a Java/TypeScript monorepo, a Python web app, Go microservices on Kubernetes, a Rails app and a Node service with
    Terraform.
- The audit finds the planted defects in a seeded test repository: a secret in history, a skipped test on main, a
  vulnerable dependency and a migration without a test.
- Shadow mode reports agreement with the existing CI per PR. Cutover of each stage is reversible in a test that
  restores the exact previous configuration.
