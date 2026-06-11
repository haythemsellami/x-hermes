import type { AuthorRecord, CandidateRecord, CandidateScore } from "./types.js";

export interface ScoringOptions {
  minimumFollowers?: number;
  minimumAccountAgeDays?: number;
  skipSensitive?: boolean;
  skipScamLanguage?: boolean;
  now?: Date;
  optedOut?: boolean;
}

const DEFAULT_MINIMUM_FOLLOWERS = 1000;
const DEFAULT_MINIMUM_ACCOUNT_AGE_DAYS = 300;
const SCAM_LANGUAGE =
  /\b(seed phrase|private key|airdrop|giveaway|free mint|wallet drain|claim now|guaranteed profit|double your|send eth|send sol)\b/i;

export function scoreCandidate(
  candidate: CandidateRecord,
  author: AuthorRecord,
  options: ScoringOptions = {}
): CandidateScore {
  const minimumFollowers = options.minimumFollowers ?? DEFAULT_MINIMUM_FOLLOWERS;
  const minimumAccountAgeDays = options.minimumAccountAgeDays ?? DEFAULT_MINIMUM_ACCOUNT_AGE_DAYS;
  const skipSensitive = options.skipSensitive ?? true;
  const skipScamLanguage = options.skipScamLanguage ?? true;
  const now = options.now ?? new Date();
  const riskFlags: string[] = [];

  const followers = author.followersCount ?? 0;
  const listed = author.listedCount ?? 0;
  const metrics = candidate.publicMetrics ?? {};
  const likes = numberMetric(metrics, "like_count");
  const replies = numberMetric(metrics, "reply_count");
  const reposts = numberMetric(metrics, "retweet_count") + numberMetric(metrics, "repost_count");
  const quotes = numberMetric(metrics, "quote_count");
  const impressions = numberMetric(metrics, "impression_count");

  let score = 0;
  score += Math.min(30, Math.log10(followers + 1) * 8);
  score += Math.min(25, likes * 0.5 + replies * 2 + reposts * 2 + quotes * 2 + impressions * 0.005);
  score += author.verified ? 10 : 0;
  score += Math.min(10, listed);
  score += relevanceScore(candidate.text, candidate.sourceQuery);

  if (followers < minimumFollowers) {
    riskFlags.push("low_followers");
    score -= 20;
  }

  if (author.createdAtX && accountAgeDays(author.createdAtX, now) < minimumAccountAgeDays) {
    riskFlags.push("new_account");
    score -= 25;
  }

  if (skipSensitive && candidate.sensitive) {
    riskFlags.push("sensitive");
    score -= 50;
  }

  if (skipScamLanguage && SCAM_LANGUAGE.test(candidate.text)) {
    riskFlags.push("scam_language");
    score -= 80;
  }

  if (options.optedOut) {
    riskFlags.push("opted_out");
    score -= 100;
  }

  const accepted = !riskFlags.some((flag) =>
    ["sensitive", "scam_language", "opted_out", "low_followers", "new_account"].includes(flag)
  );

  return {
    score: Math.round(score * 100) / 100,
    riskFlags,
    accepted
  };
}

function relevanceScore(text: string, query: string | undefined): number {
  if (!query) {
    return 0;
  }
  const normalizedText = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !term.startsWith("-") && !term.includes(":"));
  const matches = terms.filter((term) => normalizedText.includes(term)).length;
  return Math.min(15, matches * 5);
}

function numberMetric(metrics: Record<string, unknown>, key: string): number {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function accountAgeDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - created.getTime()) / 86_400_000;
}
