import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDataDir } from "./config.js";
import type {
  AuditEventRecord,
  AuthorRecord,
  CandidateRecord,
  CandidateStatus,
  ReplyDraftRecord,
  StoredCandidateRecord,
  WatchQueryRecord,
  XHermesStats
} from "./types.js";

const CURRENT_SCHEMA_VERSION = 1;

export interface DatabaseOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ListCandidateOptions {
  status?: CandidateStatus;
  limit?: number;
}

export interface ScanRunInput {
  watchQueryId?: string;
  query: string;
  status?: "running" | "completed" | "failed";
}

export interface ScanRunFinishInput {
  id: string;
  status: "completed" | "failed";
  foundCount: number;
  storedCount: number;
  error?: string;
}

interface CandidateRow {
  tweet_id: string;
  author_id: string;
  author_username: string;
  text: string;
  url: string | null;
  created_at_x: string | null;
  found_at: string;
  status: CandidateStatus;
  score: number;
  risk_flags_json: string;
  public_metrics_json: string | null;
  referenced_tweets_json: string | null;
  sensitive: number;
  source_query: string | null;
  raw_json: string | null;
  updated_at: string;
}

interface WatchQueryRow {
  id: string;
  name: string;
  query: string;
  enabled: number;
  last_cursor: string | null;
  created_at: string;
  updated_at: string;
}

interface AuthorRow {
  author_id: string;
  username: string;
  display_name: string | null;
  verified: number | null;
  created_at_x: string | null;
  followers_count: number | null;
  following_count: number | null;
  listed_count: number | null;
  raw_json: string | null;
}

interface ReplyDraftRow {
  id: string;
  tweet_id: string;
  text: string;
  drafted_by: string;
  status: ReplyDraftRecord["status"];
  created_at: string;
  updated_at: string;
}

interface AuditEventRow {
  id: string;
  event_type: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  details_json: string | null;
  created_at: string;
}

export function getDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(env), "x-hermes.sqlite");
}

