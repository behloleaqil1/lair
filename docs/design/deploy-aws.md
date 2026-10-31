# Cloud deployment: how Lair runs application environments

Goal: Lair provisions, updates and monitors a project's cloud environments—preview, staging and
production—through code, with cost estimates before every change, gated reviews, and a hard money limit. This extends
[cloud-accounts.md](cloud-accounts.md) (account connection), [cloud-runners.md](cloud-runners.md) (on-demand machines),
and [phase5-deploy.md](phase5-deploy.md) (application deployment). Status: planned.

## 0. Principles

1. **Infrastructure as code.** Every resource is defined in versioned configuration; manual console changes are
   drift, detected and reported.
2. **Plan → cost → review → apply.** A change shows its cost estimate before review; production changes and cost
   increases above a threshold need owner approval in the Decision Inbox.
3. **Agents never hold cloud credentials.** The sandbox design (B4) keeps agent runs isolated; cloud operations
   run on the control plane with scoped, short-lived credentials from the secrets broker. The plan step runs with a
   read-only role in an isolated runner.
4. **Money is a hard limit.** Each environment has a budget with Lair's guard and the provider's own budget actions;
   spending stops before the limit.
5. **Observe first.** New behaviour is wired behind a config switch that starts in observe mode.

---

# Part A: Provider-neutral flow

## 1. Infrastructure-as-code tooling

### 1.1 OpenTofu vs CDK

| Factor | OpenTofu | AWS CDK |
|--------|----------|---------|
| **Language** | HCL (declarative) | TypeScript, Python, Java, Go |
| **State** | Explicit state file; S3 native locking (OpenTofu 1.8+, `use_lockfile`) | CloudFormation stack state managed by provider |
| **Drift detection** | `tofu plan -refresh-only` shows drift | CloudFormation drift detection |
| **Portability** | Same code can target multiple providers | Single provider |
| **Community** | Terraform-compatible ecosystem | Provider-maintained constructs |
| **Cost tools** | Infracost (external; calls a pricing API) | No general cost estimate |

**Recommendation:** OpenTofu (the open-source Terraform fork), version 1.8 or later.

- Declarative: the configuration is the desired state, easy to review.
- Portable: the same patterns work when Lair supports other providers.
- State is explicit: Lair manages the state file, can lock it, and can restore from backup.
- Native S3 state locking (OpenTofu 1.8+) removes the need for a separate lock table.

### 1.2 State storage and locking

| Item | Configuration |
|------|---------------|
| **State bucket** | Object storage in the project's connected account, versioned, encrypted, private |
| **Locking** | S3 native locking via `use_lockfile` (OpenTofu 1.8+); no separate lock table required |
| **State per environment** | Separate state files: `<project>/<env>/terraform.tfstate` |
| **Access** | Only Lair's apply role can write state; the plan role can read but not write |

The account-connection template ([cloud-accounts.md §1](cloud-accounts.md)) creates the bucket as part of the baseline.

### 1.3 Infracost for cost estimation

Infracost provides cost estimates from a plan file:

- **How it works:** Lair calls Infracost with the plan JSON; Infracost sends resource metadata (not secrets or state)
  to its pricing API and returns the estimate.
- **Data sent:** resource types, regions, quantities, instance sizes—no application data, no secrets.
- **Self-hosted option:** for projects that cannot send metadata externally, Infracost supports a self-hosted pricing
  API backed by the provider's public pricing feeds.
- **API key:** required for the cloud pricing API; stored in the control plane's secrets, never in agent context.

## 2. The pipeline

Every infrastructure change—manual or from a merge—goes through this pipeline:

```
┌─────────┐    ┌─────────────┐    ┌────────────┐    ┌───────────┐    ┌─────────────┐    ┌───────┐
│ Change  │───▶│ Policy scan │───▶│ tofu plan  │───▶│ Cost est. │───▶│ Risk class  │───▶│ Review│───▶ apply
│ (code)  │    │ (static)    │    │ (isolated) │    │ (Infracost)│    │ + threshold │    │ (gate)│     (controlled)
└─────────┘    └─────────────┘    └────────────┘    └───────────┘    └─────────────┘    └───────┘
```

### 2.1 Policy scan (before plan)

Before any plan runs, a static policy scan checks the change:

