# x-hermes Usage

This guide shows the local workflow for setting up `x-hermes`, scanning X posts, queueing replies, approving drafts, and posting only when guardrails allow it.

## 1. Build

```bash
pnpm install
pnpm build
```

From a source checkout, run:

```bash
node apps/x-hermes-tool/dist/cli.js doctor
```

When installed or linked, use:

```bash
x-hermes doctor
```

## 2. Setup

Run setup in a local terminal:

```bash
x-hermes setup
```

Setup checks Node.js, platform support, storage, `xurl`, and X auth. Secrets are collected only through local prompts. `xurl` stores OAuth data in `~/.xurl`; `x-hermes` stores non-secret config in `~/.config/x-hermes/config.json`.

Non-mutating checks:

```bash
x-hermes doctor
x-hermes setup --check-only
```

Hermes MCP config helper:

```bash
x-hermes setup --with-hermes
```

## 3. Configure Watch Queries

Add a reusable watch query:

```bash
x-hermes watch-queries add "Monad" --query "monad lang:en -is:retweet"
```

List configured queries:

```bash
x-hermes watch-queries list
```

## 4. Scan

Scan a direct query:

```bash
x-hermes scan --query "monad lang:en -is:retweet" --limit 25
```

Scan all enabled watch queries:

```bash
x-hermes scan --limit 25
```

Scan stores authors, candidates, scores, risk flags, scan runs, and audit events in the local SQLite database.

## 5. Review Candidates

List candidates:

```bash
x-hermes candidates list
x-hermes candidates list --status found
```

Show one candidate:

```bash
x-hermes candidates show <tweet-id>
```

Reject a candidate:

```bash
x-hermes reject <tweet-id> --by <actor> --reason "Low relevance"
```

Record an opt-out:

```bash
x-hermes opt-out add @username --by <actor> --reason "Requested no replies"
```

## 6. Draft and Approve

Queue a reply draft:

```bash
x-hermes draft <tweet-id> --text "Thanks for asking." --by hermes
```

Approve after review:

```bash
x-hermes approve <tweet-id> --by <human> --reason "Reviewed manually"
```

Approval does not post. It only marks the candidate and latest draft as approved.

## 7. Guarded Posting

Posting is disabled by default:

```json
{
  "postingEnabled": false
}
```

To enable posting, edit the local non-secret config:

```text
~/.config/x-hermes/config.json
```

Then post an approved candidate:

```bash
x-hermes post-approved <tweet-id> --by <actor>
```

Posting fails closed unless all guardrails pass:

- `xurl` auth is present.
- Posting is enabled.
- Candidate status is `approved`.
- Latest draft status is `approved`.
- Current time is inside active hours.
- Daily reply cap is not reached.
- Author cooldown has elapsed.
- Candidate has no unresolved risk flags.
- Reply text was not recently duplicated.
- Author is not opted out.
- Opt-in evidence exists when `requireOptInForAutoPost` is enabled.

Keyword-search candidates should generally remain human-approved and non-autonomous unless there is clear opt-in evidence.

## 8. MCP

Run the MCP server:

```bash
x-hermes-mcp
```

Hermes config:

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

MCP tools:

```text
status
scan_recent_posts
list_candidates
get_candidate
queue_reply_draft
approve_candidate
reject_candidate
post_approved_reply
record_opt_out
get_stats
```

MCP posting is hard-gated. `post_approved_reply` returns an error result when guardrails block posting.

## 9. Development Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use fake `xurl` binaries and temp config/data directories. They do not require live X credentials.

