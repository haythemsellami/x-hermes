# Security Policy

`x-hermes` is local-first software that coordinates Hermes, `xurl`, and the official X API. The security model depends on keeping OAuth secrets out of chat, logs, commits, and MCP tool calls.

## Supported Versions

Security fixes target the `main` branch until versioned releases exist.

## Reporting Issues

Please report security issues privately through GitHub Security Advisories when available for the repository. If advisories are not enabled, contact the repository owner directly before opening a public issue.

## Secret Handling Expectations

- Never paste X OAuth Client Secrets into issues, pull requests, chat, or logs.
- Never commit `~/.xurl`, local config files, SQLite databases, or environment files.
- `xurl` owns X OAuth storage under `~/.xurl`.
- `x-hermes` stores only non-secret config under `~/.config/x-hermes/config.json`.

## Design Constraints

- MCP tools must expose structured `x-hermes` workflows, not arbitrary shell commands.
- Posting must remain guarded by approval state, active hours, caps, cooldowns, opt-outs, duplicate checks, and risk flags.
- Network calls to X should go through `xurl`.