- **Denied blocks:** `external` data sources, `null_resource` with `local-exec`, and `http` data sources are refused
  by default. The owner can allowlist specific uses in project config.
- **Provider and module sources:** only sources in the project's allowlist (or locked in `.terraform.lock.hcl` with
  matching hashes) are accepted. An unknown source fails the scan.
- **Tool:** OPA (Open Policy Agent) or Conftest with Lair's policy pack.

A scan failure stops the pipeline before plan runs; the agent sees only "policy violation" with the rule name.

**As built (PR 1, `src/server/infra-policy/`):** a static scanner of its own instead of OPA/Conftest, so Lair needs no
extra binary; it reads `.tf`, `.tofu` and their `.json` forms, follows local modules inside the root, and refuses
anything it cannot read. The allowlists and the per-address `allow` list live in the project's `infra_policy:` block
(see [configuration](../configuration.md#infrastructure-policy-scan)). It is off by default. `guardPlan` of the project's policy is
what the OpenTofu runner (PR 3) calls: it does not start the plan when the scan fails. Not in this PR: the lock-file
hash check ("or locked in `.terraform.lock.hcl`"), which belongs to the plan sandbox (PR 2) where providers are
installed, and scanning remote modules (allowlisted sources are trusted as pinned).

The scan also refuses every provisioner (`local-exec`, `remote-exec`, `file`, any other), reads `check` blocks (a
scoped `data` source runs on plan) and `removed` blocks (a destroy-time provisioner runs on apply), decodes `\uNNNN`
escapes in labels before matching, and refuses a block type it does not know. It is asynchronous and bounded: 1 MiB per
file, 8 MiB in total, 500 files, 8 module levels and a 10 second deadline; a breach is a refusal (`unreadable`, detail
`scan limit`). An `allow` entry names a root, an address and the hash of the block's content, so editing an allowed
block (a changed `url` or `command`) ends the allowance; the scan reports it as changed. A project whose
`infra_policy` block is invalid, and is not explicitly `enabled: false`, holds a blocked policy: `guardPlan` always
refuses (rule `invalid-config`) and the runner asks `requires(project)` to know a scan is wanted. The scan routes are the
owner's: only `guardPlan` tells an agent anything, and that is the rule names.

**Time of check, time of use:** the scan reads the live directory and `plan` runs after it, so code could change between
the two. The plan runner (PR 2 and 3) must plan a copy taken after the scan (or compare a content hash before and
after), never the live directory.

### 2.2 Plan (isolated)

`tofu plan` runs in an isolated plan runner:

| Isolation | How |
|-----------|-----|
| **Plan role** | A read-only role with no access to secrets, no state write, no resource modification. It can only describe existing resources and compute diffs. |
| **Network** | Egress limited to the provider APIs and the locked module/provider registries. No arbitrary outbound. |
| **No other credentials** | The plan runner has no access to the apply role, the secrets broker, or application secrets. |
| **Locked providers** | Providers come from the lock file with verified hashes; no provider downloads at plan time. |

The plan shows:
- Resources to create, update or destroy.
- Sensitive values masked.
- A summary of the change.

**Why isolation matters:** `tofu plan` is not read-only execution. It runs every provider and data source in the
change. An `external` data source runs any program; an `http` data source calls any URL; a provider from an untrusted
source runs its own code. Without isolation, agent-written code could exfiltrate credentials.

**As built (PR 2, `src/server/plan-sandbox/`):** `PlanSandboxManager.plan(root)` is what the OpenTofu runner (PR 3) calls.
It copies the root first, plans only through the project's `guardPlan` (so the PR 1 scan decides), re-hashes the root to
close the time-of-check gap, checks the lock file (`.terraform.lock.hcl` pins every provider with a version and hashes,
all on `allowed_providers`: the check PR 1 left to this PR), then asks STS for the plan role (900 s) and runs
`tofu init -lockfile=readonly -plugin-dir` and `tofu plan -lock=false` in a read-only container whose environment is the
role's credentials and fixed settings only. The two boundaries are interfaces (`PlanCredentialIssuer`, `SandboxSpawner`)
with an `aws sts assume-role` and a `docker run` implementation. Egress: the container has no network unless an
`egress_network` is configured, a network the owner builds with a proxy that passes only the configured hosts; Lair does
not run that proxy and does not filter by hostname, so with an `egress_network` the isolation is only as good as that proxy (hostname enforcement: follow-up #203). `host`, `bridge` and `default` are refused, `external_id` is required, and `/status` reports the hosts as declared, not enforced. Off by default; see [configuration](../configuration.md#plan-sandbox).

**As built (PR 3, `src/server/tofu-runner/`):** `TofuRunnerManager` plans and applies through `PlanSandbox` only (the
sandbox gained `plan(root, { backend, keepPlanFile })` and `apply(root, job)`; both run the same copy, `guardPlan`,
re-hash and lock-file steps before any credential). State is the S3 backend, `<project>/<env>/<root name>-<hash>/terraform.tfstate` (the root is in the key, so two roots of one environment never share state), with
`use_lockfile=true`; the plan role reads it with `-lock=false`, the apply role takes the native lock. A plan with changes is
stored with the SHA-256 of the plan file and the hash of the code; `apply(planId, hash)` runs only that file, only in
`act` mode, only when the hash matches the record and the file, only on unchanged code, once. OpenTofu refuses a plan made
on a changed state. A failed or stale apply is not undone: the plan is spent and the runner re-plans from the new state,
which needs a new approval. After the plan, `tofu show -json` is read for what the plan deletes or replaces; such a plan needs its own confirmation (`confirmDestroy`, bound to the plan hash and the resource names) on top of the hash. One plan or apply runs per workspace (root and environment) at a time; an apply that raises an error or is cut off by a restart ends `failed`; plans expire (`plan_max_age_seconds`, default a day) and `plan_dir` must be 0700 and the process's own. Every plan, apply request, refusal, start and end is written to an audit log (owner session id, plan hash, outcome) and sent as an event. **Not yet:** apply does not consult the cloud money guard or a cost estimate (PR 4), so `mode: act` creates paid resources with no spend check. Decision Inbox wiring (the approval that carries the hash) is a later PR; until then the owner
calls the apply route with the hash. Off by default; see [configuration](../configuration.md#opentofu-runner).

### 2.3 Cost estimate

Lair runs Infracost on the plan. The estimate shows:
- Monthly cost before and after the change.
- Cost difference ("+$34/month", "−$12/month").
- A breakdown by resource type.

### 2.4 Risk classification

Cost alone does not determine review level. The risk class comes from analysing the plan JSON:

| Risk | Triggers | Auto-approve? |
|------|----------|---------------|
| **High** | Destroy or replace a stateful resource (database, bucket, volume); IAM policy change; security group opens to 0.0.0.0/0; KMS key change; money guard config change | Never |
| **Medium** | Create or change compute, networking, or load balancers | Depends on environment thresholds |
| **Low** | Add tags, update descriptions, non-destructive changes | Yes, if under cost threshold |

A high-risk change always goes to the Decision Inbox, regardless of cost delta.

### 2.5 Review gate

Review rules combine risk class and cost delta:

| Environment | Auto-approve when |
|-------------|-------------------|
| Preview | Risk is LOW and cost delta < `environments.preview.review.auto_approve_delta` (default $10/month) |
| Staging | Risk is LOW and cost delta < `environments.staging.review.auto_approve_delta` (default $50/month) |
| Production | Never auto-approved; always a Decision Inbox item |

A review that cannot auto-approve becomes a Decision Inbox item:

```
Infrastructure change: staging (+$72/month, MEDIUM risk)

Plan: 2 to add, 1 to change, 0 to destroy
Cost: $145/month → $217/month (+$72)
Risk: MEDIUM (creates load balancer, changes security group)
Plan hash: sha256:a1b2c3d4...

[Approve plan a1b2c3d4] [Reject] [View full plan]
```

The plan file and its hash are attached to the decision.

### 2.6 Apply

Once approved, `tofu apply` runs with the approved plan file:

- **Plan hash binding:** the decision carries the plan file's SHA-256 hash; apply runs that exact plan. If the state
  or code changed since the plan, OpenTofu refuses the stale plan; Lair then re-plans and a new decision is needed.
- **Apply role:** an IAM role with permissions to create, update, and destroy resources tagged `lair:managed`. Every
  IAM role it creates gets a permissions boundary so it cannot escalate privileges. See §A1 (AWS adapter).
- **Not atomic:** a failed apply leaves the resources it created or changed; nothing rolls them back. The state
  records what happened.
- **Post-failure flow:** Lair re-plans from the new state. The Decision Inbox shows what was applied and what
  remains, with options: "Fix forward" (continue with the remaining plan) or "Revert" (apply a plan that undoes
  the partial change).
- **Logged:** every apply is recorded in the audit log with the plan hash, the decision id, and the outcome.
- **Notified:** the owner gets a notification when apply completes or fails.

Configuration example:
```yaml
environments:
  staging:
    target: ecs               # see Part B
    strategy: rolling         # from phase5-deploy.md
    review:
      auto_approve_delta: 50  # USD/month; only when risk is LOW
    budget:
      limit: 200              # USD/month
      alert_thresholds: [50, 80, 100]
      hard_stop: true
    drift:
      schedule: "0 6 * * *"   # daily at 06:00 UTC
```

## 3. Releases

The release pipeline runs after a merge to the environment's branch (or on a tagged release for production):

```
┌───────────┐    ┌───────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐
│ Build     │───▶│ Push to   │───▶│ Migrate │───▶│ Rollout │───▶│ Verify   │
│ image     │    │ registry  │    │ (gated) │    │ (health)│    │ (smoke)  │
└───────────┘    └───────────┘    └─────────┘    └─────────┘    └──────────┘
```

### 3.1 Image build

- Multi-architecture images (amd64, arm64) for various compute options.
- Build source (configurable in project settings):
  - **Project's CI:** the project's GitHub Actions or other CI (default).
  - **Lair runners:** when the project's CI is unavailable, Lair's own runners build the image.
- Signing:
  - **CI builds:** Sigstore keyless signing using the CI's OIDC identity.
  - **Lair runner builds:** sign with a KMS-held key; the deploy step verifies the signature against the key's
    public fingerprint in project config.

### 3.2 Push to registry

- Container registry with image scanning (vulnerabilities above a severity threshold block the rollout).
- Image tags: `<env>-<sha>`, `<env>-latest`.
- Signature verification before the rollout proceeds.

### 3.3 Database migrations (gated)

Migrations run as a pre-deploy step:
1. **Backup:** take a database snapshot before migration.
2. **Run:** the project's migration tool (Flyway, Alembic, etc.) in a one-shot task.
3. **Verify:** check the schema version matches the expected version.
4. **Gate:** if the migration fails, the rollout does not proceed; the snapshot is available for restore.

Migrations are always backward compatible: the old code must work with the new schema during the rollout.

A migration that changes behaviour (not just adding columns) is a Decision Inbox item before apply.

### 3.4 Rollout with health checks

The rollout strategy comes from `environments.<env>.strategy` (extends [phase5-deploy.md](phase5-deploy.md)):

| Strategy | How it works | Use case |
|----------|--------------|----------|
| **Rolling** | Replace instances one at a time; health check between each | Default for most services |
| **Blue-green** | Deploy to a standby; switch traffic atomically | Zero-downtime for stateful services |
| **Canary** | Route a percentage of traffic to the new version; increase on success | High-risk changes |

Health checks:
- **Startup:** the container starts and the process is running.
- **Liveness:** the `/health` endpoint returns 200.
- **Readiness:** the service is ready to accept traffic (dependencies connected).

A health check failure triggers automatic rollback to the previous version.

### 3.5 Automatic rollback

Rollback triggers:
- Health check failure during rollout.
- Error rate exceeds threshold (from load balancer 5xx metrics and target health alarms, configurable in
  `environments.<env>.rollback.error_threshold`).
- Manual rollback from the Lair dashboard or a Decision Inbox action.

Rollback:
- Reverts to the previous image tag.
- Does NOT revert database migrations (they are forward-only and backward compatible).
- Records the rollback in the audit log and notifies the owner.

### 3.6 Release targets

Lair supports these deployment targets (set in `environments.<env>.target`):

| Target | Description | Rollout mechanism |
|--------|-------------|-------------------|
| **ecs** | Container service with managed compute | Service update with deployment circuit breaker and alarm-based rollback |
| **compose** | Docker Compose on VMs | Lair-driven rolling deploy through load balancer target deregistration |
| **kubernetes** | Kubernetes cluster (ROADMAP C7a) | Deployment with readiness gates |

Each target has an adapter in Part B (provider-specific).

## 4. Secrets

### 4.1 Roles and credentials

Lair uses separate roles with distinct permissions:

| Role | Purpose | Permissions | Lifetime |
|------|---------|-------------|----------|
| **Plan role** | Run `tofu plan` to compute diffs | Read-only: describe resources, read state (no write), no secrets access | 15 minutes |
| **Apply role** | Run `tofu apply` to make changes | Create, update, destroy resources tagged `lair:managed`; write state; permissions boundary on created roles | 1 hour |
| **Deploy role** | Release pipeline: update services, run migrations | Update container services, read registry, run tasks, read application secrets | 1 hour |

All roles:
- Are assumed by the control plane with `sts:AssumeRole` (or equivalent) with an external id.
- Have credentials that expire after the specified lifetime.
- Are never stored on disk or in logs.

### 4.2 Application secrets

- Stored in the provider's secrets manager (encrypted).
- Injected into containers at runtime as environment variables.
- Rotated on a schedule (configurable); rotation is a Decision Inbox item when it requires a restart.

### 4.3 Agent isolation (sandbox design B4)

Agents run in sandboxes without cloud credentials. They cannot:
- Call cloud APIs directly.
- Read any role's credentials.
- Access the state bucket or secrets.

All cloud operations go through the control plane's API, which checks permissions and audits every call.

## 5. The money guard per environment

Each environment has a budget ([cloud-accounts.md §4](cloud-accounts.md), [cloud-runners.md §4](cloud-runners.md)).

### 5.1 Cost tracking

Cloud provider cost data arrives with a delay (up to hours). Lair's meter works in two modes:

| Mode | Source | Latency |
|------|--------|---------|
| **Estimated** | Resources running now × hourly price (from the pricing API) | Real-time |
| **Actual** | Provider's cost and usage API | Hours delayed |

Lair shows estimated spend and reconciles with actual spend when available. Alerts trigger on estimated spend; hard
stops trigger on estimated spend but are confirmed against actual spend before pausing production.

### 5.2 Budget actions

| Guard | How it works |
|-------|--------------|
| **Lair's meter** | Tracks estimated and actual spend; refuses cost-increasing applies when near limit |
| **Provider budget** | Provider-native budget with automatic actions (stop instances, scale services to 0) |
| **Alerts** | Notification at 50%, 80%, 100% of the limit |
| **Hard stop** | At the limit, non-production environments pause (services scaled to 0); production notifies but does not pause unless owner confirms |

Configuration:
```yaml
environments:
  staging:
    budget:
      limit: 200              # USD/month
      alert_thresholds: [50, 80, 100]
      hard_stop: true         # pause at limit
  production:
    budget:
      limit: 1000
      alert_thresholds: [50, 80, 100]
      hard_stop: false        # notify only
```

### 5.3 Drift detection

Lair runs `tofu plan -refresh-only` on a schedule (daily by default) against each environment. A `-refresh-only` plan
shows changes in the real infrastructure without mixing in unmerged code changes.

A non-empty drift plan raises a Decision Inbox item:

```
Drift detected: production

3 resources changed outside Lair:
- service.backend: desired_count 2 → 4 (manual scaling?)
- security_group_rule.allow_debug: added (unauthorized?)
- database.main: storage 100 → 200 (auto-scaling?)

[Adopt changes] [Revert to code] [Ignore this time]
```

- **Adopt changes:** opens a PR with the code changes to match reality; the PR goes through normal review.
- **Revert to code:** runs an apply plan to restore the defined state.
- **Ignore this time:** logs the drift and takes no action; re-alerts on the next schedule.

## 6. Observe mode

New infrastructure modules start in observe mode:
- `tofu plan` runs and shows what would change.
- No apply happens automatically.
- The owner reviews plans in the Lair dashboard and decides when to enable act mode.

This matches the pattern in [autonomy.md §1](autonomy.md) and [platform.md §13](platform.md).

## 7. Acceptance tests

### 7.1 Policy and plan isolation tests

- A PR with an `external` data source is refused before plan (policy scan).
- A PR with an unlocked provider source fails the scan.
- The plan step cannot read a secret or write state (isolation test with a mock provider that tries both).
- A plan that passes scan runs in the isolated runner with the read-only role.

### 7.2 Pipeline tests

- A plan that adds a resource shows the correct cost estimate (mocked Infracost).
- A HIGH-risk change (database destroy, IAM change) creates a Decision Inbox item regardless of cost.
- A LOW-risk change under the auto-approve threshold does not create a decision (preview, staging).
- A plan for production always creates a Decision Inbox item.
- An approval for plan hash A cannot apply plan B (hash mismatch test).
- A stale plan (state changed since plan) is refused at apply time.

### 7.3 Apply tests

- An approved decision triggers apply; a rejected decision does not.
- A failed apply records what was created and what failed; a new Decision Inbox item offers "Fix forward" or "Revert".
- Stateful resources with `prevent_destroy` block a destroy apply.

### 7.4 Release tests

- A merge to staging triggers build, push, migrate, rollout.
- A health check failure during rollout triggers automatic rollback.
- A rollback reverts to the previous image and notifies the owner.
- Image signature verification fails → rollout blocked.

### 7.5 Budget tests

- At 80% of estimated spend, an alert fires.
- At 100% of estimated spend, non-production environments pause (service scaled to 0).
- At 100% of estimated spend, production notifies but does not pause unless owner confirms.
- A provider budget hard stop pauses the environment when triggered.

### 7.6 Drift tests

- A manual change in the provider console is detected on the next `-refresh-only` plan.
- "Adopt changes" opens a PR (not a direct commit); "Revert to code" restores the defined state.

### 7.7 Secret and isolation tests

- Plan role credentials expire after 15 minutes.
- Apply role credentials expire after 1 hour.
- An agent run cannot read cloud credentials or call cloud APIs directly (sandbox isolation).

## 8. Implementation PRs

| PR | Scope | Lines (est.) |
|----|-------|--------------|
| 1 | **Policy scan:** OPA/Conftest integration; provider and module allowlist; denied block rules | ~300 |
| 2 | **Plan sandbox:** isolated runner; plan role; network egress limits; locked providers | ~350 |
| 3 | **OpenTofu runner:** run `tofu init`, `plan`, `apply` from the control plane; state in S3 with native locking | ~350 |
| 4 | **Cost estimation:** Infracost integration; cost diff on plans; self-hosted API option | ~250 |
| 5 | **Risk classification:** plan JSON analysis; risk class assignment; review thresholds | ~200 |
| 6 | **Review gate:** Decision Inbox items for infrastructure changes; plan-hash binding; approve/reject flow | ~250 |
| 7 | **Release pipeline:** build, push, migrate, rollout steps; health checks; automatic rollback | ~400 |
| 8 | **Budget and drift:** per-environment budgets; estimated and actual spend tracking; `-refresh-only` drift | ~350 |
| 9 | **Secrets broker integration:** role assumption; application secrets injection | ~200 |
| 10 | **Dashboard views:** Environments view with status, cost, drift; release history; rollback button | ~350 |

Total: ~3,000 lines across 10 PRs.

---

# Part B: AWS adapter

This section covers AWS-specific implementation details. Other providers (GCP, Azure) will have their own adapter sections.

## A1. Roles

The account-connection template creates these roles:

### Plan role (`lair-plan-<account-id>`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "ecs:Describe*", "ecs:List*",
        "rds:Describe*",
        "s3:GetBucket*", "s3:ListBucket",
        "iam:GetRole", "iam:GetPolicy", "iam:ListRolePolicies",
        "elasticache:Describe*",
        "elasticloadbalancing:Describe*",
        "cloudwatch:GetMetricData",
        "secretsmanager:ListSecrets",
        "tag:GetResources"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<state-bucket>/*"
    }
  ]
}
```

Trust policy: only Lair's control plane can assume it, with an external id.

### Apply role (`lair-apply-<account-id>`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:*", "ecs:*", "rds:*", "s3:*",
        "elasticache:*", "elasticloadbalancing:*",
        "secretsmanager:*", "kms:*",
        "cloudwatch:*", "logs:*",
        "iam:CreateRole", "iam:DeleteRole", "iam:AttachRolePolicy",
        "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:PassRole"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": { "aws:ResourceTag/lair:managed": "true" }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<state-bucket>/*"
    }
  ]
}
```

**Permissions boundary:** every IAM role the apply role creates must have this boundary attached:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "aws:ResourceTag/lair:managed": "true" }
      }
    },
    {
      "Effect": "Deny",
      "Action": [
        "iam:CreateUser", "iam:DeleteUser",
        "iam:CreateAccessKey", "iam:DeleteAccessKey",
        "organizations:*",
        "account:*"
      ],
      "Resource": "*"
    }
  ]
}
```

This prevents privilege escalation: a role created by Lair cannot create IAM users, access keys, or modify the
organization.

Trust policy: only Lair's control plane can assume it, with an external id.

### Deploy role (`lair-deploy-<account-id>`)

Permissions:
- Update ECS services (or EC2 target groups for Compose targets).
- Pull from ECR.
- Run ECS tasks (for migrations).
- Read application secrets from Secrets Manager.
- Write to CloudWatch Logs.

Trust policy: only Lair's control plane.

## A2. State storage (AWS)

- **Bucket:** `lair-state-<account-id>` in the same region as the project.
- **Encryption:** SSE-KMS with a Lair-managed key.
- **Versioning:** enabled (state history and recovery).
- **Access:** only the apply role can write; the plan role can read.
- **Locking:** OpenTofu 1.8+ native S3 locking (`use_lockfile = true`); no DynamoDB table required.

## A3. Release targets (AWS)

### ECS

- **Rollout:** ECS service update with `deploymentCircuitBreaker` enabled.
- **Health:** ECS container health checks plus ALB target health.
- **Rollback:** ECS automatic rollback on circuit breaker failure; Lair can also trigger rollback based on CloudWatch
  alarm (5xx rate, latency).
- **Scaling pause:** the money guard scales the service's `desiredCount` to 0 to pause an environment.

### EC2 + Compose

- **Rollout:** Lair deregisters instances from the ALB target group one at a time, deploys the new Compose stack,
  runs health checks, and re-registers.
- **Health:** ALB target health plus Lair's own `/health` check.
- **Rollback:** Lair redeploys the previous Compose file from the artifact store.
- **Scaling pause:** Lair stops EC2 instances via the money guard.

### Kubernetes (ROADMAP C7a)

Covered in a separate design when C7a starts.

## A4. Budget actions (AWS)

- **AWS Budgets:** create a budget per environment; actions can apply IAM deny policies (block new EC2/RDS) and stop
  running instances.
- **Limitation:** AWS Budgets cannot scale ECS Fargate services directly. Lair's meter handles Fargate pause by
  calling `UpdateService` with `desiredCount: 0`.
- **Reconciliation:** Lair polls the Cost Explorer API for actual spend and reconciles with its estimate.

## A5. Secrets (AWS)

- **Application secrets:** AWS Secrets Manager.
- **Injection:** ECS container definition references the secret ARN; the task role has `secretsmanager:GetSecretValue`.
- **Rotation:** Secrets Manager rotation schedules; Lair creates a Decision Inbox item when rotation triggers a
  service restart.

## A6. Image signing (AWS)

- **ECR:** images pushed to ECR.
- **Signing (CI builds):** Sigstore cosign with OIDC identity from GitHub Actions.
- **Signing (Lair runner builds):** AWS KMS asymmetric key; Lair signs with the private key, deploy verifies with the
  public key fingerprint in project config.
- **Verification:** the deploy step calls `cosign verify` before proceeding; a signature mismatch blocks rollout.

---

## 9. ROADMAP update

C7 moves up and is renamed to reflect the provider-neutral design:

| Before | After |
|--------|-------|
| C6 lair-node | C6 lair-node |
| C7 Kubernetes and PaaS | **C7 Cloud deployment (AWS first)** |
| — | C7a Kubernetes and other PaaS |
| C8 Knowledge and learning loop | C8 Knowledge and learning loop |

Reason: a first project needs cloud deployment before its launch. Gate machines ([cloud-runners.md](cloud-runners.md))
already work; this adds the application layer. The design is provider-neutral; AWS is the first adapter.

## References

- [cloud-accounts.md](cloud-accounts.md) — account connection, runtime role, provider budgets
- [cloud-runners.md](cloud-runners.md) — on-demand machines, the money guard, signed results
- [phase5-deploy.md](phase5-deploy.md) — deployment targets, strategies, rollback
- [platform.md](platform.md) — the overall platform spec, migrations, observe mode
- [autonomy.md](autonomy.md) — Decision Inbox, observe/act modes
- [sandbox.md](sandbox.md) — agent isolation (B4)
