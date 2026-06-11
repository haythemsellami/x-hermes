# X Hermes Tool Spec

## Goal

Build a small local tool that lets Hermes safely operate an X account through the official X API. The first production target is not fully autonomous posting. It is a controlled workflow that searches for relevant X posts, scores candidates, asks Hermes to judge and draft, queues replies, and only posts when guardrails allow it.

The tool should use `xurl` as the underlying X API transport/auth layer instead of implementing OAuth and token refresh ourselves.

## Non-Goals

- Do not scrape X pages or automate a browser for X.
- Do not use xAI/Grok or Hermes `x_search`; it is paid and unnecessary for this workflow.
- Do not let the LLM bypass rate limits, active-hour windows, approval state, opt-out state, or audit logging.
- Do not read or print `~/.xurl` contents. It contains credentials.
- Do not build a generic social-media autoposter first. Keep the first tool narrow and explicit.

## Architecture

```text
Hermes cron / Hermes chat
        ↓
X Hermes Tool: MCP + CLI
        ↓
xurl CLI: OAuth, token refresh, X API calls
        ↓
X API
```

`xurl` handles:

- OAuth 2.0 PKCE
- token refresh
- app/account profiles
- X API request signing
- shortcut commands such as `xurl search`, `xurl reply`, `xurl whoami`
- raw X API v2 requests when shortcuts are insufficient

`X Hermes Tool` handles:

- setup orchestration
- search query config
- candidate scoring
- state database
- approval queue
- posting guardrails
- audit log
- opt-out tracking
- Hermes-facing MCP tool interface

## Repository Layout

```text
x-hermes/
  docs/
    spec.md
  apps/
    x-hermes-tool/
      package.json
      src/
        cli.ts
        mcp.ts
        config.ts
        xurl.ts
        setup.ts
        scanner.ts
        scoring.ts
        queue.ts
        guardrails.ts
        db.ts
        types.ts
      tests/
  package.json
  pnpm-workspace.yaml
  README.md
```

Recommended stack:

- TypeScript
- Node 24+
- pnpm
- SQLite for local durable state
- MCP stdio server for Hermes
- CLI for setup/manual operations
- Vitest for tests

## Setup Flow

Yes, the manual `xurl` setup can be included as part of our tool setup. The tool should drive the flow and run `xurl` commands behind the scenes, but it must collect secrets through an interactive terminal prompt or local TTY input, not through Hermes chat.

Target command:

```bash
x-hermes setup
```

Setup should be idempotent. Running it multiple times must check the existing system state, repair missing pieces when safe, and avoid overwriting working auth unless the user explicitly chooses to reconfigure.

Setup behavior:

1. Check platform support:

   - Linux and macOS are supported first.
   - Windows is not a first target unless `xurl` and Hermes support are verified there.
   - Print actionable errors for unsupported environments.

2. Check local runtime dependencies:

   - Node version satisfies the project requirement.
   - `xurl` is installed and on `PATH`.
   - SQLite storage path is writable.
   - Hermes is installed only if the user wants MCP/Hermes integration on that machine.

3. If `xurl` is missing, offer to install it:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash
   ```

   The tool should ask before downloading/installing dependencies. In non-interactive mode it should fail with instructions instead of installing.

4. Verify `xurl` is callable:

   ```bash
   xurl --help
   xurl auth status
   ```

5. Prompt the user locally for:

   - app profile name, default `x-hermes`
   - X username/handle
   - X OAuth Client ID
   - X OAuth Client Secret
   - redirect URI, default `http://localhost:8080/callback`

6. Run the equivalent of:

   ```bash
   xurl auth apps add x-hermes \
     --client-id YOUR_CLIENT_ID \
     --client-secret YOUR_CLIENT_SECRET \
     --redirect-uri http://localhost:8080/callback

   xurl auth oauth2 --app x-hermes YOUR_USERNAME
   xurl auth default x-hermes YOUR_USERNAME
   xurl whoami
   ```

