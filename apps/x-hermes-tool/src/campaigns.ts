import { loadConfig, validateConfig } from "./config.js";
import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
import { evaluatePostingGuardrails } from "./guardrails.js";
import { notify } from "./notifications.js";
import { postApprovedReply } from "./posting.js";
import { approveCandidate, queueReplyDraft } from "./queue.js";
import { scanRecentPosts } from "./scanner.js";
import type {
  ApprovalMode,
  CampaignConfig,
  GuardrailFailure,
  ReplyDraftRecord,
  StoredCandidateRecord,
  XHermesConfig
} from "./types.js";

export type CampaignAction =
  | "dry_run"
  | "approval_requested"
  | "posted"
  | "blocked"
  | "failed"
  | "no_candidates";

export interface CampaignCandidateResult {
  tweetId?: string;
  authorUsername?: string;
  score?: number;
  action: CampaignAction;
  draftId?: string;
  approvalRequestId?: string;
  replyTweetId?: string;
  reason?: string;
  guardrailFailures?: GuardrailFailure[];
}

export interface CampaignRunResult {
  campaignId: string;
  query: string;
  fetched: number;
  selected: number;
  results: CampaignCandidateResult[];
}

export interface CampaignRunSummary {
  mode: "once";
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  campaigns: CampaignRunResult[];
}

export interface CampaignRunOptions {
  campaignId?: string;
  env?: NodeJS.ProcessEnv;
  db?: XHermesDatabase;
  output?: NodeJS.WritableStream;
  now?: Date;
}

export interface CampaignDaemonOptions extends CampaignRunOptions {
  intervalMinutes?: number;
  signal?: AbortSignal;
}

