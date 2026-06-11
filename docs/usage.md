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

Setup checks Node.js, platform support, storage, `xurl`, and X auth. Secrets are collected only through local prompts. `xurl` stores OAuth data in `~/.xurl`; `x-hermes` stores non-secret config in `~/.config/x-hermes/config.yaml`.

Non-mutating checks:

```bash
x-hermes doctor
x-hermes setup --check-only
```

Hermes MCP config helper:

```bash
x-hermes setup --with-hermes
```

## 3. Configure YAML, Campaigns, and Watch Queries

`x-hermes` supports two configuration styles:

- use CLI commands that update local YAML for you
- edit `~/.config/x-hermes/config.yaml` directly, then run `x-hermes config validate`

Create or migrate the YAML config:

```bash
x-hermes config init
x-hermes config show
x-hermes config validate
```

Set a single value:

```bash
x-hermes config set runtime.scanIntervalMinutes 60
x-hermes config set posting.enabled false
```

Campaigns are the preferred way to run repeatable scan/reply workflows:

```bash
x-hermes campaigns add "example" \
  --query '"your topic" lang:en -is:retweet' \
  --reply-text "Thanks for sharing." \
  --fetch-limit 25 \
  --limit 5
```

List or inspect campaigns:

```bash
x-hermes campaigns list
x-hermes campaigns show example
```

Run one campaign once:

```bash
x-hermes campaigns run example
```

Run all enabled campaigns once:

```bash
x-hermes run --once
```

Run continuously using `runtime.scanIntervalMinutes`:

```bash
x-hermes run
```

Install a user service for continuous operation:

```bash
x-hermes service install
x-hermes service status
```

Example YAML:

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
    - id: hermes
      type: hermes
      enabled: false
      target: telegram
      events: [post, error, approval_request]
campaigns:
  - id: example
    enabled: true
    query: '"your topic" lang:en -is:retweet'
    replyText: "Thanks for sharing."
    fetchLimit: 25
    postLimit: 5
    approvalMode: required
```

Watch queries remain useful for manual scans and MCP-driven workflows.

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

Queueing a draft also creates an approval request. Review pending requests:

```bash
x-hermes approvals list --status pending
x-hermes approvals show <approval-request-id>
x-hermes approvals message <approval-request-id>
```

Approve after review:

```bash
x-hermes approve <tweet-id> --by <human> --reason "Reviewed manually"
```

Or approve/reject the request directly:

```bash
x-hermes approvals approve <approval-request-id> --by <human> --reason "Specific and useful"
x-hermes approvals reject <approval-request-id> --by <human> --reason "low relevance"
```

Edit a pending draft before deciding:

```bash
x-hermes approvals edit <approval-request-id> --text "Updated reply text" --by <human>
```

Messaging gateways can use the same state machine by rendering the request,
delivering it through any channel, and applying the human response:

```bash
x-hermes approvals deliver <approval-request-id> --status sent --channel telegram --recipient <user-id> --external-id <message-id>
x-hermes approvals respond <approval-request-id> --message "approve: looks good" --by <human>
x-hermes approvals respond <approval-request-id> --message "reject: too generic" --by <human>
x-hermes approvals respond <approval-request-id> --message "edit: Better reply text" --by <human>
```

Approval does not post. It only marks the candidate and latest draft as approved.
Approval and rejection reasons are stored as feedback examples. Use them as LLM
drafting context:

```bash
x-hermes feedback profile
x-hermes feedback examples --decision rejected
```

## 7. Guarded Posting

Posting is disabled by default:

```yaml
posting:
  enabled: false
```

To enable posting, edit the local non-secret config or use `config set`:

```bash
x-hermes config set posting.enabled true
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

For explicit no-approval campaigns, configure both the approval mode and opt-in policy intentionally:

```bash
x-hermes campaigns add "example-auto" \
  --query '"your topic" lang:en -is:retweet' \
  --reply-text "Thanks for sharing." \
  --no-approval \
  --allow-cold-replies \
  --limit 5
```

Then set:

```bash
x-hermes config set runtime.dryRun false
x-hermes config set posting.enabled true
```

This is deliberately explicit because automated replies to cold keyword searches can have platform-policy and reputation risk.

## 8. Notifications Through Hermes Gateway

`x-hermes` decides when a notification should be sent. Hermes owns delivery to Telegram, WhatsApp, Slack, Discord, and other configured gateways.

Example:

```yaml
notifications:
  onPost: true
  onError: true
  onApprovalRequest: true
  channels:
    - id: hermes
      type: hermes
      enabled: true
      target: telegram
      events: [post, error, approval_request]
```

The `target` value is passed to `hermes send --to`. Examples: `telegram`, `telegram:<chat_id>`, `discord:#ops`, `slack:#eng`, or `whatsapp:<recipient>`.

## 9. MCP

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

MCP posting is hard-gated. `post_approved_reply` returns an error result when guardrails block posting.

## 10. Development Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use fake `xurl` binaries and temp config/data directories. They do not require live X credentials.
