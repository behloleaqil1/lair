# Lair runners: run gates on CI runners first, the developer's machine last

Goal: gates and other heavy jobs should not spend the developer's memory and CPU when a CI runner can do the job. Lair
picks an executor for each job in a fixed order, falls back when one is unavailable, and reports where every step ran,
why it fell back and how many CI minutes it used. This extends [platform.md](platform.md) §6 (gate pipelines are
configuration) and milestone M2. Status: partly built. The pipeline config, the GitHub Actions and local executors, the
selector, the minutes budget and the API and UI exist (`src/server/gates/`, see
[configuration](../configuration.md#gate-pipelines)); lair-node machines (§1, step 2) and other CI providers are not
built. Keep everything generic (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## 0. Principles
1. **The developer's machine is the last resort.** A job runs locally only when no CI runner and no other Lair machine
   can take it.
2. **Nothing is lost and nothing runs twice.** A job falls back to the next executor only once the previous one is
   proven not to have run any of its steps. Every attempt is stored, so a server restart resumes it.
3. **One result format.** A result is the same `GateResult` whichever executor produced it.
4. **No surprise bills.** CI minutes that cost money are spent only within a budget the human set, and a Decision Inbox
   item is raised before that budget would be exceeded.
5. **No code from strangers on the developer's machines.** A public repository never gets a job routed to a
   self-hosted runner.

## 1. Executor order
For each job (one lane of a pipeline, §3), Lair tries, in order:
1. **CI runners of the project's repository**, when available. GitHub Actions first. Providers sit behind one
   interface (check availability, dispatch, poll, cancel, fetch logs and artifacts, report minutes), so GitLab CI and
   others can follow without changing the selector.
2. **The project's own Lair machines** (lair-node lanes), when one has capacity: no memory pressure, load per core
   below a limit, and enough free RAM. Not built yet: lair-node cannot run pipeline jobs, so this step reports
   "unavailable" with that reason.
3. **The local machine**, with the same capacity checks before the job starts. When capacity is short the job waits
   (the reason is shown) instead of starting.

A project can change the order or drop executors (`executors.order`), and a lane can have its own order (for
example, a quick lint lane that always runs locally).

## 2. GitHub Actions
- **Public repositories** use GitHub-hosted runners, which are free for public repositories.
- **Private repositories** use, in this order:
  1. an idle self-hosted runner registered to the repository (no minutes billed);
  2. GitHub-hosted runners, only within the project's monthly minutes budget (`executors.github.monthly_minutes`,
     default 0, which means "don't use them");
  3. a busy self-hosted runner (the job queues there and the pickup timeout applies).
- **Budget:** before dispatching to a hosted runner of a private repository, Lair adds the expected minutes (the
  largest of the last five hosted runs of that lane, at least 1) to the minutes used this calendar month (UTC). When
  that would exceed the budget, it does not dispatch, raises a `spend` Decision Inbox item (once per month), and
  goes on to the next executor. `spend` decisions never resolve on a timeout.
- **Never self-hosted for a public repository.** Fork pull requests can change workflows, so a self-hosted runner
  registered to a public repository can run a stranger's code on the developer's machine. Lair never dispatches there
  for a public (or internal) repository: the workflow it generates for such a repository has no self-hosted option at
  all. When Lair sees self-hosted runners registered to a public repository, the status shows a warning to remove
  them.

## 3. Pipelines, lanes and jobs
- A **pipeline** is a list of steps, each an argv command (never a shell string), with a timeout and a **lane**.
- Steps of one lane run in order on one executor, as one **job**. Different lanes are separate jobs: they run in
  parallel and each picks its own executor, so a heavy lane can go to CI while a light one runs locally.
- A step that fails stops the rest of its lane, unless it is marked `continue_on_failure`.

## 4. Availability and fallback
- **Self-hosted runners:** the runners API lists the repository's runners. A runner counts when it is online and has
  every label in `executors.github.self_hosted_labels`; it is idle when it is not busy.
- **Hosted runners:** allowed by config (`executors.github.hosted`), and for private repositories by the budget.
- **Before dispatch** Lair checks that the token is set, the repository is reachable, the commit is on GitHub, and
  the workflow file on the dispatch branch is the one Lair generates for the current pipelines (a version marker in
  the file). Any of these failing skips GitHub for that job, with the reason.
- **Refusals and timeouts:** a job that GitHub refuses (billing, spending limit, a locked account, Actions disabled,
  a workflow that fails to start), or that no runner picks up within `pickup_timeout_minutes`, is cancelled and
  confirmed cancelled, and then falls back to the next executor. The refused executor (hosted, self-hosted, or all of
  GitHub for account-wide problems) is marked unavailable for `unavailable_minutes`, and the UI shows why and until
  when.
- **Never lost, never twice:** Lair records each attempt (with its dispatch id) before dispatching. A fallback
  happens only after GitHub reports the run finished with none of the pipeline's steps started. If a cancel races
  with a runner that already started the job, Lair keeps that run's result and does not fall back. After a restart,
  Lair finds an in-flight run by its dispatch id and goes on polling it; a local job that the restart interrupted
  never finished, so it is started again.
- When every executor is unavailable, the job waits and is retried; it is never dropped.

## 5. Results
- Each job produces a `GateResult` (status, steps with status, exit code, duration and output tail, the pipeline
  version) through the same step logic, whichever executor ran it. For GitHub the job's steps and log are replayed
  through that logic, so a CI run with a missing step is a failed result, never a pass.
- On top of the result each job records where it ran (local machine, a GitHub-hosted runner and its labels, or a
  self-hosted runner and its name), its attempts with the fallback reasons, the redacted log, the artifacts, and the
  minutes used.
- **Minutes:** each GitHub job's duration rounded up to whole minutes, times the runner's multiplier (Linux 1,
  Windows 2, macOS 10). Billed minutes count only for hosted runners of private repositories; they go into the
  project's minutes budget and the fleet budget (provider `github-actions:<project>`, unit minutes). GitHub's
  billing page remains the authority.

## 6. Security
- **Least privilege.** The generated workflow declares `permissions: contents: read`, and its checkout does not
  keep the token. Lair's own token needs only: Actions read and write (dispatch, cancel, runs, logs), Contents read
  (the workflow file and the commit), Metadata read, and, for private repositories with self-hosted runners,
  Administration read (to list runners). It comes from an environment variable (`LAIR_GITHUB_TOKEN` by default),
  never from the project YAML, and is removed from the environment of local steps.
- **No secrets in logs.** Lair redacts token-shaped text (GitHub tokens, bearer headers) from every log it stores
  and never logs the token. GitHub also masks repository secrets.
- **Validated inputs.** The workflow takes a run id, a commit SHA, the job to run and, for private repositories, the
  runner kind. Lair validates them before dispatching, and the workflow validates them again from environment
  variables (never `${{ }}` inside a script) before it checks out the commit. Step commands and env values may not
  contain `${{`, newlines or control characters, so nothing in the config is evaluated by GitHub.

## 7. Setup for a newcomer
1. Define a pipeline in the project YAML ([configuration](../configuration.md#gate-pipelines)). With nothing else
   set, jobs run on the local machine.
2. Create a fine-grained token for the repository with the permissions in §6 and start Lair with
   `LAIR_GITHUB_TOKEN` set.
3. Open the Gates view, copy the generated workflow file, and commit it to the default branch as
   `.github/workflows/lair-gates.yml` (also served by `GET /api/pipelines/workflow`). Lair tells you when the
   committed file is missing or out of date.
4. Private repository, optional: register a self-hosted runner to the repository (Settings, Actions, Runners, New
   self-hosted runner) on a spare machine, following GitHub's commands there (`./config.sh --url
   https://github.com/<owner>/<repo> --token <registration token>`, then `./run.sh` or `./svc.sh install`). To keep Lair
   jobs on dedicated runners, add a label (`--labels lair`) and set `self_hosted_labels: [self-hosted, lair]`.
5. Private repository, optional: set `executors.github.monthly_minutes` to allow GitHub-hosted runners within that
   budget.

## 8. Later
- lair-node executors (§1 step 2) once lair-node runs real jobs, with results signed by the node.
- GitLab CI and other providers behind the same interface.
- Automatic triggers (on push, before merge, nightly) through the scheduler; today runs are started from the UI or
  `POST /api/pipelines/runs`.
