import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
import { runXurl } from "./xurl.js";
import type { AuthorRecord, CandidateRecord, StoredCandidateRecord } from "./types.js";

export interface ScanOptions {
  query?: string;
  watchQueryId?: string;
  limit: number;
  env?: NodeJS.ProcessEnv;
  db?: XHermesDatabase;
}

export interface ScanSummary {
  runs: Array<{
    query: string;
    watchQueryId?: string;
    foundCount: number;
    storedCount: number;
    candidates: StoredCandidateRecord[];
  }>;
}

export interface ParsedSearchResult {
  candidates: Array<{
    author: AuthorRecord;
    candidate: CandidateRecord;
  }>;
  nextCursor?: string;
}

interface XApiSearchEnvelope {
  data?: unknown;
  includes?: {
    users?: unknown[];
  };
  meta?: {
    next_token?: string;
  };
}

interface XApiTweet {
  id?: unknown;
  text?: unknown;
  author_id?: unknown;
  created_at?: unknown;
  public_metrics?: unknown;
  possibly_sensitive?: unknown;
  referenced_tweets?: unknown;
  author?: unknown;
  user?: unknown;
}

interface XApiUser {
  id?: unknown;
  username?: unknown;
  name?: unknown;
  verified?: unknown;
  created_at?: unknown;
  public_metrics?: {
    followers_count?: unknown;
    following_count?: unknown;
    listed_count?: unknown;
  };
}

export async function scanRecentPosts(options: ScanOptions): Promise<ScanSummary> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));

  try {
    const targets = resolveScanTargets(db, options);
    const runs: ScanSummary["runs"] = [];

    for (const target of targets) {
      const scanRunId = db.startScanRun({
        watchQueryId: target.watchQueryId,
        query: target.query
      });

      try {
        const xurlResult = await runXurl(["search", target.query, "-n", String(options.limit)], {
          timeoutMs: 30_000,
          env: options.env
        });

        if (!xurlResult.ok) {
          const message = (xurlResult.stderr || xurlResult.stdout || "xurl search failed").trim();
          db.finishScanRun({
            id: scanRunId,
            status: "failed",
            foundCount: 0,
            storedCount: 0,
            error: message
          });
          db.recordAuditEvent({
            eventType: "scan.failed",
            actor: "x-hermes",
            entityType: "scan_run",
            entityId: scanRunId,
            details: { query: target.query, error: message }
          });
          throw new Error(message);
        }

        const parsed = parseSearchOutput(xurlResult.stdout, target.query);
        const stored: StoredCandidateRecord[] = [];
        let newCandidates = 0;

        for (const item of parsed.candidates) {
          db.upsertAuthor(item.author);
          if (!db.getCandidate(item.candidate.tweetId)) {
            newCandidates += 1;
          }
          stored.push(db.upsertCandidate(item.candidate));
        }

        db.finishScanRun({
          id: scanRunId,
          status: "completed",
          foundCount: parsed.candidates.length,
          storedCount: newCandidates
        });

        if (target.watchQueryId && parsed.nextCursor) {
          db.updateWatchQueryCursor(target.watchQueryId, parsed.nextCursor);
        }

        db.recordAuditEvent({
          eventType: "scan.completed",
          actor: "x-hermes",
          entityType: "scan_run",
          entityId: scanRunId,
          details: {
            query: target.query,
            foundCount: parsed.candidates.length,
            storedCount: newCandidates
          }
        });

        runs.push({
          query: target.query,
          watchQueryId: target.watchQueryId,
          foundCount: parsed.candidates.length,
          storedCount: newCandidates,
          candidates: stored
        });
      } catch (error) {
        if (error instanceof Error) {
          db.finishScanRun({
            id: scanRunId,
            status: "failed",
            foundCount: 0,
            storedCount: 0,
            error: error.message
          });
        }
        throw error;
      }
    }

    return { runs };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export function parseSearchOutput(stdout: string, sourceQuery: string): ParsedSearchResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { candidates: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("xurl search output was not JSON. Use a xurl mode that returns JSON output.");
  }

  const envelope = parsed as XApiSearchEnvelope;
  const users = new Map<string, XApiUser>();
  for (const rawUser of envelope.includes?.users ?? []) {
    const user = rawUser as XApiUser;
    const id = asString(user.id);
    if (id) {
      users.set(id, user);
    }
  }

  const tweets = extractTweets(parsed);
  const candidates = tweets.map((tweet) => mapTweet(tweet, users, sourceQuery));
  return {
    candidates,
    nextCursor: asString(envelope.meta?.next_token)
  };
}

