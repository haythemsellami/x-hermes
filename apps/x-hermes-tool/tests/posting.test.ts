import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveConfig } from "../src/config.js";
import { openXHermesDatabase, type XHermesDatabase } from "../src/db.js";
import { postApprovedReply } from "../src/posting.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("posting", () => {
  it("blocks approved drafts when posting is disabled", async () => {
    const fixture = await createFixture();
    const db = await openCandidateDb(fixture.root, "hello @xhermes");
    await saveConfig(
      {
        ...DEFAULT_CONFIG,
        username: "xhermes",
        postingEnabled: false
      },
      fixture.env
    );

    try {
      const result = await postApprovedReply({
        tweetId: "tweet-1",
        actor: "test",
        db,
        env: fixture.env,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(result.posted).toBe(false);
      expect(result.guardrails.failures.map((failure) => failure.id)).toContain("posting_disabled");
      await expect(readFile(fixture.xurlLogPath, "utf8")).resolves.not.toContain("reply");
    } finally {
      db.close();
    }
  });

  it("posts approved drafts when all guardrails pass", async () => {
    const fixture = await createFixture();
    const db = await openCandidateDb(fixture.root, "hello @xhermes");
    await saveConfig(
      {
        ...DEFAULT_CONFIG,
        username: "xhermes",
        postingEnabled: true,
        requireOptInForAutoPost: true,
        activeHours: {
          start: "00:00",
          end: "23:59",
          timezone: "UTC"
        }
      },
      fixture.env
    );

    try {
      const result = await postApprovedReply({
        tweetId: "tweet-1",
        actor: "test",
        db,
        env: fixture.env,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(result.posted).toBe(true);
      expect(result.replyTweetId).toBe("reply-1");
      expect(db.getCandidate("tweet-1")?.status).toBe("posted");
      expect(db.getLatestDraftForCandidate("tweet-1")?.status).toBe("posted");
      expect(db.countPostedRepliesSince("1970-01-01T00:00:00.000Z")).toBe(1);
      await expect(readFile(fixture.xurlLogPath, "utf8")).resolves.toContain(
        "reply tweet-1 A helpful reply."
      );
    } finally {
      db.close();
    }
  });
});

async function openCandidateDb(root: string, text: string): Promise<XHermesDatabase> {
  const db = await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
  db.upsertAuthor({ authorId: "user-1", username: "alice", followersCount: 1000 });
  db.upsertCandidate({
    tweetId: "tweet-1",
    authorId: "user-1",
    authorUsername: "alice",
    text,
    status: "approved",
    score: 50,
    riskFlags: [],
    sensitive: false
  });
  db.createReplyDraft({
    tweetId: "tweet-1",
    text: "A helpful reply.",
    draftedBy: "test",
    status: "approved"
  });
  return db;
}

async function createFixture(): Promise<{
  root: string;
  fakeXurlPath: string;
  xurlLogPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "x-hermes-posting-test-"));
  tempDirs.push(root);
  const fakeXurlPath = path.join(root, "fake-xurl.mjs");
  const xurlLogPath = path.join(root, "xurl.log");

  await writeFile(
    fakeXurlPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_XURL_LOG, args.join(" ") + "\\n");
if (args.join(" ") === "auth status") {
  console.log("authenticated");
  process.exit(0);
}
if (args[0] === "reply") {
  console.log(JSON.stringify({ data: { id: "reply-1" } }));
  process.exit(0);
}
if (args[0] === "--help" || args[0] === "whoami") {
  console.log("ok");
  process.exit(0);
}
process.exit(2);
`,
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(fakeXurlPath, 0o700);

  return {
    root,
    fakeXurlPath,
    xurlLogPath,
    env: {
      ...process.env,
      X_HERMES_CONFIG_DIR: path.join(root, "config"),
      X_HERMES_DATA_DIR: path.join(root, "data"),
      X_HERMES_XURL_BIN: fakeXurlPath,
      FAKE_XURL_LOG: xurlLogPath
    }
  };
}

