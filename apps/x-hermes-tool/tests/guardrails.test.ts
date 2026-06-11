import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openXHermesDatabase } from "../src/db.js";
import { evaluatePostingGuardrails, isWithinActiveHours } from "../src/guardrails.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("guardrails", () => {
  it("checks active hours in the configured timezone", () => {
    const config = {
      ...DEFAULT_CONFIG,
      activeHours: {
        start: "09:00",
        end: "21:00",
        timezone: "America/New_York"
      }
    };

    expect(isWithinActiveHours(config, new Date("2026-06-10T15:00:00.000Z"))).toBe(true);
    expect(isWithinActiveHours(config, new Date("2026-06-10T02:00:00.000Z"))).toBe(false);
  });

  it("fails closed when posting is disabled or opt-in evidence is missing", async () => {
    const db = await openCandidateDb();
    try {
      const candidate = db.getCandidate("tweet-1");
      const draft = db.getLatestDraftForCandidate("tweet-1");
      if (!candidate) {
        throw new Error("missing candidate");
      }

      const result = evaluatePostingGuardrails({
        config: {
          ...DEFAULT_CONFIG,
          username: "xhermes",
          postingEnabled: false
        },
        db,
        candidate,
        draft,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(result.allowed).toBe(false);
      expect(result.failures.map((failure) => failure.id)).toContain("posting_disabled");
      expect(result.failures.map((failure) => failure.id)).toContain("missing_opt_in");
    } finally {
      db.close();
    }
  });

  it("can disable duplicate reply text blocking", async () => {
    const db = await openCandidateDb();
    try {
      const candidate = db.getCandidate("tweet-1");
      const draft = db.getLatestDraftForCandidate("tweet-1");
      if (!candidate || !draft) {
        throw new Error("missing candidate or draft");
      }
      db.recordPostedReply({
        tweetId: "tweet-1",
        authorId: "user-1",
        draftId: draft.id,
        replyTweetId: "reply-old",
        replyText: draft.text
      });

      const blocked = evaluatePostingGuardrails({
        config: {
          ...DEFAULT_CONFIG,
          username: "xhermes",
          postingEnabled: true,
          requireOptInForAutoPost: false,
          activeHours: { start: "00:00", end: "23:59", timezone: "UTC" }
        },
        db,
        candidate,
        draft,
        now: new Date("2026-06-10T15:00:00.000Z")
      });
      expect(blocked.failures.map((failure) => failure.id)).toContain("duplicate_reply_text");

      const allowedDuplicateText = evaluatePostingGuardrails({
        config: {
          ...DEFAULT_CONFIG,
          username: "xhermes",
          postingEnabled: true,
          blockDuplicateReplyText: false,
          requireOptInForAutoPost: false,
          activeHours: { start: "00:00", end: "23:59", timezone: "UTC" }
        },
        db,
        candidate,
        draft,
        now: new Date("2026-06-10T15:00:00.000Z")
      });
      expect(allowedDuplicateText.failures.map((failure) => failure.id)).not.toContain(
        "duplicate_reply_text"
      );
    } finally {
      db.close();
    }
  });
});

async function openCandidateDb() {
  const root = await tempDir();
  const db = await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
  db.upsertAuthor({ authorId: "user-1", username: "alice" });
  db.upsertCandidate({
    tweetId: "tweet-1",
    authorId: "user-1",
    authorUsername: "alice",
    text: "hello",
    status: "approved",
    score: 10,
    riskFlags: [],
    sensitive: false
  });
  db.createReplyDraft({
    tweetId: "tweet-1",
    text: "reply",
    draftedBy: "test",
    status: "approved"
  });
  return db;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-guardrails-test-"));
  tempDirs.push(dir);
  return dir;
}
