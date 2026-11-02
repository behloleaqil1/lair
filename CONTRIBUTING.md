# Contributing to Lair

Thank you for your interest in contributing to Lair! This document provides guidelines for contributing to the project.

## Where to start

- **Pick an issue.** [Good first issues](https://github.com/behloleaqil1/lair/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
  are small, with the files to read and what "done" means. [Help wanted](https://github.com/behloleaqil1/lair/issues?q=is%3Aopen+label%3A%22help+wanted%22)
  issues are bigger or need a setup we don't have (for example testing an agent adapter with the agent CLI you use).
- **Say you're on it.** Comment on the issue before you start, so two people don't do the same work. If you stop,
  say so and someone else can take it.
- **Ask anything** in [Discussions](https://github.com/behloleaqil1/lair/discussions), including "how does X work?"
  and "would you take a PR for Y?".
- **Bigger changes** start from their design note in [docs/design/](docs/design/) and the order in the
  [roadmap](docs/design/ROADMAP.md). Open a discussion or an issue first if there is no design note yet.
- **Small pull requests win.** One change per pull request, with its tests. CI (typecheck, lint, tests and build on
  Node 22 and 24, and gitleaks) must be green before review.
- New to the vocabulary? The [glossary](docs/glossary.md) explains dragons, lanes, claims and the rest.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/lair.git`
3. Install dependencies: `npm run setup` (`npm ci`, then the install scripts of the few allowed packages; see [Install scripts](docs/getting-started.md#install-scripts))
4. Create a branch: `git checkout -b feature/your-feature-name`

## Development

### Running locally

```bash
# Start development server with hot reload
npm run dev

# Run tests
npm test

# Run linting
npm run lint

# Type check
npm run typecheck
```

### Project structure

```
src/
├── client/           # React frontend
├── server/           # Fastify backend
├── bus/              # MCP fleet bus
├── node/             # lair-node daemon (experimental)
├── cli/              # lair-node CLI
└── shared/           # Shared types
```

See [docs/architecture.md](docs/architecture.md) for a file-by-file map.

### Code style

- Use TypeScript for all new code
- Follow the existing code style
- Run `npm run lint` and `npm run typecheck` before committing
- Add tests for new features

## Pull Request Process

1. Ensure all tests pass: `npm test`
2. Ensure linting passes: `npm run lint`
3. Ensure type checking passes: `npm run typecheck`
4. Update documentation if needed
5. Write a clear commit message
6. Create a pull request with a description of your changes
7. For a fix or a feature, list revert checks in the description (below)

### Revert checks

A test that still passes when the code it guards is reverted protects nothing. CI proves that a pull
request's tests guard the code they claim to guard. List the checks in the PR description, one per line,
at the start of the line:

```
revert-check: <test file>[ > <test name>] guards <source file>[:<line>|:<start>-<end>]
```

For example: `revert-check: src/server/queue.test.ts > parser > skips blank lines guards src/server/queue.ts:40-52`.
Lines inside fenced code blocks (like the one above) and indented lines are examples and do not count.

For each line CI:

1. runs the test on the PR's code and requires it to pass. Without a test name the whole file runs; with
   one, only the tests whose full name contains it (`>` separates `describe` blocks);
2. reverts the PR's change to the source file: the whole file, or with a line range only the changed
   hunks that touch those lines (line numbers of the PR's version of the file);
3. runs the test again and requires at least one failing test;
4. restores the file.

A check **fails** (exit 1) when, before the revert, the test fails, matches no test or times out, or when,
after the revert, it still passes, matches no test, fails to load (an import error proves nothing about the
change) or times out. A check **cannot run** (exit 2) when the line is malformed; a path starts with `-`,
is absolute, contains `..` or is not tracked by git; the test is not a `*.test.*` or `*.spec.*` file; the
source file is new in the PR; or the revert would change nothing. At most 10 lines; each test run is
stopped after 120 seconds.

**When lines are required.** A PR needs at least one line when both hold:

- it changes code: a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` or `.sh` file under
  `src/` or `scripts/` that is not a test (`*.test.*`, `*.spec.*`, or under a `testing/`, `__tests__/`,
  `__mocks__/` or `fixtures/` directory);
- its title is not of a type that changes no behaviour (`build`, `chore`, `ci`, `docs`, `perf`,
  `refactor`, `revert`, `style`, `test`). `fix` and `feat`, with or without a scope or `!`, need lines,
  and so does any other type or a title that is not in `type(scope): subject` form.

Otherwise the step fails with exit 2. The repository variables `REVERT_CHECKS_REQUIRE` (`auto`, the
default, `always` or `never`) and `REVERT_CHECKS_CODE_PATHS` (default `src/,scripts/`) change the rule.

**Exemption.** Only the repository owner can exempt a PR: by adding the `revert-check-exempt` label,
then re-running the revert-checks job (it reads the label history when it runs). A line in the
description such as `no revert-check: ...` exempts nothing.

The job runs the base branch's copy of `src/cli/revert-checks.ts` when the base has one, so a PR that
changes the script must keep its options working. To try it locally:
`npx tsx src/cli/revert-checks.ts "--title=fix: ..." body.md main`.

### Commit messages

Use conventional commit format:

```
type(scope): subject

body (optional)
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:
- `feat(gates): add retry button for failed gates`
- `fix(parsers): handle empty queue file`
- `docs: update README with new configuration options`

## Testing

- Unit tests go in `*.test.ts` files next to the code they test
- Use fixtures in `fixtures/` for test data
- Run tests with `npm test` or `npm run test:watch`

### Test fixtures

Test fixtures should use synthetic data only:
- Use example IPs from RFC 5737 (192.0.2.x, 198.51.100.x, 203.0.113.x)
- Use generic paths like `/home/user/project`
- Use placeholder names like `deploy`, `example-org`
- Imitate the real formats with invented content: agents like `kiro-X`, branches like `feat/example`, gate IDs like `20260101T000000Z-example-abcdef12-1`. Never copy real queue lines or logs

## No private details

Everything in this repository is public. In code, docs, examples, fixtures and commit messages:

- No real home-directory paths, IP addresses (use `localhost` or the RFC 5737 ranges above), hostnames, SSH key paths, email addresses, account names, private repository names, or customer or business data
- No keys, tokens or passwords, not even expired ones. CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push and pull request
- CI also runs the genericity guard (`npm run check:generic`, [scripts/check-generic.ts](scripts/check-generic.ts)) on every tracked file and on the commit messages of the push or pull request. It flags home-directory paths (use `/home/user/...`), email addresses other than placeholders (`example.com`, the `.example` or `.test` domains) and GitHub noreply addresses, and names on a private denylist (projects, people, machines, companies)
- The denylist is never committed. CI reads it from the `GENERIC_DENYLIST` repository secret, one name per line (maintainers change it with `gh secret set GENERIC_DENYLIST`); locally the guard reads `GENERIC_DENYLIST`, else the gitignored `.generic-denylist` file, and without either it says that names went unchecked. In CI a missing denylist fails the job. Pull requests from forks get no secrets, so there the job fails and a maintainer runs the guard before merging
- A line that must keep such text (a test whose input is a URL with credentials, say) takes a `generic-ignore: <reason>` comment, counted in the guard's summary. `.generic-baseline` lists known violations still to fix; CI fails when it grows, and when an entry matches nothing any more
- Keep your own project configs in `projects/local/`, which is gitignored. The repository ships only `projects/example.yaml`, with made-up paths
- Keep the code project-agnostic: details specific to one product or agent vendor (CLI commands, file formats) belong in the project config, not in the code

## Reporting Issues

When reporting issues, please include:

1. A clear description of the problem
2. Steps to reproduce
3. Expected vs actual behavior
4. Your environment (OS, Node version)
5. Relevant logs or screenshots

## Feature Requests

Feature requests are welcome! Please:

1. Check if the feature is already requested
2. Describe the use case
3. Explain why it would be useful

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
