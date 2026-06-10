# x-hermes

`x-hermes` is a local CLI and MCP server for safely operating an X account through the official X API. It uses the official `xurl` CLI for OAuth, token refresh, and X API transport. `x-hermes` owns setup orchestration, local non-secret config, status checks, and future guardrails around scanning, approval, and posting.

The spec is in [docs/spec.md](docs/spec.md) and is the source of truth.

## Current scope

This repo is implementing M1 first:

- `x-hermes setup`
- `x-hermes setup --check-only`
- `x-hermes setup --with-hermes`
- `x-hermes status`
- `x-hermes doctor`
- `x-hermes mcp` / `x-hermes-mcp` with an initial `status` MCP tool

Scanner, queue, scoring, and posting logic come later.

## Secret handling

- Do not paste X OAuth secrets into chat.
- `x-hermes setup` prompts for secrets locally in your terminal.
- `xurl` owns OAuth/token storage in `~/.xurl`.
- `x-hermes` stores only non-secret config in `~/.config/x-hermes/config.json`.
- Command output is redacted before `x-hermes` prints captured setup output.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Run the CLI from a checkout after building:

```bash
node apps/x-hermes-tool/dist/cli.js doctor
node apps/x-hermes-tool/dist/cli.js status
node apps/x-hermes-tool/dist/cli.js setup --check-only
```

## Runtime requirements

- Node.js 24+
- macOS or Linux
- `xurl` on `PATH` for auth and API calls
- Hermes only if you opt into MCP integration on the same machine

If `xurl` is missing, interactive `x-hermes setup` asks before running the official installer:

```bash
curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash
```

