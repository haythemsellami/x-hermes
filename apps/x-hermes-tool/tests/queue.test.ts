import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openXHermesDatabase, type XHermesDatabase } from "../src/db.js";
import {
  approveCandidate,
  getCandidateDetails,
  queueReplyDraft,
  recordOptOut,
  rejectCandidate
} from "../src/queue.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("queue", () => {
  it("queues and approves a reply draft", async () => {
    const db = await openCandidateDb();
    try {
      const draft = await queueReplyDraft({
        tweetId: "tweet-1",
        text: "A useful answer.",
        draftedBy: "hermes",
        db
      });
      expect(draft.status).toBe("approval_pending");
      expect(db.getCandidate("tweet-1")?.status).toBe("approval_pending");

      const approved = await approveCandidate({
        tweetId: "tweet-1",
        approvedBy: "human",
        reason: "reviewed",
        db
      });
      expect(approved.status).toBe("approved");
      expect(db.getCandidate("tweet-1")?.status).toBe("approved");
      expect(db.listAuditEvents()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("returns candidate details with the latest draft", async () => {
    const db = await openCandidateDb();
    try {
      await queueReplyDraft({
        tweetId: "tweet-1",
        text: "Draft text.",
        draftedBy: "hermes",
        db
      });
      const details = await getCandidateDetails({ tweetId: "tweet-1", db });
      expect(details.candidate.tweetId).toBe("tweet-1");
      expect(details.draft?.text).toBe("Draft text.");
    } finally {
      db.close();
    }
  });

  it("rejects candidates and records opt-outs", async () => {
    const db = await openCandidateDb();
    try {
      await rejectCandidate({
        tweetId: "tweet-1",
        actor: "human",
        reason: "low relevance",
        db
      });
      expect(db.getCandidate("tweet-1")?.status).toBe("rejected");

      await recordOptOut({
        username: "@Alice",
        actor: "human",
        reason: "asked",
        db
      });
      expect(db.isOptedOut("alice")).toBe(true);
      expect(db.listAuditEvents()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

async function openCandidateDb(): Promise<XHermesDatabase> {
  const root = await tempDir();
  const db = await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
  db.upsertAuthor({
    authorId: "user-1",
    username: "alice"
  });
  db.upsertCandidate({
    tweetId: "tweet-1",
    authorId: "user-1",
    authorUsername: "alice",
    text: "hello",
    status: "found",
    score: 10,
    riskFlags: [],
    sensitive: false
  });
  return db;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-queue-test-"));
  tempDirs.push(dir);
  return dir;
}