export async function openXHermesDatabase(
  options: DatabaseOptions = {}
): Promise<XHermesDatabase> {
  const dbPath = options.path ?? getDatabasePath(options.env);
  if (dbPath !== ":memory:") {
    await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const sqlite = new DatabaseSync(dbPath);
  const db = new XHermesDatabase(sqlite);
  db.migrate();
  return db;
}

export class XHermesDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const version = row.user_version;
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`
      );
    }
    if (version === CURRENT_SCHEMA_VERSION) {
      return;
    }
    if (version !== 0) {
      throw new Error(`Unsupported database schema version ${version}.`);
    }

    this.db.exec("BEGIN");
    try {
      this.db.exec(SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, stringifyJson(value), nowIso());
  }

  getSetting<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  upsertWatchQuery(input: {
    id?: string;
    name: string;
    query: string;
    enabled?: boolean;
    lastCursor?: string;
  }): WatchQueryRecord {
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO watch_queries (id, name, query, enabled, last_cursor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           query = excluded.query,
           enabled = excluded.enabled,
           last_cursor = excluded.last_cursor,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.name,
        input.query,
        input.enabled === false ? 0 : 1,
        input.lastCursor ?? null,
        timestamp,
        timestamp
      );
    const saved = this.getWatchQuery(id);
    if (!saved) {
      throw new Error(`Failed to save watch query ${id}.`);
    }
    return saved;
  }

  listWatchQueries(options: { enabledOnly?: boolean } = {}): WatchQueryRecord[] {
    const rows = options.enabledOnly
      ? (this.db
          .prepare("SELECT * FROM watch_queries WHERE enabled = 1 ORDER BY created_at ASC")
          .all() as unknown as WatchQueryRow[])
      : (this.db
          .prepare("SELECT * FROM watch_queries ORDER BY created_at ASC")
          .all() as unknown as WatchQueryRow[]);
    return rows.map(mapWatchQueryRow);
  }

  getWatchQuery(id: string): WatchQueryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM watch_queries WHERE id = ?").get(id) as
      | WatchQueryRow
      | undefined;
    return row ? mapWatchQueryRow(row) : undefined;
  }

  updateWatchQueryCursor(id: string, cursor: string | undefined): void {
    this.db
      .prepare("UPDATE watch_queries SET last_cursor = ?, updated_at = ? WHERE id = ?")
      .run(cursor ?? null, nowIso(), id);
  }

  startScanRun(input: ScanRunInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scan_runs
           (id, watch_query_id, query, started_at, status, found_count, stored_count)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
      )
      .run(id, input.watchQueryId ?? null, input.query, nowIso(), input.status ?? "running");
    return id;
  }

  finishScanRun(input: ScanRunFinishInput): void {
    this.db
      .prepare(
        `UPDATE scan_runs
         SET finished_at = ?, status = ?, found_count = ?, stored_count = ?, error = ?
         WHERE id = ?`
      )
      .run(
        nowIso(),
        input.status,
        input.foundCount,
        input.storedCount,
        input.error ?? null,
        input.id
      );
  }

  upsertAuthor(author: AuthorRecord): void {
    this.db
      .prepare(
        `INSERT INTO authors
           (author_id, username, display_name, verified, created_at_x, followers_count,
            following_count, listed_count, raw_json, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(author_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           verified = excluded.verified,
           created_at_x = excluded.created_at_x,
           followers_count = excluded.followers_count,
           following_count = excluded.following_count,
           listed_count = excluded.listed_count,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      )
      .run(
        author.authorId,
        author.username,
        author.displayName ?? null,
        boolToInt(author.verified),
        author.createdAtX ?? null,
        author.followersCount ?? null,
        author.followingCount ?? null,
        author.listedCount ?? null,
        stringifyJsonOrNull(author.raw),
        nowIso(),
        nowIso()
      );
  }

  getAuthor(authorId: string): AuthorRecord | undefined {
    const row = this.db.prepare("SELECT * FROM authors WHERE author_id = ?").get(authorId) as
      | AuthorRow
      | undefined;
    return row ? mapAuthorRow(row) : undefined;
  }

  upsertCandidate(candidate: CandidateRecord): StoredCandidateRecord {
    this.db
      .prepare(
        `INSERT INTO candidates
           (tweet_id, author_id, author_username, text, url, created_at_x, status, score,
            risk_flags_json, public_metrics_json, referenced_tweets_json, sensitive,
            source_query, raw_json, found_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tweet_id) DO UPDATE SET
           author_id = excluded.author_id,
           author_username = excluded.author_username,
           text = excluded.text,
           url = excluded.url,
           created_at_x = excluded.created_at_x,
           score = excluded.score,
           risk_flags_json = excluded.risk_flags_json,
           public_metrics_json = excluded.public_metrics_json,
           referenced_tweets_json = excluded.referenced_tweets_json,
           sensitive = excluded.sensitive,
           source_query = excluded.source_query,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      )
      .run(
        candidate.tweetId,
        candidate.authorId,
        candidate.authorUsername,
        candidate.text,
        candidate.url ?? null,
        candidate.createdAtX ?? null,
        candidate.status,
        candidate.score,
        stringifyJson(candidate.riskFlags),
        stringifyJsonOrNull(candidate.publicMetrics),
        stringifyJsonOrNull(candidate.referencedTweets),
        boolToInt(candidate.sensitive),
        candidate.sourceQuery ?? null,
        stringifyJsonOrNull(candidate.raw),
        nowIso(),
        nowIso()
      );
    const saved = this.getCandidate(candidate.tweetId);
    if (!saved) {
      throw new Error(`Failed to save candidate ${candidate.tweetId}.`);
    }
    return saved;
  }

  getCandidate(tweetId: string): StoredCandidateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM candidates WHERE tweet_id = ?").get(tweetId) as
      | CandidateRow
      | undefined;
    return row ? mapCandidateRow(row) : undefined;
  }

  listCandidates(options: ListCandidateOptions = {}): StoredCandidateRecord[] {
    const limit = clampLimit(options.limit ?? 50, 1, 500);
    const rows = options.status
      ? (this.db
          .prepare(
            `SELECT * FROM candidates
             WHERE status = ?
             ORDER BY score DESC, found_at DESC
             LIMIT ?`
          )
          .all(options.status, limit) as unknown as CandidateRow[])
      : (this.db
          .prepare(
            `SELECT * FROM candidates
             ORDER BY score DESC, found_at DESC
             LIMIT ?`
          )
          .all(limit) as unknown as CandidateRow[]);
    return rows.map(mapCandidateRow);
  }

  updateCandidateStatus(tweetId: string, status: CandidateStatus): void {
    this.db
      .prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE tweet_id = ?")
      .run(status, nowIso(), tweetId);
  }

  createReplyDraft(input: {
    tweetId: string;
    text: string;
    draftedBy: string;
    status?: ReplyDraftRecord["status"];
  }): ReplyDraftRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    const status = input.status ?? "approval_pending";
    this.db
      .prepare(
        `INSERT INTO reply_drafts (id, tweet_id, text, drafted_by, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.tweetId, input.text, input.draftedBy, status, timestamp, timestamp);
    if (status === "approval_pending") {
      this.updateCandidateStatus(input.tweetId, "approval_pending");
    }
    const saved = this.getReplyDraft(id);
    if (!saved) {
      throw new Error(`Failed to save reply draft ${id}.`);
    }
    return saved;
  }

  getReplyDraft(id: string): ReplyDraftRecord | undefined {
    const row = this.db.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(id) as
      | ReplyDraftRow
      | undefined;
    return row ? mapReplyDraftRow(row) : undefined;
  }

  getLatestDraftForCandidate(tweetId: string): ReplyDraftRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM reply_drafts WHERE tweet_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(tweetId) as ReplyDraftRow | undefined;
    return row ? mapReplyDraftRow(row) : undefined;
  }

  updateDraftStatus(id: string, status: ReplyDraftRecord["status"]): void {
    this.db
      .prepare("UPDATE reply_drafts SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  recordPostedReply(input: {
    tweetId: string;
    authorId: string;
    draftId?: string;
    replyTweetId: string;
    replyText: string;
    raw?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO posted_replies
           (id, tweet_id, author_id, draft_id, reply_tweet_id, reply_text, posted_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.tweetId,
        input.authorId,
        input.draftId ?? null,
        input.replyTweetId,
        input.replyText,
        nowIso(),
        stringifyJsonOrNull(input.raw)
      );
  }

  countPostedRepliesSince(sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM posted_replies WHERE posted_at >= ?")
      .get(sinceIso) as { count: number };
    return row.count;
  }

  latestPostedReplyForAuthor(authorId: string): { postedAt: string; replyText: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT posted_at AS postedAt, reply_text AS replyText
         FROM posted_replies
         WHERE author_id = ?
         ORDER BY posted_at DESC
         LIMIT 1`
      )
      .get(authorId) as { postedAt: string; replyText: string } | undefined;
    return row;
  }

  countDuplicateReplyTextSince(replyText: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM posted_replies
         WHERE lower(reply_text) = lower(?) AND posted_at >= ?`
      )
      .get(replyText, sinceIso) as { count: number };
    return row.count;
  }

  addOptOut(input: { username: string; authorId?: string; reason?: string }): void {
    this.db
      .prepare(
        `INSERT INTO opt_outs (username, author_id, reason, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
           author_id = COALESCE(excluded.author_id, opt_outs.author_id),
           reason = COALESCE(excluded.reason, opt_outs.reason)`
      )
      .run(normalizeUsername(input.username), input.authorId ?? null, input.reason ?? null, nowIso());
  }

  isOptedOut(username: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM opt_outs WHERE username = ?")
      .get(normalizeUsername(username)) as { found: number } | undefined;
    return Boolean(row);
  }

  recordAuditEvent(input: {
    eventType: string;
    actor: string;
    entityType: string;
    entityId: string;
    details?: unknown;
  }): AuditEventRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, event_type, actor, entity_type, entity_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.eventType,
        input.actor,
        input.entityType,
        input.entityId,
        stringifyJsonOrNull(input.details),
        timestamp
      );
    return {
      id,
      eventType: input.eventType,
      actor: input.actor,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
      createdAt: timestamp
    };
  }

  listAuditEvents(limit = 50): AuditEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
      .all(clampLimit(limit, 1, 500)) as unknown as AuditEventRow[];
    return rows.map(mapAuditEventRow);
  }

  incrementRateLimitCounter(counterKey: string, windowStart: string, increment = 1): number {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO rate_limit_counters (counter_key, window_start, count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(counter_key, window_start) DO UPDATE SET
           count = count + excluded.count,
           updated_at = excluded.updated_at`
      )
      .run(counterKey, windowStart, increment, timestamp);
    const row = this.db
      .prepare(
        "SELECT count FROM rate_limit_counters WHERE counter_key = ? AND window_start = ?"
      )
      .get(counterKey, windowStart) as { count: number };
    return row.count;
  }

  getStats(): XHermesStats {
    const statusCounts = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM candidates GROUP BY status")
      .all() as unknown as Array<{ status: CandidateStatus; count: number }>;
    const candidatesByStatus = emptyCandidateStatusCounts();
    for (const row of statusCounts) {
      candidatesByStatus[row.status] = row.count;
    }

    return {
      candidatesByStatus,
      replyDrafts: this.countTable("reply_drafts"),
      postedReplies: this.countTable("posted_replies"),
      optOuts: this.countTable("opt_outs"),
      auditEvents: this.countTable("audit_events")
    };
  }

  private countTable(table: "reply_drafts" | "posted_replies" | "opt_outs" | "audit_events"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }
}

const SCHEMA_SQL = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watch_queries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  watch_query_id TEXT REFERENCES watch_queries(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  found_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE authors (
  author_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  verified INTEGER,
  created_at_x TEXT,
  followers_count INTEGER,
  following_count INTEGER,
  listed_count INTEGER,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE candidates (
  tweet_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  created_at_x TEXT,
  found_at TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  public_metrics_json TEXT,
  referenced_tweets_json TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  source_query TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(author_id) REFERENCES authors(author_id) ON DELETE CASCADE
);

CREATE TABLE reply_drafts (
  id TEXT PRIMARY KEY,
  tweet_id TEXT NOT NULL REFERENCES candidates(tweet_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  drafted_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE posted_replies (
  id TEXT PRIMARY KEY,
  tweet_id TEXT NOT NULL REFERENCES candidates(tweet_id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  draft_id TEXT REFERENCES reply_drafts(id) ON DELETE SET NULL,
  reply_tweet_id TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE opt_outs (
  username TEXT PRIMARY KEY,
  author_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limit_counters (
  counter_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(counter_key, window_start)
);

CREATE INDEX candidates_status_score_idx ON candidates(status, score DESC);
CREATE INDEX candidates_author_idx ON candidates(author_id);
CREATE INDEX posted_replies_posted_at_idx ON posted_replies(posted_at);
CREATE INDEX posted_replies_author_posted_at_idx ON posted_replies(author_id, posted_at);
CREATE INDEX audit_events_created_at_idx ON audit_events(created_at);
CREATE INDEX scan_runs_started_at_idx ON scan_runs(started_at);
CREATE INDEX reply_drafts_tweet_created_at_idx ON reply_drafts(tweet_id, created_at);
`;

function mapCandidateRow(row: CandidateRow): StoredCandidateRecord {
  return {
    tweetId: row.tweet_id,
    authorId: row.author_id,
    authorUsername: row.author_username,
    text: row.text,
    url: row.url ?? undefined,
    createdAtX: row.created_at_x ?? undefined,
    foundAt: row.found_at,
    status: row.status,
    score: row.score,
    riskFlags: parseJson(row.risk_flags_json, []),
    publicMetrics: parseJson(row.public_metrics_json, undefined),
    referencedTweets: parseJson(row.referenced_tweets_json, undefined),
    sensitive: row.sensitive === 1,
    sourceQuery: row.source_query ?? undefined,
    raw: parseJson(row.raw_json, undefined),
    updatedAt: row.updated_at
  };
}

function mapAuthorRow(row: AuthorRow): AuthorRecord {
  return {
    authorId: row.author_id,
    username: row.username,
    displayName: row.display_name ?? undefined,
    verified: row.verified === null ? undefined : row.verified === 1,
    createdAtX: row.created_at_x ?? undefined,
    followersCount: row.followers_count ?? undefined,
    followingCount: row.following_count ?? undefined,
    listedCount: row.listed_count ?? undefined,
    raw: parseJson(row.raw_json, undefined)
  };
}

function mapWatchQueryRow(row: WatchQueryRow): WatchQueryRecord {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    enabled: row.enabled === 1,
    lastCursor: row.last_cursor ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapReplyDraftRow(row: ReplyDraftRow): ReplyDraftRecord {
  return {
    id: row.id,
    tweetId: row.tweet_id,
    text: row.text,
    draftedBy: row.drafted_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAuditEventRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: parseJson(row.details_json, undefined),
    createdAt: row.created_at
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function stringifyJsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) {
    return fallback;
  }
  return JSON.parse(value) as T;
}

function boolToInt(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function emptyCandidateStatusCounts(): Record<CandidateStatus, number> {
  return {
    found: 0,
    rejected: 0,
    drafted: 0,
    approval_pending: 0,
    approved: 0,
    posted: 0,
    failed: 0,
    skipped: 0
  };
}
