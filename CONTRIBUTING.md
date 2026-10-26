# Contributing to Lair

Thank you for your interest in contributing to Lair! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/lair.git`
3. Install dependencies: `npm install`
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
