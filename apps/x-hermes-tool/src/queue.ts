import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
import {
  approveApprovalRequest,
  createApprovalRequestForDraft,
  rejectApprovalRequest
} from "./approvals.js";
import { normalizeFeedbackLabels } from "./feedback.js";
import type { CandidateStatus, ReplyDraftRecord, StoredCandidateRecord } from "./types.js";

export interface CandidateDetails {
  candidate: StoredCandidateRecord;
  draft?: ReplyDraftRecord;
}

export async function listCandidates(options: {
  status?: CandidateStatus;
  limit?: number;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredCandidateRecord[]> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    return db.listCandidates({ status: options.status, limit: options.limit });
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function getCandidateDetails(options: {
  tweetId: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<CandidateDetails> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const candidate = db.getCandidate(options.tweetId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${options.tweetId}`);
    }
    return {
      candidate,
      draft: db.getLatestDraftForCandidate(options.tweetId)
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function queueReplyDraft(options: {
  tweetId: string;
  text: string;
  draftedBy: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ReplyDraftRecord> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const candidate = db.getCandidate(options.tweetId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${options.tweetId}`);
    }
    if (candidate.status === "posted") {
      throw new Error(`Candidate already posted: ${options.tweetId}`);
    }
    const draft = db.createReplyDraft({
      tweetId: options.tweetId,
      text: options.text,
      draftedBy: options.draftedBy
    });
    db.recordAuditEvent({
      eventType: "draft.queued",
      actor: options.draftedBy,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { draftId: draft.id }
    });
    await createApprovalRequestForDraft({
      tweetId: options.tweetId,
      draftId: draft.id,
      requestedBy: options.draftedBy,
      db
    });
    return draft;
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function approveCandidate(options: {
  tweetId: string;
  approvedBy: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ReplyDraftRecord> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const candidate = db.getCandidate(options.tweetId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${options.tweetId}`);
    }
    const draft = db.getLatestDraftForCandidate(options.tweetId);
    if (!draft) {
      throw new Error(`Candidate has no draft to approve: ${options.tweetId}`);
    }
    const pendingRequest = db.getLatestPendingApprovalRequestForCandidate(options.tweetId);
    if (pendingRequest) {
      const result = await approveApprovalRequest({
        id: pendingRequest.id,
        approvedBy: options.approvedBy,
        reason: options.reason,
        db
      });
      return result.draft;
    }

    db.updateDraftStatus(draft.id, "approved");
    db.updateCandidateStatus(options.tweetId, "approved");
    const labels = normalizeFeedbackLabels(options.reason, "approved");
    db.recordFeedbackExample({
      tweetId: candidate.tweetId,
      draftId: draft.id,
      decision: "approved",
      reason: options.reason,
      labels,
      candidateText: candidate.text,
      draftText: draft.text,
      sourceQuery: candidate.sourceQuery,
      authorUsername: candidate.authorUsername
    });
    db.recordAuditEvent({
      eventType: "candidate.approved",
      actor: options.approvedBy,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { draftId: draft.id, reason: options.reason, labels }
    });
    const saved = db.getReplyDraft(draft.id);
    if (!saved) {
      throw new Error(`Draft disappeared after approval: ${draft.id}`);
    }
    return saved;
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function rejectCandidate(options: {
  tweetId: string;
  actor: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const candidate = db.getCandidate(options.tweetId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${options.tweetId}`);
    }
    const pendingRequest = db.getLatestPendingApprovalRequestForCandidate(options.tweetId);
    if (pendingRequest) {
      await rejectApprovalRequest({
        id: pendingRequest.id,
        rejectedBy: options.actor,
        reason: options.reason,
        db
      });
      return;
    }

    const draft = db.getLatestDraftForCandidate(options.tweetId);
    if (draft) {
      db.updateDraftStatus(draft.id, "rejected");
    }
    db.updateCandidateStatus(options.tweetId, "rejected");
    const labels = normalizeFeedbackLabels(options.reason, "rejected");
    db.recordFeedbackExample({
      tweetId: candidate.tweetId,
      draftId: draft?.id,
      decision: "rejected",
      reason: options.reason,
      labels,
      candidateText: candidate.text,
      draftText: draft?.text,
      sourceQuery: candidate.sourceQuery,
      authorUsername: candidate.authorUsername
    });
    db.recordAuditEvent({
      eventType: "candidate.rejected",
      actor: options.actor,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { reason: options.reason, labels }
    });
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function recordOptOut(options: {
  username: string;
  actor: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    db.addOptOut({ username: options.username, reason: options.reason });
    db.recordAuditEvent({
      eventType: "opt_out.recorded",
      actor: options.actor,
      entityType: "opt_out",
      entityId: options.username.replace(/^@/, "").toLowerCase(),
      details: { reason: options.reason }
    });
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}
