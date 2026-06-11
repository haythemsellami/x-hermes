import type { XHermesDatabase } from "./db.js";
import type { CandidateRecord, FeedbackProfile } from "./types.js";

const LABEL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "low_relevance", pattern: /\b(low relevance|irrelevant|not relevant|off[- ]?topic|weak intent)\b/i },
  { label: "wrong_audience", pattern: /\b(wrong audience|not our audience|not target|bad fit)\b/i },
  { label: "too_generic", pattern: /\b(generic|vague|boilerplate|not specific)\b/i },
  { label: "too_salesy", pattern: /\b(salesy|promotional|shill|too much marketing|spammy)\b/i },
  { label: "unsafe_claim", pattern: /\b(unsafe|risky|compliance|promise|guarantee|financial advice)\b/i },
  { label: "inaccurate", pattern: /\b(inaccurate|wrong|false|incorrect|hallucinat)\b/i },
  { label: "duplicate", pattern: /\b(duplicate|already answered|repeat)\b/i },
  { label: "good_fit", pattern: /\b(good fit|relevant|useful|on target|looks good)\b/i },
  { label: "good_tone", pattern: /\b(good tone|clear|concise|specific)\b/i }
];

export interface FeedbackSignals {
  riskFlags: string[];
  scoreDelta: number;
  skip: boolean;
}

export function normalizeFeedbackLabels(reason: string | undefined, decision: "approved" | "rejected"): string[] {
  const labels = new Set<string>();
  if (decision === "approved") {
    labels.add("approved");
  } else {
    labels.add("rejected");
  }

  const text = reason?.trim();
  if (!text) {
    return [...labels];
  }

  for (const entry of LABEL_PATTERNS) {
    if (entry.pattern.test(text)) {
      labels.add(entry.label);
    }
  }

  return [...labels];
}

export function feedbackSignalsForCandidate(
  db: XHermesDatabase,
  candidate: CandidateRecord
): FeedbackSignals {
  const riskFlags: string[] = [];
  let scoreDelta = 0;
  let skip = false;

  const authorStats = db.feedbackStatsForAuthor(candidate.authorUsername);
  if (authorStats.rejected >= 2 && authorStats.approved === 0) {
    riskFlags.push("feedback_rejected_author");
    scoreDelta -= 60;
    skip = true;
  } else if (authorStats.rejected > authorStats.approved) {
    riskFlags.push("feedback_author_mixed");
    scoreDelta -= 15;
  }

  if (candidate.sourceQuery) {
    const queryStats = db.feedbackStatsForSourceQuery(candidate.sourceQuery);
    if (queryStats.rejected >= 3 && queryStats.approved === 0) {
      riskFlags.push("feedback_low_approval_query");
      scoreDelta -= 40;
      skip = true;
    } else if (queryStats.rejected >= 5 && queryStats.approved / queryStats.rejected < 0.25) {
      riskFlags.push("feedback_query_needs_review");
      scoreDelta -= 20;
    }
  }

  return { riskFlags, scoreDelta, skip };
}

export function getFeedbackProfile(db: XHermesDatabase, exampleLimit = 100): FeedbackProfile {
  return db.getFeedbackProfile({ exampleLimit });
}
