import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openXHermesDatabase } from "../src/db.js";
import { parseSearchOutput, scanRecentPosts } from "../src/scanner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("scanner", () => {
  it("parses raw X API recent-search output", () => {
    const parsed = parseSearchOutput(JSON.stringify(searchFixture()), "monad lang:en");

    expect(parsed.nextCursor).toBe("next-token");
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]?.author).toMatchObject({
      authorId: "u1",
      username: "alice",
      followersCount: 1500
    });
    expect(parsed.candidates[0]?.candidate).toMatchObject({
      tweetId: "t1",
      authorUsername: "alice",
      sensitive: false,
      sourceQuery: "monad lang:en"
    });
  });

  it("scans a direct query and stores authors and candidates", async () => {
    const fixture = await createFixture(searchFixture());
    const db = await openXHermesDatabase({ path: path.join(fixture.root, "test.sqlite") });

    try {
      const summary = await scanRecentPosts({
        query: "monad lang:en -is:retweet",
        limit: 25,
        env: fixture.env,
        db
      });

      expect(summary.runs).toHaveLength(1);
      expect(summary.runs[0]?.foundCount).toBe(2);
      expect(summary.runs[0]?.storedCount).toBe(2);
      expect(db.listCandidates()).toHaveLength(2);
      expect(db.getCandidate("t1")?.url).toBe("https://x.com/alice/status/t1");

      const second = await scanRecentPosts({
        query: "monad lang:en -is:retweet",
        limit: 25,
        env: fixture.env,
        db
      });
      expect(second.runs[0]?.foundCount).toBe(2);
      expect(second.runs[0]?.storedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("scans enabled watch queries and stores the returned cursor", async () => {
    const fixture = await createFixture(searchFixture());
    const db = await openXHermesDatabase({ path: path.join(fixture.root, "test.sqlite") });

    try {
      const watch = db.upsertWatchQuery({
        name: "Monad",
        query: "monad lang:en -is:retweet"
      });

      const summary = await scanRecentPosts({
        limit: 10,
        env: fixture.env,
        db
      });

      expect(summary.runs[0]?.watchQueryId).toBe(watch.id);
      expect(db.getWatchQuery(watch.id)?.lastCursor).toBe("next-token");
    } finally {
      db.close();
    }
  });

  it("uses repeated rejection feedback to skip future candidates for the same author", async () => {
    const fixture = await createFixture(searchFixture());
    const db = await openXHermesDatabase({ path: path.join(fixture.root, "test.sqlite") });

    try {
      db.upsertAuthor({ authorId: "u1", username: "alice" });
      db.upsertCandidate({
        tweetId: "old-1",
        authorId: "u1",
        authorUsername: "alice",
        text: "old",
        status: "rejected",
        score: 0,
        riskFlags: [],
        sensitive: false
      });
      db.recordFeedbackExample({
        tweetId: "old-1",
        decision: "rejected",
        reason: "low relevance",
        labels: ["rejected", "low_relevance"],
        candidateText: "old",
        authorUsername: "alice"
      });
      db.recordFeedbackExample({
        tweetId: "old-1",
        decision: "rejected",
        reason: "wrong audience",
        labels: ["rejected", "wrong_audience"],
        candidateText: "old again",
        authorUsername: "alice"
      });

      await scanRecentPosts({
        query: "monad lang:en -is:retweet",
        limit: 25,
        env: fixture.env,
        db
      });

      expect(db.getCandidate("t1")?.status).toBe("skipped");
      expect(db.getCandidate("t1")?.riskFlags).toContain("feedback_rejected_author");
    } finally {
      db.close();
    }
  });
});

function searchFixture(): unknown {
  return {
    data: [
      {
        id: "t1",
        text: "How should I think about Monad apps?",
        author_id: "u1",
        created_at: "2026-06-10T12:00:00.000Z",
        public_metrics: {
          like_count: 4,
          reply_count: 1,
          retweet_count: 0,
          quote_count: 0,
          impression_count: 200
        },
        possibly_sensitive: false
      },
      {
        id: "t2",
        text: "Any good tooling for high-performance EVM chains?",
        author_id: "u2",
        created_at: "2026-06-10T12:05:00.000Z",
        public_metrics: {
          like_count: 8,
          reply_count: 2,
          retweet_count: 1,
          quote_count: 0,
          impression_count: 500
        },
        possibly_sensitive: false
      }
    ],
    includes: {
      users: [
        {
          id: "u1",
          username: "alice",
          name: "Alice",
          verified: true,
          created_at: "2020-01-01T00:00:00.000Z",
          public_metrics: {
            followers_count: 1500,
            following_count: 200,
            listed_count: 12
          }
        },
        {
          id: "u2",
          username: "bob",
          name: "Bob",
          verified: false,
          created_at: "2019-01-01T00:00:00.000Z",
          public_metrics: {
            followers_count: 800,
            following_count: 100,
            listed_count: 2
          }
        }
      ]
    },
    meta: {
      next_token: "next-token"
    }
  };
}

async function createFixture(searchOutput: unknown): Promise<{
  root: string;
  fakeXurlPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "x-hermes-scanner-test-"));
  tempDirs.push(root);

  const fakeXurlPath = path.join(root, "fake-xurl.mjs");
  await writeFile(
    fakeXurlPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0]?.startsWith("/2/tweets/search/recent")) {
  console.log(process.env.FAKE_XURL_SEARCH_OUTPUT);
  process.exit(0);
}
if (args[0] === "--help" || args.join(" ") === "auth status" || args[0] === "whoami") {
  console.log("ok");
  process.exit(0);
}
console.error("unexpected xurl args", args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(fakeXurlPath, 0o700);

  return {
    root,
    fakeXurlPath,
    env: {
      ...process.env,
      X_HERMES_XURL_BIN: fakeXurlPath,
      FAKE_XURL_SEARCH_OUTPUT: JSON.stringify(searchOutput)
    }
  };
}
