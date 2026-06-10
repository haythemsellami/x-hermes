# x-hermes

Safe, local Hermes automation for X through the official X API.

`x-hermes` provides a CLI and MCP server that let Hermes work with an X account without scraping, browser automation, or custom OAuth handling. It delegates X authentication and API transport to the official [`xurl`](https://github.com/xdevplatform/xurl) CLI, then layers local setup, status checks, search configuration, candidate review, approval workflows, posting guardrails, and auditability on top.

The project is designed for users who want AI-assisted X operations with explicit safety boundaries:

- Official X API access through `xurl`
- Local-first configuration and state
- Secrets kept out of chat, logs, commits, and MCP tool calls
- Human approval and guardrails before posting
- MCP support for Hermes
- CLI support for setup, diagnostics, and manual operations
- Open-source, reusable TypeScript implementation

## Why x-hermes

Operating an X account with an LLM needs more than an API wrapper. The tool must separate authentication from automation, keep secrets local, avoid policy-hostile browser automation, and make it difficult for an agent to bypass rate limits, approval state, opt-outs, active-hour windows, or audit logging.

`x-hermes` is built around that separation:

```text
Hermes chat / Hermes cron
        ↓
x-hermes CLI + MCP server
        ↓
xurl CLI
        ↓
Official X API
```

`xurl` owns OAuth, token refresh, request signing, and account profiles. `x-hermes` owns the local workflow around safe operation.

## Features

- **One setup flow**: checks the platform, Node.js, local storage, `xurl`, X auth, and optional Hermes MCP integration.
- **Safe auth model**: X OAuth credentials are collected only through local terminal prompts. `x-hermes` never asks for secrets through chat.
- **Non-secret config**: tool config is stored in `~/.config/x-hermes/config.json`; X tokens remain under `~/.xurl`, managed by `xurl`.
- **Diagnostics**: `doctor` and `status` report readiness without reading or printing credential files.
- **Hermes integration**: MCP server support gives Hermes a structured interface instead of generic shell access.
- **Guardrail-first design**: posting is intended to fail closed when approval, rate limit, active-hour, opt-out, cooldown, or risk checks do not pass.
- **Local durable state**: SQLite is the intended storage layer for candidates, queues, audit events, opt-outs, and rate-limit counters.

## Requirements

- Node.js 24 or newer
- pnpm
- macOS or Linux
- [`xurl`](https://github.com/xdevplatform/xurl) on `PATH`
- An X Developer account and X app with OAuth 2.0 enabled
- Hermes, only if you want MCP integration on the same machine

Recommended X app settings:

- App type: web app, automated app, or bot
- Redirect URI: `http://localhost:8080/callback`
- OAuth 2.0 enabled
- API access plan that supports the endpoints you intend to use

Typical read/queue scopes:

```text
tweet.read
users.read
offline.access
```

Posting also requires:

```text
tweet.write
```

## Installation

From a checkout of the repository, install dependencies and build:

```bash
cd x-hermes
pnpm install
pnpm build
```

During local development, run the built CLI directly:

```bash
node apps/x-hermes-tool/dist/cli.js doctor
```

When packaged or linked, the intended commands are:

```bash
x-hermes doctor
x-hermes status
x-hermes setup
x-hermes-mcp
```

## Setup

Run the setup flow from a local terminal:

```bash
x-hermes setup
```

From a source checkout:

```bash
node apps/x-hermes-tool/dist/cli.js setup
```

Setup is idempotent. It checks the local environment, verifies `xurl`, configures the X app profile, starts the `xurl` OAuth flow, sets the default `xurl` account, saves non-secret config, and verifies the account with `xurl whoami`.

Useful setup modes:

```bash
x-hermes setup --check-only
x-hermes setup --with-hermes
x-hermes setup --non-interactive
```

If `xurl` is missing, interactive setup asks before running the official installer:

```bash
curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash
```

Non-interactive setup does not install dependencies or change auth state; it prints instructions instead.

## Configuration

`x-hermes` stores non-secret configuration at:

```text
~/.config/x-hermes/config.json
```

Example:

```json
{
  "xurlApp": "x-hermes",
  "username": "your_handle",
  "activeHours": {
    "start": "09:00",
    "end": "21:00",
    "timezone": "America/New_York"
  },
  "maxRepliesPerDay": 120,
  "replyTextDefault": "Configure this per project",
  "postingEnabled": false,
  "perAuthorCooldownHours": 168,
  "requireApprovalForKeywordSearch": true,
  "requireOptInForAutoPost": true
}
```

X OAuth tokens and app credentials are managed by `xurl` under `~/.xurl`. Do not commit, print, upload, parse, or inspect that directory.

For development and tests, config/data paths can be overridden:

```bash
X_HERMES_CONFIG_DIR=/tmp/x-hermes-config \
X_HERMES_DATA_DIR=/tmp/x-hermes-data \
node apps/x-hermes-tool/dist/cli.js doctor
```

## Commands

```bash
x-hermes setup
x-hermes setup --check-only
x-hermes setup --with-hermes
x-hermes status
x-hermes doctor
x-hermes mcp
x-hermes-mcp
```

`doctor` never mutates state. `setup --check-only` runs setup checks without installs, auth changes, or config writes.

## MCP

`x-hermes` exposes a stdio MCP server for Hermes:

```bash
x-hermes-mcp
```

Example MCP server configuration:

```json
{
  "mcpServers": {
    "x-hermes": {
      "command": "x-hermes-mcp",
      "args": []
    }
  }
}
```

The MCP interface is intentionally structured. It should expose approved `x-hermes` workflows, not generic shell access or arbitrary `xurl` execution.

## Security Model

- Secrets are collected through local interactive prompts, never through chat.
- `xurl` owns OAuth token storage in `~/.xurl`.
- `x-hermes` stores only non-secret configuration.
- Command output is redacted before printing captured setup output.
- The internal `xurl` wrapper builds argv arrays without shell interpolation.
- MCP tools must not expose a general-purpose command runner.
- Posting workflows are designed to require approval and pass guardrails.

## Local Development

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run the CLI from source:

```bash
pnpm build
node apps/x-hermes-tool/dist/cli.js status
```

Project layout:

```text
x-hermes/
  docs/
    spec.md
  apps/
    x-hermes-tool/
      src/
      tests/
  package.json
  pnpm-workspace.yaml
```

The product spec lives in [`docs/spec.md`](docs/spec.md). Treat it as the source of truth for behavior and safety constraints.

## Contributing

Issues and pull requests are welcome. Keep changes aligned with the project safety model:

- Use the official X API through `xurl`.
- Do not add scraping or browser automation for X.
- Do not store X OAuth secrets in `x-hermes` config.
- Do not print secrets or read `~/.xurl`.
- Prefer explicit, testable guardrails over agent discretion.
- Keep private deployment details out of the repository.

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## License

`x-hermes` is free and open source software released under the [MIT License](LICENSE).