export async function runCampaignsOnce(options: CampaignRunOptions = {}): Promise<CampaignRunSummary> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig(env);
  const validationErrors = validateConfig(loaded.config);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid x-hermes config:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`);
  }

  const campaigns = selectCampaigns(loaded.config, options.campaignId);
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env }));
  const startedAt = new Date().toISOString();

  try {
    const results: CampaignRunResult[] = [];
    for (const campaign of campaigns) {
      results.push(
        await runSingleCampaign({
          config: loaded.config,
          campaign,
          env,
          db,
          output: options.output,
          now: options.now
        })
      );
    }

    return {
      mode: "once",
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: results.every((result) => result.results.every((item) => item.action === "dry_run")),
      campaigns: results
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function runCampaignDaemon(
  options: CampaignDaemonOptions = {}
): Promise<CampaignRunSummary[]> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig(env);
  const intervalMinutes = options.intervalMinutes ?? loaded.config.runtime.scanIntervalMinutes;
  const summaries: CampaignRunSummary[] = [];

  while (!options.signal?.aborted) {
    try {
      summaries.push(
        await runCampaignsOnce({
          campaignId: options.campaignId,
          env,
          db: options.db,
          output: options.output,
          now: options.now
        })
      );
    } catch (error) {
      await notify(
        loaded.config,
        "error",
        {
          title: "Campaign run failed",
          message: error instanceof Error ? error.message : String(error)
        },
        { env, output: options.output }
      );
      if (options.signal?.aborted) {
        break;
      }
    }

    await sleep(intervalMinutes * 60_000, options.signal);
  }

  return summaries;
}

function selectCampaigns(config: XHermesConfig, campaignId: string | undefined): CampaignConfig[] {
  const enabled = config.campaigns.filter((campaign) => campaign.enabled);
  if (!campaignId) {
    if (enabled.length === 0) {
      throw new Error("No enabled campaigns configured. Add one with x-hermes campaigns add.");
    }
    return enabled;
  }

  const campaign = config.campaigns.find((item) => item.id === campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  if (!campaign.enabled) {
    throw new Error(`Campaign is disabled: ${campaignId}`);
  }
  return [campaign];
}

async function runSingleCampaign(input: {
  config: XHermesConfig;
  campaign: CampaignConfig;
  env: NodeJS.ProcessEnv;
  db: XHermesDatabase;
  output?: NodeJS.WritableStream;
  now?: Date;
}): Promise<CampaignRunResult> {
  const effectiveConfig = campaignConfig(input.config, input.campaign);
  const scan = await scanRecentPosts({
    query: input.campaign.query,
    limit: input.campaign.fetchLimit,
    env: input.env,
    db: input.db
  });
  const candidates = scan.runs.flatMap((run) => run.candidates);
  const selected = selectCandidates(candidates, input.campaign.postLimit);
  const result: CampaignRunResult = {
    campaignId: input.campaign.id,
    query: input.campaign.query,
    fetched: candidates.length,
    selected: selected.length,
    results: []
  };

  if (selected.length === 0) {
    result.results.push({ action: "no_candidates", reason: "No eligible found candidates." });
    return result;
  }

  const dryRun = input.campaign.dryRun ?? input.config.runtime.dryRun;
  for (const candidate of selected) {
    if (dryRun) {
      result.results.push({
        action: "dry_run",
        tweetId: candidate.tweetId,
        authorUsername: candidate.authorUsername,
        score: candidate.score,
        reason: "runtime.dryRun or campaign.dryRun is enabled."
      });
      continue;
    }

    const approvalMode = input.campaign.approvalMode ?? input.config.posting.approvalMode;
    const preflight = previewPostingGuardrails({
      config: effectiveConfig,
      db: input.db,
      candidate,
      replyText: input.campaign.replyText,
      now: input.now
    });
    const requiresApproval =
      approvalMode === "required" ||
      (approvalMode === "opt_in_auto_post" &&
        preflight.failures.some((failure) => failure.id === "missing_opt_in"));

    if (requiresApproval) {
      const draft = await queueReplyDraft({
        tweetId: candidate.tweetId,
        text: input.campaign.replyText,
        draftedBy: `campaign:${input.campaign.id}`,
        db: input.db,
        env: input.env
      });
      const request = input.db.getLatestPendingApprovalRequestForCandidate(candidate.tweetId);
      if (request) {
        await notify(
          input.config,
          "approval_request",
          {
            title: `Approval requested for @${candidate.authorUsername}`,
            message: request.messageText ?? `Approval request ${request.id} for ${candidate.tweetId}`,
            data: {
              campaignId: input.campaign.id,
              tweetId: candidate.tweetId,
              approvalRequestId: request.id,
              draftId: draft.id,
              authorUsername: candidate.authorUsername,
              replyText: draft.text,
              url: candidate.url
            }
          },
          { env: input.env, output: input.output }
        );
      }
      result.results.push({
        action: "approval_requested",
        tweetId: candidate.tweetId,
        authorUsername: candidate.authorUsername,
        score: candidate.score,
        draftId: draft.id,
        approvalRequestId: request?.id
      });
      continue;
    }

    if (!preflight.allowed) {
      result.results.push({
        action: "blocked",
        tweetId: candidate.tweetId,
        authorUsername: candidate.authorUsername,
        score: candidate.score,
        guardrailFailures: preflight.failures,
        reason: preflight.failures.map((failure) => failure.id).join(", ")
      });
      continue;
    }

    try {
      const draft = await queueReplyDraft({
        tweetId: candidate.tweetId,
        text: input.campaign.replyText,
        draftedBy: `campaign:${input.campaign.id}`,
        db: input.db,
        env: input.env
      });
      await approveCandidate({
        tweetId: candidate.tweetId,
        approvedBy: `campaign:${input.campaign.id}`,
        reason: "Auto-approved by campaign configuration.",
        db: input.db,
        env: input.env
      });
      const posted = await postApprovedReply({
        tweetId: candidate.tweetId,
        actor: `campaign:${input.campaign.id}`,
        db: input.db,
        env: input.env,
        now: input.now,
        config: effectiveConfig
      });

      if (!posted.posted) {
        result.results.push({
          action: "blocked",
          tweetId: candidate.tweetId,
          authorUsername: candidate.authorUsername,
          score: candidate.score,
          draftId: draft.id,
          guardrailFailures: posted.guardrails.failures,
          reason: posted.guardrails.failures.map((failure) => failure.id).join(", ")
        });
        continue;
      }

      await notify(
        input.config,
        "post",
        {
          title: `Posted reply to @${candidate.authorUsername}`,
          message: [
            `Campaign: ${input.campaign.id}`,
            `Tweet: ${candidate.url ?? candidate.tweetId}`,
            `Reply: ${input.campaign.replyText}`,
            `Reply tweet id: ${posted.replyTweetId ?? "unknown"}`
          ].join("\n"),
          data: {
            campaignId: input.campaign.id,
            tweetId: candidate.tweetId,
            replyTweetId: posted.replyTweetId,
            authorUsername: candidate.authorUsername,
            replyText: input.campaign.replyText,
            url: candidate.url
          }
        },
        { env: input.env, output: input.output }
      );

      result.results.push({
        action: "posted",
        tweetId: candidate.tweetId,
        authorUsername: candidate.authorUsername,
        score: candidate.score,
        draftId: draft.id,
        replyTweetId: posted.replyTweetId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await notify(
        input.config,
        "error",
        {
          title: `Campaign ${input.campaign.id} failed for ${candidate.tweetId}`,
          message,
          data: {
            campaignId: input.campaign.id,
            tweetId: candidate.tweetId,
            authorUsername: candidate.authorUsername
          }
        },
        { env: input.env, output: input.output }
      );
      result.results.push({
        action: "failed",
        tweetId: candidate.tweetId,
        authorUsername: candidate.authorUsername,
        score: candidate.score,
        reason: message
      });
    }
  }

  return result;
}

function selectCandidates(candidates: StoredCandidateRecord[], limit: number): StoredCandidateRecord[] {
  return candidates
    .filter((candidate) => candidate.status === "found" && candidate.riskFlags.length === 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return new Date(right.foundAt).getTime() - new Date(left.foundAt).getTime();
    })
    .slice(0, Math.max(0, limit));
}

function campaignConfig(config: XHermesConfig, campaign: CampaignConfig): XHermesConfig {
  const posting = {
    ...config.posting,
    approvalMode: campaign.approvalMode ?? config.posting.approvalMode,
    maxRepliesPerRun: campaign.postLimit,
    requireOptInForAutoPost:
      campaign.requireOptInForAutoPost ?? config.posting.requireOptInForAutoPost
  };
  return {
    ...config,
    posting,
    activeHours: posting.activeHours,
    maxRepliesPerDay: posting.maxRepliesPerDay,
    postingEnabled: posting.enabled,
    perAuthorCooldownHours: posting.perAuthorCooldownHours,
    blockDuplicateReplyText: posting.blockDuplicateReplyText,
    requireOptInForAutoPost: posting.requireOptInForAutoPost,
    requireApprovalForKeywordSearch: posting.approvalMode !== "none"
  };
}

function previewPostingGuardrails(input: {
  config: XHermesConfig;
  db: XHermesDatabase;
  candidate: StoredCandidateRecord;
  replyText: string;
  now?: Date;
}) {
  const timestamp = new Date().toISOString();
  const draft: ReplyDraftRecord = {
    id: "preview",
    tweetId: input.candidate.tweetId,
    text: input.replyText,
    draftedBy: "x-hermes-preview",
    status: "approved",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return evaluatePostingGuardrails({
    config: input.config,
    db: input.db,
    candidate: {
      ...input.candidate,
      status: "approved"
    },
    draft,
    now: input.now
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