7. Store non-secret tool config in `~/.config/x-hermes/config.yaml`. Legacy `config.json` may be read for migration, but new writes should be YAML:

   ```yaml
   xurlApp: x-hermes
   username: YOUR_USERNAME
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
   campaigns: []
   ```

8. Verify auth with:

   ```bash
   xurl auth status
   xurl whoami
   xurl search "your keyword lang:en -is:retweet" -n 3
   ```

9. If Hermes integration is requested, print or optionally install the MCP server config for Hermes. This should be opt-in because not every user will run Hermes on the same machine.

Recommended commands:

```bash
x-hermes doctor
x-hermes setup
x-hermes setup --with-hermes
x-hermes setup --check-only
```

`doctor` should never mutate state. `setup --check-only` should perform the same checks as setup but skip installs and auth changes.

Secret handling rules:

- Never read, parse, print, or upload `~/.xurl`.
- Never ask the user to paste Client ID/Secret into Hermes chat.
- Never pass secrets through command-line args when Hermes itself is invoking the tool.
- During local setup, command-line args to `xurl auth apps add` are acceptable because the user is running setup in their own terminal, but the tool should prefer hidden prompts where possible.
- Redact command output that could contain credentials before logging.

## X Developer App Requirements

The user still needs an X Developer account and an X app.

Recommended app settings:

- App type: Web app, automated app, or bot
- Redirect URI: `http://localhost:8080/callback`
- OAuth 2.0 enabled
- Production/pay-per-use package if X requires it for the chosen endpoints

Required scopes depend on feature phase:

MVP read/queue:

```text
tweet.read
users.read
offline.access
```

Posting after approval:

```text
tweet.write
tweet.read
users.read
offline.access
```

Additional actions later:

```text
like.write
bookmark.write
follows.write
dm.write
```

## Runtime Modes

### CLI

Useful for setup, debugging, manual approval, and operations.

Commands:

```bash
x-hermes setup
x-hermes status
x-hermes config init
x-hermes config show
x-hermes config validate
x-hermes campaigns add <id> --query <query> --reply-text <reply>
x-hermes campaigns run <id>
x-hermes run
x-hermes run --once
x-hermes service install
x-hermes scan --limit 25
x-hermes candidates list
x-hermes candidates show <tweet-id>
x-hermes draft <tweet-id> --text "Your reply text"
x-hermes approve <tweet-id> --by <actor> --reason "Reviewed manually"
x-hermes reject <tweet-id> --reason "low relevance"
x-hermes post-approved <tweet-id>
x-hermes opt-out add @user
x-hermes stats
```

### MCP

Hermes uses MCP tools for structured interaction.

MCP tools:

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

Posting MCP tool must be hard-gated. It should refuse unless all guardrails pass.

### Managed Runtime

The preferred continuous mode is managed by `x-hermes` itself:

```bash
x-hermes run
```

`x-hermes run` reads enabled YAML campaigns and scans every `runtime.scanIntervalMinutes`. It should support one-shot operation with `x-hermes run --once` and service installation with `x-hermes service install`.

Hermes cron can still invoke one-shot runs when desired:

```bash
x-hermes run --once
```

The tool itself must always check active hours and posting guardrails so a bad schedule cannot cause posting outside the allowed window.

## Candidate Lifecycle

Statuses:

```text
found
rejected
drafted
approval_pending
approved
posted
failed
skipped
```

Lifecycle:

1. Scanner finds a post.
2. Deterministic scoring accepts or skips it.
3. Hermes evaluates accepted candidates.
4. Hermes queues a draft or rejects it.
5. Human approves queued draft.
6. Tool posts only if guardrails pass.
7. Tool records the posted reply and audit event.

## Candidate Scoring

Inputs from X:

- post id
- post text
- author id
- author username
- author display name
- author verified status
- author account creation date
- author follower/following counts
- author listed count
- post public metrics: likes, replies, reposts, quotes, impressions when available
- post created time
- referenced tweets
- sensitive flag

Initial deterministic scoring:

```text
score = follower_score
      + engagement_score
      + verified_bonus
      + listed_bonus
      + relevance_bonus
      + opt_in_bonus
      - risk_penalties
```