function resolveScanTargets(
  db: XHermesDatabase,
  options: ScanOptions
): Array<{ query: string; watchQueryId?: string }> {
  if (options.query) {
    return [{ query: options.query }];
  }

  if (options.watchQueryId) {
    const watchQuery = db.getWatchQuery(options.watchQueryId);
    if (!watchQuery) {
      throw new Error(`Watch query not found: ${options.watchQueryId}`);
    }
    return [{ query: watchQuery.query, watchQueryId: watchQuery.id }];
  }

  const watchQueries = db.listWatchQueries({ enabledOnly: true });
  if (watchQueries.length === 0) {
    throw new Error("No enabled watch queries configured. Pass --query or add a watch query.");
  }
  return watchQueries.map((watchQuery) => ({
    query: watchQuery.query,
    watchQueryId: watchQuery.id
  }));
}

function extractTweets(parsed: unknown): XApiTweet[] {
  if (Array.isArray(parsed)) {
    return parsed as XApiTweet[];
  }

  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    if (Array.isArray(object.data)) {
      return object.data as XApiTweet[];
    }
    if (Array.isArray(object.tweets)) {
      return object.tweets as XApiTweet[];
    }
    if (Array.isArray(object.results)) {
      return object.results as XApiTweet[];
    }
  }

  return [];
}

function mapTweet(
  tweet: XApiTweet,
  users: Map<string, XApiUser>,
  sourceQuery: string
): { author: AuthorRecord; candidate: CandidateRecord } {
  const tweetId = requiredString(tweet.id, "tweet id");
  const text = requiredString(tweet.text, `text for tweet ${tweetId}`);
  const nestedAuthor = ((tweet.author ?? tweet.user) || undefined) as XApiUser | undefined;
  const authorId = asString(tweet.author_id) ?? asString(nestedAuthor?.id) ?? `unknown:${tweetId}`;
  const includedUser = users.get(authorId);
  const user = includedUser ?? nestedAuthor ?? {};
  const username = asString(user.username) ?? "unknown";

  const author: AuthorRecord = {
    authorId,
    username,
    displayName: asString(user.name),
    verified: asBoolean(user.verified),
    createdAtX: asString(user.created_at),
    followersCount: asNumber(user.public_metrics?.followers_count),
    followingCount: asNumber(user.public_metrics?.following_count),
    listedCount: asNumber(user.public_metrics?.listed_count),
    raw: user
  };

  const metrics =
    tweet.public_metrics && typeof tweet.public_metrics === "object"
      ? (tweet.public_metrics as Record<string, unknown>)
      : undefined;
  const referencedTweets = Array.isArray(tweet.referenced_tweets)
    ? (tweet.referenced_tweets as unknown[])
    : undefined;

  return {
    author,
    candidate: {
      tweetId,
      authorId,
      authorUsername: username,
      text,
      url: username === "unknown" ? undefined : `https://x.com/${username}/status/${tweetId}`,
      createdAtX: asString(tweet.created_at),
      status: "found",
      score: 0,
      riskFlags: [],
      publicMetrics: metrics,
      referencedTweets,
      sensitive: asBoolean(tweet.possibly_sensitive) ?? false,
      sourceQuery,
      raw: tweet
    }
  };
}

function requiredString(value: unknown, label: string): string {
  const result = asString(value);
  if (!result) {
    throw new Error(`Missing ${label} in xurl search output.`);
  }
  return result;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

