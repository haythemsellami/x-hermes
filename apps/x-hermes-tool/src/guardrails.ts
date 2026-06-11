import type { XHermesDatabase } from "./db.js";
import type {
  GuardrailFailure,
  GuardrailResult,
  ReplyDraftRecord,
  StoredCandidateRecord,
  XHermesConfig
} from "./types.js";

export interface PostingGuardrailInput {
  config: XHermesConfig;
  db: XHermesDatabase;
  candidate: StoredCandidateRecord;
  draft?: ReplyDraftRecord;
  now?: Date;
}

export function evaluatePostingGuardrails(input: PostingGuardrailInput): GuardrailResult {
  const now = input.now ?? new Date();
  const failures: GuardrailFailure[] = [];

  if (!input.config.postingEnabled) {
    failures.push({
      id: "posting_disabled",
      message: "Posting is disabled in config."
    });
  }

  if (input.candidate.status !== "approved") {
    failures.push({
      id: "candidate_not_approved",
      message: `Candidate status is ${input.candidate.status}, not approved.`
    });
  }

  if (!input.draft || input.draft.status !== "approved") {
    failures.push({
      id: "draft_not_approved",
      message: "Candidate does not have an approved draft."
    });
  }

  if (!isWithinActiveHours(input.config, now)) {
    failures.push({
      id: "outside_active_hours",
      message: "Current time is outside configured active hours."
    });
  }

  const sinceDailyWindow = new Date(now.getTime() - 86_400_000).toISOString();
  const postedToday = input.db.countPostedRepliesSince(sinceDailyWindow);
  if (postedToday >= input.config.maxRepliesPerDay) {
    failures.push({
      id: "daily_cap_reached",
      message: `Daily reply cap reached: ${postedToday}/${input.config.maxRepliesPerDay}.`
    });
  }

  const latestAuthorReply = input.db.latestPostedReplyForAuthor(input.candidate.authorId);
  if (latestAuthorReply) {
    const ageHours = (now.getTime() - new Date(latestAuthorReply.postedAt).getTime()) / 3_600_000;
    if (ageHours < input.config.perAuthorCooldownHours) {
      failures.push({
        id: "author_cooldown",
        message: `Author cooldown has not elapsed (${Math.max(0, ageHours).toFixed(1)}h).`
      });
    }
  }

  if (input.candidate.riskFlags.length > 0) {
    failures.push({
      id: "unresolved_risk_flags",
      message: `Candidate has unresolved risk flags: ${input.candidate.riskFlags.join(", ")}.`
    });
  }

  if (input.config.blockDuplicateReplyText && input.draft) {
    const duplicateSince = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const duplicateCount = input.db.countDuplicateReplyTextSince(input.draft.text, duplicateSince);
    if (duplicateCount > 0) {
      failures.push({
        id: "duplicate_reply_text",
        message: "Same reply text was already posted in the last 7 days."
      });
    }
  }

  if (input.config.requireOptInForAutoPost && !hasOptInEvidence(input.config, input.candidate)) {
    failures.push({
      id: "missing_opt_in",
      message: "Candidate lacks opt-in evidence required for auto-posting."
    });
  }

  if (input.db.isOptedOut(input.candidate.authorUsername)) {
    failures.push({
      id: "author_opted_out",
      message: "Candidate author is on the opt-out list."
    });
  }

  return {
    allowed: failures.length === 0,
    failures
  };
}

export function isWithinActiveHours(config: XHermesConfig, now: Date): boolean {
  const currentMinutes = localMinutesInTimezone(now, config.activeHours.timezone);
  const startMinutes = parseClockMinutes(config.activeHours.start);
  const endMinutes = parseClockMinutes(config.activeHours.end);

  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function hasOptInEvidence(config: XHermesConfig, candidate: StoredCandidateRecord): boolean {
  const username = config.username.replace(/^@/, "").toLowerCase();
  if (!username) {
    return false;
  }
  const mention = `@${username}`;
  const text = candidate.text.toLowerCase();
  const sourceQuery = candidate.sourceQuery?.toLowerCase() ?? "";
  return text.includes(mention) || sourceQuery.includes(mention) || sourceQuery.includes(`to:${username}`);
}

function localMinutesInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function parseClockMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid active-hours time: ${value}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid active-hours time: ${value}`);
  }
  return hour * 60 + minute;
}
