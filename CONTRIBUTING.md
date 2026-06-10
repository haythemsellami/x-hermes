# Contributing

Thanks for contributing to `x-hermes`.

The project goal is a safe, local Hermes integration for operating an X account through the official X API using `xurl` as the auth and transport layer.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Tests should not require live X credentials. Use fake `xurl` binaries, temp config directories, and temp data directories for automated coverage.

## Safety Rules

- Use the official X API through `xurl`.
- Do not add X scraping or browser automation.
- Do not read, parse, print, or upload `~/.xurl`.
- Do not store OAuth secrets in `x-hermes` config.
- Do not expose generic shell execution through MCP.
- Keep posting fail-closed behind explicit guardrails.
- Keep private deployment details out of the repository.

## Pull Requests

Before opening a pull request:

```bash
pnpm run ci
```

Prefer small, reviewable changes with tests. For behavior changes, update `docs/spec.md`, `README.md`, or `docs/usage.md` when relevant.
