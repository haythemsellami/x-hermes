import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  editApprovalRequestDraft,
  getApprovalRequestDetails,
  parseApprovalResponse,
  processApprovalResponse,
  renderApprovalRequestMessage
} from "../src/approvals.js";
import { openXHermesDatabase, type XHermesDatabase } from "../src/db.js";
import { queueReplyDraft } from "../src/queue.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("approvals", () => {
  it("creates and renders approval requests when drafts are queued", async () => {
    const db = await openCandidateDb();
    try {
      const draft = await queueReplyDraft({
        tweetId: "tweet-1",
        text: "A useful answer.",
        draftedBy: "hermes",
        db
      });
      const request = db.getLatestPendingApprovalRequestForCandidate("tweet-1");
      expect(request?.draftId).toBe(draft.id);

      const details = await getApprovalRequestDetails({ id: request?.id ?? "", db });
      const message = renderApprovalRequestMessage(details);
      expect(message).toContain("x-hermes approval request");
      expect(message).toContain("Draft reply:");
      expect(message).toContain("approve: reason");
    } finally {
      db.close();
    }
  });

  it("parses and applies approval responses with feedback labels", async () => {
    const db = await openCandidateDb();
    try {
      await queueReplyDraft({
        tweetId: "tweet-1",
        text: "A useful answer.",
        draftedBy: "hermes",
        db
      });
      const request = db.getLatestPendingApprovalRequestForCandidate("tweet-1");
      const result = await processApprovalResponse({
        id: request?.id ?? "",
        message: "reject: low relevance and too generic",
        actor: "human",
        channel: "telegram",
        db
      });

      expect(result.parsed.action).toBe("reject");
      expect(result.request.status).toBe("rejected");
      expect(result.request.decisionLabels).toContain("low_relevance");
      expect(result.request.decisionLabels).toContain("too_generic");
      expect(db.getFeedbackProfile().labels.low_relevance).toBe(1);
    } finally {
      db.close();
    }
  });

  it("edits a pending draft before approval", async () => {
    const db = await openCandidateDb();
    try {
      await queueReplyDraft({
        tweetId: "tweet-1",
        text: "Original.",
        draftedBy: "hermes",
        db
      });
      const request = db.getLatestPendingApprovalRequestForCandidate("tweet-1");
      const edited = await editApprovalRequestDraft({
        id: request?.id ?? "",
        text: "Edited reply.",
        editedBy: "human",
        db
      });

      expect(edited.draft.text).toBe("Edited reply.");
      expect(edited.message).toContain("Edited reply.");
    } finally {
      db.close();
    }
  });

  it("parses short approval response forms", () => {
    expect(parseApprovalResponse("approve")).toEqual({ action: "approve" });
    expect(parseApprovalResponse("approve: reviewed")).toEqual({
      action: "approve",
      reason: "reviewed"
    });
    expect(parseApprovalResponse("deny: unsafe claim")).toEqual({
      action: "reject",
      reason: "unsafe claim"
    });
    expect(parseApprovalResponse("edit: Better reply.")).toEqual({
      action: "edit",
      text: "Better reply."
    });
  });
});

async function openCandidateDb(): Promise<XHermesDatabase> {
  const root = await tempDir();
  const db = await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
  db.upsertAuthor({
    authorId: "user-1",
    username: "alice",
    followersCount: 1000
  });
  db.upsertCandidate({
    tweetId: "tweet-1",
    authorId: "user-1",
    authorUsername: "alice",
    text: "Can Predikt help here?",
    status: "found",
    score: 10,
    riskFlags: [],
    sensitive: false,
    sourceQuery: "@Prediktxyz -is:retweet"
  });
  return db;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-approvals-test-"));
  tempDirs.push(dir);
  return dir;
}
