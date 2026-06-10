import { describe, expect, it } from "vitest";

import { scoreCandidate } from "../src/scoring.js";
import type { AuthorRecord, CandidateRecord } from "../src/types.js";

describe("scoring", () => {
  it("accepts high-quality relevant candidates", () => {
    const result = scoreCandidate(candidate(), author(), {
      now: new Date("2026-06-10T00:00:00.000Z")
    });

    expect(result.accepted).toBe(true);
    expect(result.riskFlags).toEqual([]);
    expect(result.score).toBeGreaterThan(30);
  });

  it("rejects scam language and sensitive posts", () => {
    const result = scoreCandidate(
      {
        ...candidate(),
        text: "Claim now with your seed phrase for a guaranteed profit",
        sensitive: true
      },
      author(),
      { now: new Date("2026-06-10T00:00:00.000Z") }
    );

    expect(result.accepted).toBe(false);
    expect(result.riskFlags).toEqual(["sensitive", "scam_language"]);
  });

  it("rejects low-follower or new-account candidates", () => {
    const result = scoreCandidate(
      candidate(),
      {
        ...author(),
        followersCount: 10,
        createdAtX: "2026-06-01T00:00:00.000Z"
      },
      { now: new Date("2026-06-10T00:00:00.000Z") }
    );

    expect(result.accepted).toBe(false);
    expect(result.riskFlags).toEqual(["low_followers", "new_account"]);
  });

  it("rejects opted-out authors", () => {
    const result = scoreCandidate(candidate(), author(), {
      optedOut: true,
      now: new Date("2026-06-10T00:00:00.000Z")
    });

    expect(result.accepted).toBe(false);
    expect(result.riskFlags).toContain("opted_out");
  });
});

function author(): AuthorRecord {
  return {
    authorId: "u1",
    username: "alice",
    verified: true,
    createdAtX: "2020-01-01T00:00:00.000Z",
    followersCount: 5000,
    followingCount: 300,
    listedCount: 20
  };
}

function candidate(): CandidateRecord {
  return {
    tweetId: "t1",
    authorId: "u1",
    authorUsername: "alice",
    text: "What is the best way to build on Monad?",
    status: "found",
    score: 0,
    riskFlags: [],
    publicMetrics: {
      like_count: 20,
      reply_count: 4,
      retweet_count: 2,
      quote_count: 1,
      impression_count: 1000
    },
    sensitive: false,
    sourceQuery: "monad build lang:en"
  };
}

