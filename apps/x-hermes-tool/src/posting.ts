import { loadConfig } from "./config.js";
import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
import { evaluatePostingGuardrails } from "./guardrails.js";
import { buildReplyBody } from "./xapi.js";
import { runXurl } from "./xurl.js";
import type { GuardrailResult } from "./types.js";

export interface PostApprovedReplyOptions {
  tweetId: string;
  actor: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface PostApprovedReplyResult {
  posted: boolean;
  tweetId: string;
  replyTweetId?: string;
  guardrails: GuardrailResult;
}

export async function postApprovedReply(
  options: PostApprovedReplyOptions
): Promise<PostApprovedReplyResult> {
  const env = options.env ?? process.env;
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env }));

  try {
    const loaded = await loadConfig(env);
    const candidate = db.getCandidate(options.tweetId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${options.tweetId}`);
    }
    const draft = db.getLatestDraftForCandidate(options.tweetId);
    const guardrails = evaluatePostingGuardrails({
      config: loaded.config,
      db,
      candidate,
      draft,
      now: options.now
    });

    const auth = await runXurl(["auth", "status"], { timeoutMs: 15_000, env });
    if (!auth.ok) {
      guardrails.failures.push({
        id: "xurl_auth_missing",
        message: "xurl auth status failed."
      });
      guardrails.allowed = false;
    }

    if (!guardrails.allowed) {
      db.recordAuditEvent({
        eventType: "post.blocked",
        actor: options.actor,
        entityType: "candidate",
        entityId: options.tweetId,
        details: { failures: guardrails.failures }
      });
      return {
        posted: false,
        tweetId: options.tweetId,
        guardrails
      };
    }

    if (!draft) {
      throw new Error("Invariant violation: guardrails allowed posting without a draft.");
    }

    const reply = await runXurl(
      ["-X", "POST", "/2/tweets", "-d", buildReplyBody(options.tweetId, draft.text)],
      {
        timeoutMs: 30_000,
        env
      }
    );
    if (!reply.ok) {
      const output = (reply.stderr || reply.stdout || "xurl reply failed").trim();
      db.updateCandidateStatus(options.tweetId, "failed");
      db.recordAuditEvent({
        eventType: "post.failed",
        actor: options.actor,
        entityType: "candidate",
        entityId: options.tweetId,
        details: { error: output }
      });
      throw new Error(output);
    }

    const replyTweetId = parseReplyTweetId(reply.stdout) ?? "unknown";
    db.recordPostedReply({
      tweetId: options.tweetId,
      authorId: candidate.authorId,
      draftId: draft.id,
      replyTweetId,
      replyText: draft.text,
      raw: parseJsonMaybe(reply.stdout)
    });
    db.updateDraftStatus(draft.id, "posted");
    db.updateCandidateStatus(options.tweetId, "posted");
    db.recordAuditEvent({
      eventType: "post.succeeded",
      actor: options.actor,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { draftId: draft.id, replyTweetId }
    });

    return {
      posted: true,
      tweetId: options.tweetId,
      replyTweetId,
      guardrails
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

function parseReplyTweetId(stdout: string): string | undefined {
  const parsed = parseJsonMaybe(stdout);
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    return (
      asString(object.id) ??
      asString(object.reply_tweet_id) ??
      asString((object.data as Record<string, unknown> | undefined)?.id)
    );
  }
  return undefined;
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
