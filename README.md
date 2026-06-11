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
- **YAML configuration**: non-secret tool config is stored in `~/.config/x-hermes/config.yaml`; X tokens remain under `~/.xurl`, managed by `xurl`.
- **Diagnostics**: `doctor` and `status` report readiness without reading or printing credential files.
- **Hermes integration**: MCP server support gives Hermes a structured interface instead of generic shell access.
- **Search ingestion**: watch queries and direct scans store candidates and authors locally.
- **Config-driven campaigns**: reusable campaigns can be defined in YAML or added through the CLI, then run once or continuously.
- **Deterministic scoring**: candidate scoring runs before Hermes judgment and records risk flags.
- **Approval inbox**: drafts create pending approval requests that can be approved, rejected, edited, or delivered through another channel.
- **Notification adapters**: stdout and command-based notifications support post, error, and approval-request events without hard-coding a private messaging provider.
- **Feedback memory**: approval and rejection reasons are normalized into local feedback examples for future LLM drafting context and conservative auto-dismiss signals.
- **Guardrail-first design**: posting is intended to fail closed when approval, rate limit, active-hour, opt-out, cooldown, or risk checks do not pass.
- **Local durable state**: SQLite stores candidates, queues, audit events, opt-outs, and rate-limit counters.

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
x-hermes config show
x-hermes campaigns list
x-hermes run --once
x-hermes scan --query "your topic lang:en -is:retweet"
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
~/.config/x-hermes/config.yaml
```

Example:

```yaml
xurlApp: x-hermes
username: your_handle
runtime:
  mode: daemon
  scanIntervalMinutes: 60
  dryRun: true
posting:
  enabled: false
  approvalMode: required
  maxRepliesPerDay: 120
  maxRepliesPerRun: 10
  activeHours:
    start: "09:00"
    end: "21:00"
    timezone: America/New_York
  perAuthorCooldownHours: 50
  blockDuplicateReplyText: true
  requireOptInForAutoPost: true
quality:
  minimumFollowers: 1000
  minimumAccountAgeDays: 300
  skipSensitive: true
  skipScamLanguage: true
  useFeedbackSignals: true
notifications:
  onPost: true
  onError: true
  onApprovalRequest: true
  channels:
    - id: stdout
      type: stdout
      enabled: true
campaigns:
  - id: example
    enabled: true
    query: '"your topic" lang:en -is:retweet'
    replyText: "Thanks for sharing."
    fetchLimit: 25
    postLimit: 5
    approvalMode: required
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
x-hermes config init
x-hermes config show
x-hermes config validate
x-hermes config set posting.enabled true
x-hermes campaigns add "example" --query "keyword lang:en -is:retweet" --reply-text "Thanks for sharing." --limit 5
x-hermes campaigns list
x-hermes campaigns run example
x-hermes run
x-hermes run --once --campaign example
x-hermes service install
x-hermes service status
x-hermes status
x-hermes doctor
x-hermes watch-queries add "Name" --query "keyword lang:en -is:retweet"
x-hermes watch-queries list
x-hermes scan --query "keyword lang:en -is:retweet" --limit 25
x-hermes scan --limit 25
x-hermes candidates list
x-hermes candidates show <tweet-id>
x-hermes draft <tweet-id> --text "Your reply text" --by <actor>
x-hermes approve <tweet-id> --by <actor> --reason "Reviewed"
x-hermes reject <tweet-id> --by <actor> --reason "Low relevance"
x-hermes approvals list --status pending
x-hermes approvals show <approval-request-id>
x-hermes approvals respond <approval-request-id> --message "approve: looks good" --by <actor>
x-hermes feedback profile
x-hermes post-approved <tweet-id> --by <actor>
x-hermes opt-out add @username --by <actor> --reason "Requested"
x-hermes stats
x-hermes mcp
x-hermes-mcp
```

`doctor` never mutates state. `setup --check-only` runs setup checks without installs, auth changes, or config writes.

Posting is disabled by default. To post, a candidate must have an approved draft and pass every guardrail, including `posting.enabled`, active hours, daily cap, author cooldown, opt-out state, duplicate text checks, unresolved risk flags, and opt-in evidence when required.

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

Available MCP tools:

```text
status
scan_recent_posts
list_candidates
get_candidate
queue_reply_draft
approve_candidate
reject_candidate
list_approval_requests
get_approval_request
render_approval_request
record_approval_delivery
approve_request
reject_request
edit_draft
process_approval_response
post_approved_reply
record_opt_out
list_campaigns
run_campaigns_once
get_stats
get_feedback_profile
```

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

See [`docs/usage.md`](docs/usage.md) for a complete local workflow.

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