Reject or skip when:

- author is below minimum followers
- account is too new
- post is sensitive
- text includes scam/giveaway/airdrop/seed phrase language
- author is on opt-out list
- we already replied to the author within cooldown
- candidate is duplicate or already processed

Hermes judgment should be used after deterministic filtering, not instead of it.

## Guardrails

Default guardrails:

```text
posting.maxRepliesPerDay: 120
posting.activeHours: 12h/day by default, configurable
quality.minimumFollowers: 1000
quality.minimumAccountAgeDays: 300
posting.perAuthorCooldownHours: 50
posting.blockDuplicateReplyText: true
posting.approvalMode: required by default
posting.requireOptInForAutoPost: true
posting.enabled: false by default
```

Posting must fail closed when:

- xurl auth is missing
- posting is disabled
- candidate is not approved
- daily cap reached
- outside active hours
- author cooldown active
- duplicate reply text risk is high
- candidate has unresolved risk flags
- candidate lacks opt-in evidence and the policy requires opt-in

## Policy Position

The first version should not autonomously reply to cold keyword-search results. X automation rules are strict around unsolicited automated replies. The safe default is:

```text
keyword search → score → Hermes review → draft queue → human approval → post
```

Autoposting should be limited to clear opt-in cases, for example:

- user mentioned our account
- user replied to our post
- user asked for our input
- user is part of a pre-approved allowlist/campaign

## Database

Use SQLite for MVP.

Tables:

```text
settings
watch_queries
scan_runs
candidates
authors
reply_drafts
posted_replies
opt_outs
audit_events
rate_limit_counters
```

Important indexes:

```text
candidates(tweet_id unique)
candidates(status, score)
authors(author_id unique)
posted_replies(posted_at)
posted_replies(author_id, posted_at)
opt_outs(username unique)
audit_events(created_at)
```

## xurl Wrapper

Implement a single internal module responsible for executing `xurl`.

Responsibilities:

- Build argv arrays without shell interpolation.
- Capture stdout/stderr.
- Parse JSON output.
- Normalize X API errors.
- Redact sensitive values from logs.
- Enforce command allowlist.

Allowed operations for MVP:

```text
xurl auth status
xurl whoami
xurl search <query> -n <limit>
xurl read <tweet-id>
xurl reply <tweet-id> <text>
xurl /2/tweets/search/recent?... raw GET if shortcut output is insufficient
```

No direct generic shell command exposure to Hermes.

## MVP Milestones

### M1: Setup + Status

- Scaffold repo.
- Add CLI.
- Install/check `xurl`.
- Interactive `x-hermes setup` wraps `xurl auth apps add`, `oauth2`, `default`, `whoami`.
- `x-hermes status` reports readiness without exposing secrets.

### M2: Search + Store

- Add SQLite.
- Add watch query config.
- Run `xurl search` or raw recent-search endpoint.
- Store candidates and authors.
- Cursor/dedup support.

### M3: Scoring + Queue

- Deterministic score/risk flags.
- Candidate list/show commands.
- Queue/reject commands.

### M4: Hermes MCP

- MCP server exposes read/queue/reject/stats tools.
- Hermes can evaluate candidates and queue drafts.

### M5: Approval + Posting

- Human approval CLI.
- `post-approved` calls `xurl reply`.
- Guardrails and audit log enforced.

### M6: Operations

- YAML-first config for campaigns, runtime, posting, quality, and notifications.
- Managed `x-hermes run` daemon mode.
- User service installation for Linux systemd and macOS launchd.
- Messaging-gateway approval and notification adapters.
- Optional dashboard later.

## Open Questions

- What exact account will run this, and should it be branded as automated/AI-assisted?
- Which X API plan/endpoints are available on the account?
- What are the first watch queries?
- Should the default reply be a fixed phrase, or should Hermes draft contextual replies?
- Should M1/M2 live entirely in this repo, or should we publish a reusable npm package later?
- Do we want approval through CLI only first, or through Telegram/Slack/Hermes gateway?
