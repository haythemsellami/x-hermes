import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDatabasePath, openXHermesDatabase, type XHermesDatabase } from "../src/db.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("database", () => {
  it("creates the spec schema and reports the current version", async () => {
    const db = await openTestDb();
    try {
      expect(db.schemaVersion()).toBe(2);
      expect(db.listWatchQueries()).toEqual([]);
      expect(db.listCandidates()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("stores settings and watch queries", async () => {
    const db = await openTestDb();
    try {
      db.setSetting("example", { enabled: true });
      expect(db.getSetting("example")).toEqual({ enabled: true });

      const query = db.upsertWatchQuery({
        name: "Monad",
        query: "monad lang:en -is:retweet"
      });
      expect(query.enabled).toBe(true);
      expect(query.lastCursor).toBeUndefined();

      db.updateWatchQueryCursor(query.id, "cursor-1");
      expect(db.getWatchQuery(query.id)?.lastCursor).toBe("cursor-1");
      expect(db.listWatchQueries({ enabledOnly: true })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("upserts authors and candidates idempotently", async () => {
    const db = await openTestDb();
    try {
      db.upsertAuthor({
        authorId: "user-1",
        username: "alice",
        displayName: "Alice",
        verified: true,
        followersCount: 1200
      });

      const first = db.upsertCandidate({
        tweetId: "tweet-1",
        authorId: "user-1",
        authorUsername: "alice",
        text: "hello monad",
        status: "found",
        score: 12,
        riskFlags: [],
        sensitive: false,
        publicMetrics: { like_count: 3 }
      });
      expect(first.score).toBe(12);
      expect(first.publicMetrics).toEqual({ like_count: 3 });

      const second = db.upsertCandidate({
        tweetId: "tweet-1",
        authorId: "user-1",
        authorUsername: "alice",
        text: "updated text",
        status: "found",
        score: 18,
        riskFlags: ["verified_author"],
        sensitive: false
      });

      expect(second.text).toBe("updated text");
      expect(second.score).toBe(18);
      expect(second.riskFlags).toEqual(["verified_author"]);
      expect(db.listCandidates({ status: "found" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("records drafts, opt-outs, audit events, posted replies, and counters", async () => {
    const db = await openCandidateDb();
    try {
      const draft = db.createReplyDraft({
        tweetId: "tweet-1",
        text: "Thanks for asking.",
        draftedBy: "test"
      });
      expect(draft.status).toBe("approval_pending");
      expect(db.getLatestDraftForCandidate("tweet-1")?.id).toBe(draft.id);
      expect(db.getCandidate("tweet-1")?.status).toBe("approval_pending");

      const request = db.createApprovalRequest({
        tweetId: "tweet-1",
        draftId: draft.id,
        requestedBy: "test"
      });
      expect(request.status).toBe("pending");
      expect(db.listApprovalRequests({ status: "pending" })).toHaveLength(1);
      db.updateApprovalDelivery({
        id: request.id,
        channel: "telegram",
        recipient: "user-1",
        externalMessageId: "msg-1",
        deliveryStatus: "sent"
      });
      expect(db.getApprovalRequest(request.id)?.deliveryStatus).toBe("sent");

      db.updateDraftStatus(draft.id, "approved");
      expect(db.getReplyDraft(draft.id)?.status).toBe("approved");
      db.decideApprovalRequest({
        id: request.id,
        status: "approved",
        decidedBy: "human",
        reason: "looks good",
        labels: ["approved", "good_fit"]
      });
      db.recordFeedbackExample({
        approvalRequestId: request.id,
        tweetId: "tweet-1",
        draftId: draft.id,
        decision: "approved",
        reason: "looks good",
        labels: ["approved", "good_fit"],
        candidateText: "hello monad",
        draftText: "Thanks for asking.",
        sourceQuery: "monad",
        authorUsername: "alice"
      });
      expect(db.getFeedbackProfile().totals.approved).toBe(1);

      db.addOptOut({ username: "@Alice", authorId: "user-1", reason: "manual request" });
      expect(db.isOptedOut("alice")).toBe(true);
      expect(db.isOptedOut("@ALICE")).toBe(true);

      const event = db.recordAuditEvent({
        eventType: "candidate.approved",
        actor: "tester",
        entityType: "candidate",
        entityId: "tweet-1",
        details: { draftId: draft.id }
      });
      expect(event.details).toEqual({ draftId: draft.id });
      expect(db.listAuditEvents()).toHaveLength(1);

      db.recordPostedReply({
        tweetId: "tweet-1",
        authorId: "user-1",
        draftId: draft.id,
        replyTweetId: "reply-1",
        replyText: "Thanks for asking."
      });
      expect(db.countPostedRepliesSince("1970-01-01T00:00:00.000Z")).toBe(1);
      expect(db.latestPostedReplyForAuthor("user-1")?.replyText).toBe("Thanks for asking.");

      expect(db.incrementRateLimitCounter("daily-posts", "2026-06-10")).toBe(1);
      expect(db.incrementRateLimitCounter("daily-posts", "2026-06-10", 2)).toBe(3);
    } finally {
      db.close();
    }
  });

  it("resolves the default database path under the configured data directory", async () => {
    const root = await tempDir();
    expect(getDatabasePath({ X_HERMES_DATA_DIR: root })).toBe(
      path.join(root, "x-hermes.sqlite")
    );
  });
});

async function openCandidateDb(): Promise<XHermesDatabase> {
  const db = await openTestDb();
  db.upsertAuthor({
    authorId: "user-1",
    username: "alice"
  });
  db.upsertCandidate({
    tweetId: "tweet-1",
    authorId: "user-1",
    authorUsername: "alice",
    text: "hello monad",
    status: "found",
    score: 10,
    riskFlags: [],
    sensitive: false
  });
  return db;
}

async function openTestDb(): Promise<XHermesDatabase> {
  const root = await tempDir();
  return await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-db-test-"));
  tempDirs.push(dir);
  return dir;
}
