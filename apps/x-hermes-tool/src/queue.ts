import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
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
    db.updateDraftStatus(draft.id, "approved");
    db.updateCandidateStatus(options.tweetId, "approved");
    db.recordAuditEvent({
      eventType: "candidate.approved",
      actor: options.approvedBy,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { draftId: draft.id, reason: options.reason }
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
    db.updateCandidateStatus(options.tweetId, "rejected");
    db.recordAuditEvent({
      eventType: "candidate.rejected",
      actor: options.actor,
      entityType: "candidate",
      entityId: options.tweetId,
      details: { reason: options.reason }
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

