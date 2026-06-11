import { openXHermesDatabase, type XHermesDatabase } from "./db.js";
import { normalizeFeedbackLabels } from "./feedback.js";
import type {
  ApprovalDeliveryStatus,
  ApprovalRequestDetails,
  ApprovalRequestRecord,
  ApprovalRequestStatus,
  ReplyDraftRecord,
  StoredCandidateRecord
} from "./types.js";

export interface ApprovalActionResult {
  request: ApprovalRequestRecord;
  candidate: StoredCandidateRecord;
  draft: ReplyDraftRecord;
  message: string;
}

export type ParsedApprovalResponse =
  | { action: "approve"; reason?: string }
  | { action: "reject"; reason?: string }
  | { action: "edit"; text: string };

export async function createApprovalRequestForDraft(options: {
  tweetId: string;
  draftId: string;
  requestedBy: string;
  channel?: string;
  recipient?: string;
  expiresAt?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalRequestDetails> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    let request = db.createApprovalRequest({
      tweetId: options.tweetId,
      draftId: options.draftId,
      requestedBy: options.requestedBy,
      channel: options.channel,
      recipient: options.recipient,
      expiresAt: options.expiresAt
    });
    const details = getApprovalRequestDetailsFromDb(db, request.id);
    request = db.updateApprovalRequestMessage(request.id, renderApprovalRequestMessage(details));
    db.recordAuditEvent({
      eventType: "approval.requested",
      actor: options.requestedBy,
      entityType: "approval_request",
      entityId: request.id,
      details: {
        tweetId: request.tweetId,
        draftId: request.draftId,
        channel: request.channel,
        recipient: request.recipient
      }
    });
    return {
      ...details,
      request
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function listApprovalRequests(options: {
  status?: ApprovalRequestStatus;
  limit?: number;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ApprovalRequestRecord[]> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    return db.listApprovalRequests({ status: options.status, limit: options.limit });
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function getApprovalRequestDetails(options: {
  id: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalRequestDetails> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    return getApprovalRequestDetailsFromDb(db, options.id);
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function recordApprovalDelivery(options: {
  id: string;
  channel?: string;
  recipient?: string;
  externalMessageId?: string;
  deliveryStatus: ApprovalDeliveryStatus;
  actor?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalRequestRecord> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const request = db.updateApprovalDelivery({
      id: options.id,
      channel: options.channel,
      recipient: options.recipient,
      externalMessageId: options.externalMessageId,
      deliveryStatus: options.deliveryStatus
    });
    db.recordAuditEvent({
      eventType: "approval.delivery_recorded",
      actor: options.actor ?? "x-hermes",
      entityType: "approval_request",
      entityId: request.id,
      details: {
        channel: request.channel,
        recipient: request.recipient,
        externalMessageId: request.externalMessageId,
        deliveryStatus: request.deliveryStatus
      }
    });
    return request;
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function approveApprovalRequest(options: {
  id: string;
  approvedBy: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalActionResult> {
  return decideApprovalRequest({
    id: options.id,
    decision: "approved",
    actor: options.approvedBy,
    reason: options.reason,
    db: options.db,
    env: options.env
  });
}

export async function rejectApprovalRequest(options: {
  id: string;
  rejectedBy: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalActionResult> {
  return decideApprovalRequest({
    id: options.id,
    decision: "rejected",
    actor: options.rejectedBy,
    reason: options.reason,
    db: options.db,
    env: options.env
  });
}

export async function editApprovalRequestDraft(options: {
  id: string;
  text: string;
  editedBy: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalActionResult> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const details = getApprovalRequestDetailsFromDb(db, options.id);
    if (details.request.status !== "pending") {
      throw new Error(`Approval request ${options.id} is ${details.request.status}, not pending.`);
    }
    const draft = db.updateDraftText(details.draft.id, options.text, "approval_pending");
    db.updateCandidateStatus(details.candidate.tweetId, "approval_pending");
    db.recordAuditEvent({
      eventType: "approval.draft_edited",
      actor: options.editedBy,
      entityType: "approval_request",
      entityId: details.request.id,
      details: {
        tweetId: details.candidate.tweetId,
        draftId: draft.id
      }
    });
    const updated = getApprovalRequestDetailsFromDb(db, options.id);
    const message = renderApprovalRequestMessage(updated);
    db.updateApprovalRequestMessage(options.id, message);
    return {
      request: db.getApprovalRequest(options.id) ?? updated.request,
      candidate: updated.candidate,
      draft,
      message
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

export async function processApprovalResponse(options: {
  id: string;
  message: string;
  actor: string;
  channel?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalActionResult & { parsed: ParsedApprovalResponse }> {
  const parsed = parseApprovalResponse(options.message);
  switch (parsed.action) {
    case "approve": {
      const result = await approveApprovalRequest({
        id: options.id,
        approvedBy: options.actor,
        reason: parsed.reason,
        db: options.db,
        env: options.env
      });
      return { ...result, parsed };
    }
    case "reject": {
      const result = await rejectApprovalRequest({
        id: options.id,
        rejectedBy: options.actor,
        reason: parsed.reason,
        db: options.db,
        env: options.env
      });
      return { ...result, parsed };
    }
    case "edit": {
      const result = await editApprovalRequestDraft({
        id: options.id,
        text: parsed.text,
        editedBy: options.actor,
        db: options.db,
        env: options.env
      });
      return { ...result, parsed };
    }
  }
}

export function parseApprovalResponse(message: string): ParsedApprovalResponse {
  const text = message.trim();
  if (!text) {
    throw new Error("Empty approval response.");
  }

  const approveMatch = /^(?:approve|approved|yes|y)(?:\s*[:\-]\s*(.*))?$/i.exec(text);
  if (approveMatch) {
    return { action: "approve", reason: cleanOptional(approveMatch[1]) };
  }

  const rejectMatch = /^(?:reject|rejected|deny|denied|no|n)(?:\s*[:\-]\s*(.*))?$/i.exec(text);
  if (rejectMatch) {
    return { action: "reject", reason: cleanOptional(rejectMatch[1]) };
  }

  const editMatch = /^edit\s*[:\-]\s*(.+)$/i.exec(text);
  if (editMatch?.[1]?.trim()) {
    return { action: "edit", text: editMatch[1].trim() };
  }

  throw new Error("Approval response must start with approve, reject, deny, no, or edit:.");
}

export function renderApprovalRequestMessage(details: ApprovalRequestDetails): string {
  const candidate = details.candidate;
  const draft = details.draft;
  const url = candidate.url ? `\nURL: ${candidate.url}` : "";
  const riskFlags = candidate.riskFlags.length ? candidate.riskFlags.join(", ") : "none";
  return [
    `x-hermes approval request ${details.request.id}`,
    "",
    `Tweet from @${candidate.authorUsername}:${url}`,
    candidate.text,
    "",
    "Draft reply:",
    draft.text,
    "",
    `Score: ${candidate.score}`,
    `Risk flags: ${riskFlags}`,
    "",
    "Reply with one of:",
    "approve",
    "approve: reason",
    "reject: reason",
    "edit: replacement reply text"
  ].join("\n");
}

function getApprovalRequestDetailsFromDb(
  db: XHermesDatabase,
  id: string
): ApprovalRequestDetails {
  const request = db.getApprovalRequest(id);
  if (!request) {
    throw new Error(`Approval request not found: ${id}`);
  }
  const candidate = db.getCandidate(request.tweetId);
  if (!candidate) {
    throw new Error(`Candidate not found for approval request: ${request.tweetId}`);
  }
  const draft = db.getReplyDraft(request.draftId);
  if (!draft) {
    throw new Error(`Draft not found for approval request: ${request.draftId}`);
  }
  return { request, candidate, draft };
}

async function decideApprovalRequest(options: {
  id: string;
  decision: "approved" | "rejected";
  actor: string;
  reason?: string;
  db?: XHermesDatabase;
  env?: NodeJS.ProcessEnv;
}): Promise<ApprovalActionResult> {
  const ownsDb = !options.db;
  const db = options.db ?? (await openXHermesDatabase({ env: options.env }));
  try {
    const details = getApprovalRequestDetailsFromDb(db, options.id);
    if (details.request.status !== "pending") {
      throw new Error(`Approval request ${options.id} is ${details.request.status}, not pending.`);
    }

    const labels = normalizeFeedbackLabels(options.reason, options.decision);
    const nextDraftStatus = options.decision === "approved" ? "approved" : "rejected";
    const nextCandidateStatus = options.decision === "approved" ? "approved" : "rejected";
    db.updateDraftStatus(details.draft.id, nextDraftStatus);
    db.updateCandidateStatus(details.candidate.tweetId, nextCandidateStatus);
    const request = db.decideApprovalRequest({
      id: options.id,
      status: options.decision,
      decidedBy: options.actor,
      reason: options.reason,
      labels
    });
    db.recordFeedbackExample({
      approvalRequestId: request.id,
      tweetId: details.candidate.tweetId,
      draftId: details.draft.id,
      decision: options.decision,
      reason: options.reason,
      labels,
      candidateText: details.candidate.text,
      draftText: details.draft.text,
      sourceQuery: details.candidate.sourceQuery,
      authorUsername: details.candidate.authorUsername
    });
    db.recordAuditEvent({
      eventType: options.decision === "approved" ? "candidate.approved" : "candidate.rejected",
      actor: options.actor,
      entityType: "approval_request",
      entityId: request.id,
      details: {
        tweetId: details.candidate.tweetId,
        draftId: details.draft.id,
        reason: options.reason,
        labels
      }
    });
    return {
      request,
      candidate: db.getCandidate(details.candidate.tweetId) ?? details.candidate,
      draft: db.getReplyDraft(details.draft.id) ?? details.draft,
      message:
        options.decision === "approved"
          ? `Approved approval request ${request.id}.`
          : `Rejected approval request ${request.id}.`
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}
