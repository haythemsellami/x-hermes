export type CheckStatus = "ok" | "warn" | "error";

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface ActiveHours {
  start: string;
  end: string;
  timezone: string;
}

export interface XHermesConfig {
  xurlApp: string;
  username: string;
  activeHours: ActiveHours;
  maxRepliesPerDay: number;
  replyTextDefault: string;
  postingEnabled: boolean;
  perAuthorCooldownHours: number;
  requireApprovalForKeywordSearch: boolean;
  requireOptInForAutoPost: boolean;
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: XHermesConfig;
}

export interface StatusReport {
  ready: boolean;
  configPath: string;
  dataDir: string;
  checks: DiagnosticCheck[];
  config?: XHermesConfig;
}

export interface ProcessResult {
  command: string[];
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SetupOptions {
  checkOnly: boolean;
  withHermes: boolean;
  nonInteractive: boolean;
  json: boolean;
}

export interface StatusOptions {
  withHermes: boolean;
}

export type CandidateStatus =
  | "found"
  | "rejected"
  | "drafted"
  | "approval_pending"
  | "approved"
  | "posted"
  | "failed"
  | "skipped";

export interface AuthorRecord {
  authorId: string;
  username: string;
  displayName?: string;
  verified?: boolean;
  createdAtX?: string;
  followersCount?: number;
  followingCount?: number;
  listedCount?: number;
  raw?: unknown;
}

export interface CandidateRecord {
  tweetId: string;
  authorId: string;
  authorUsername: string;
  text: string;
  url?: string;
  createdAtX?: string;
  status: CandidateStatus;
  score: number;
  riskFlags: string[];
  publicMetrics?: Record<string, unknown>;
  referencedTweets?: unknown[];
  sensitive: boolean;
  sourceQuery?: string;
  raw?: unknown;
}

export interface StoredCandidateRecord extends CandidateRecord {
  foundAt: string;
  updatedAt: string;
}

export interface WatchQueryRecord {
  id: string;
  name: string;
  query: string;
  enabled: boolean;
  lastCursor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReplyDraftRecord {
  id: string;
  tweetId: string;
  text: string;
  draftedBy: string;
  status: "drafted" | "approval_pending" | "approved" | "rejected" | "posted";
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventRecord {
  id: string;
  eventType: string;
  actor: string;
  entityType: string;
  entityId: string;
  details?: unknown;
  createdAt: string;
}

export interface CandidateScore {
  score: number;
  riskFlags: string[];
  accepted: boolean;
}

export interface XHermesStats {
  candidatesByStatus: Record<CandidateStatus, number>;
  replyDrafts: number;
  postedReplies: number;
  optOuts: number;
  auditEvents: number;
}

export const DEFAULT_CONFIG: XHermesConfig = {
  xurlApp: "x-hermes",
  username: "",
  activeHours: {
    start: "09:00",
    end: "21:00",
    timezone: "America/New_York"
  },
  maxRepliesPerDay: 120,
  replyTextDefault: "Configure this per project",
  postingEnabled: false,
  perAuthorCooldownHours: 168,
  requireApprovalForKeywordSearch: true,
  requireOptInForAutoPost: true
};
