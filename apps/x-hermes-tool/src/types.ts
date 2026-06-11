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

export type RuntimeMode = "once" | "daemon";
export type ApprovalMode = "required" | "none" | "opt_in_auto_post";
export type NotificationChannelType = "stdout" | "command";
export type NotificationEvent = "post" | "error" | "approval_request";

export interface RuntimeConfig {
  mode: RuntimeMode;
  scanIntervalMinutes: number;
  dryRun: boolean;
}

export interface PostingConfig {
  enabled: boolean;
  approvalMode: ApprovalMode;
  maxRepliesPerDay: number;
  maxRepliesPerRun: number;
  activeHours: ActiveHours;
  perAuthorCooldownHours: number;
  blockDuplicateReplyText: boolean;
  requireOptInForAutoPost: boolean;
}

export interface QualityConfig {
  minimumFollowers: number;
  minimumAccountAgeDays: number;
  skipSensitive: boolean;
  skipScamLanguage: boolean;
  useFeedbackSignals: boolean;
}

export interface NotificationChannelConfig {
  id: string;
  type: NotificationChannelType;
  enabled: boolean;
  command?: string;
  args?: string[];
  events?: NotificationEvent[];
}

export interface NotificationsConfig {
  onPost: boolean;
  onError: boolean;
  onApprovalRequest: boolean;
  channels: NotificationChannelConfig[];
}

export interface CampaignConfig {
  id: string;
  enabled: boolean;
  query: string;
  replyText: string;
  fetchLimit: number;
  postLimit: number;
  approvalMode?: ApprovalMode;
  dryRun?: boolean;
  requireOptInForAutoPost?: boolean;
}

export interface XHermesConfig {
  xurlApp: string;
  username: string;
  runtime: RuntimeConfig;
  posting: PostingConfig;
  quality: QualityConfig;
  notifications: NotificationsConfig;
  campaigns: CampaignConfig[];
  replyTextDefault: string;
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

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDeliveryStatus = "not_sent" | "sent" | "failed";
export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalRequestRecord {
  id: string;
  tweetId: string;
  draftId: string;
  status: ApprovalRequestStatus;
  requestedBy: string;
  channel?: string;
  recipient?: string;
  externalMessageId?: string;
  deliveryStatus: ApprovalDeliveryStatus;
  messageText?: string;
  expiresAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  decisionLabels: string[];
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestDetails {
  request: ApprovalRequestRecord;
  candidate: StoredCandidateRecord;
  draft: ReplyDraftRecord;
}

export interface FeedbackExampleRecord {
  id: string;
  approvalRequestId?: string;
  tweetId: string;
  draftId?: string;
  decision: ApprovalDecision;
  reason?: string;
  labels: string[];
  candidateText: string;
  draftText?: string;
  sourceQuery?: string;
  authorUsername: string;
  createdAt: string;
}

export interface FeedbackProfile {
  totals: {
    approved: number;
    rejected: number;
  };
  labels: Record<string, number>;
  queryStats: Array<{
    sourceQuery: string;
    approved: number;
    rejected: number;
    approvalRate: number;
  }>;
  examples: {
    approved: FeedbackExampleRecord[];
    rejected: FeedbackExampleRecord[];
  };
  draftingGuidance: string[];
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
  approvalRequests: Record<ApprovalRequestStatus, number>;
  feedbackExamples: number;
  postedReplies: number;
  optOuts: number;
  auditEvents: number;
}

export interface GuardrailFailure {
  id: string;
  message: string;
}

export interface GuardrailResult {
  allowed: boolean;
  failures: GuardrailFailure[];
}

export const DEFAULT_CONFIG: XHermesConfig = {
  xurlApp: "x-hermes",
  username: "",
  runtime: {
    mode: "daemon",
    scanIntervalMinutes: 60,
    dryRun: true
  },
  posting: {
    enabled: false,
    approvalMode: "required",
    maxRepliesPerDay: 120,
    maxRepliesPerRun: 10,
    activeHours: {
      start: "09:00",
      end: "21:00",
      timezone: "America/New_York"
    },
    perAuthorCooldownHours: 50,
    blockDuplicateReplyText: true,
    requireOptInForAutoPost: true
  },
  quality: {
    minimumFollowers: 1000,
    minimumAccountAgeDays: 300,
    skipSensitive: true,
    skipScamLanguage: true,
    useFeedbackSignals: true
  },
  notifications: {
    onPost: true,
    onError: true,
    onApprovalRequest: true,
    channels: [
      {
        id: "stdout",
        type: "stdout",
        enabled: true
      }
    ]
  },
  campaigns: [],
  replyTextDefault: "Configure this per project"
};
