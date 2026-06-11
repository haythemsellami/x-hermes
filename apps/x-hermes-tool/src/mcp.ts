#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectStatus } from "./setup.js";
import type { CandidateStatus } from "./types.js";

type McpResponseMode = "headers" | "lines";

const SERVER_INFO = {
  name: "x-hermes",
  version: "0.1.0"
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function startMcpServer(): Promise<void> {
  const server = new MinimalMcpServer();
  server.start();
}

export class MinimalMcpServer {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly errorOutput: NodeJS.WritableStream = process.stderr
  ) {}

  start(): void {
    this.input.on("data", (chunk: Buffer | string) => this.onData(Buffer.from(chunk)));
    this.input.on("error", (error: Error) => {
      this.errorOutput.write(`mcp stdin error: ${error.message}\n`);
    });
    this.input.resume?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (startsWithContentLengthHeader(this.buffer)) {
        const header = findHeader(this.buffer);
        if (!header) {
          return;
        }

        const contentLength = parseContentLength(header.text);
        if (contentLength === null) {
          this.errorOutput.write("mcp message missing Content-Length header\n");
          this.buffer = Buffer.alloc(0);
          return;
        }

        const bodyStart = header.end + header.delimiterLength;
        const bodyEnd = bodyStart + contentLength;
        if (this.buffer.length < bodyEnd) {
          return;
        }

        const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
        this.buffer = this.buffer.slice(bodyEnd);
        void this.handleBody(body, "headers");
        continue;
      }

      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }

      const line = this.buffer.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (line.trim()) {
        void this.handleBody(line, "lines");
      }
    }
  }

  private async handleBody(body: string, responseMode: McpResponseMode): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.writeResponse(responseMode, null, {
        code: -32700,
        message: "Parse error"
      });
      return;
    }

    if (!("id" in request)) {
      return;
    }

    try {
      const result = await handleMcpRequest(request);
      this.writeResponse(responseMode, request.id ?? null, undefined, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeResponse(responseMode, request.id ?? null, {
        code: -32603,
        message
      });
    }
  }

  private writeResponse(
    mode: McpResponseMode,
    id: string | number | null,
    error?: { code: number; message: string },
    result?: unknown
  ): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result })
    });
    if (mode === "lines") {
      this.output.write(`${payload}\n`);
      return;
    }
    this.output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }
}

export async function handleMcpRequest(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion:
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : "2025-06-18",
        capabilities: {
          tools: {}
        },
        serverInfo: SERVER_INFO
      };

    case "tools/list":
      return {
        tools: [
          {
            name: "status",
            description: "Report x-hermes readiness without exposing secrets.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {}
            }
          },
          {
            name: "scan_recent_posts",
            description: "Run x-hermes scan for a direct query, a watch query, or all enabled watch queries.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                query: { type: "string" },
                watchQueryId: { type: "string" },
                limit: { type: "number" }
              }
            }
          },
          {
            name: "list_candidates",
            description: "List stored candidates.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                status: { type: "string" },
                limit: { type: "number" }
              }
            }
          },
          {
            name: "get_candidate",
            description: "Get one candidate and its latest draft.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tweetId"],
              properties: {
                tweetId: { type: "string" }
              }
            }
          },
          {
            name: "queue_reply_draft",
            description: "Queue a reply draft for human approval.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tweetId", "text"],
              properties: {
                tweetId: { type: "string" },
                text: { type: "string" },
                draftedBy: { type: "string" }
              }
            }
          },
          {
            name: "approve_candidate",
            description: "Approve a candidate that has a queued draft.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tweetId", "approvedBy"],
              properties: {
                tweetId: { type: "string" },
                approvedBy: { type: "string" },
                reason: { type: "string" }
              }
            }
          },
          {
            name: "reject_candidate",
            description: "Reject a candidate.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tweetId"],
              properties: {
                tweetId: { type: "string" },
                actor: { type: "string" },
                reason: { type: "string" }
              }
            }
          },
          {
            name: "list_approval_requests",
            description: "List approval inbox requests for human review.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                status: { type: "string" },
                limit: { type: "number" }
              }
            }
          },
          {
            name: "get_approval_request",
            description: "Get one approval request with candidate and draft details.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: {
                id: { type: "string" }
              }
            }
          },
          {
            name: "render_approval_request",
            description: "Render a channel-neutral approval message for a human.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: {
                id: { type: "string" }
              }
            }
          },
          {
            name: "record_approval_delivery",
            description: "Record that an approval request was sent by a messaging gateway.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "deliveryStatus"],
              properties: {
                id: { type: "string" },
                deliveryStatus: { type: "string" },
                channel: { type: "string" },
                recipient: { type: "string" },
                externalMessageId: { type: "string" },
                actor: { type: "string" }
              }
            }
          },
          {
            name: "approve_request",
            description: "Approve a pending approval request and store feedback.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "approvedBy"],
              properties: {
                id: { type: "string" },
                approvedBy: { type: "string" },
                reason: { type: "string" }
              }
            }
          },
          {
            name: "reject_request",
            description: "Reject a pending approval request and store feedback.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "rejectedBy"],
              properties: {
                id: { type: "string" },
                rejectedBy: { type: "string" },
                reason: { type: "string" }
              }
            }
          },
          {
            name: "edit_draft",
            description: "Edit the draft attached to a pending approval request.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "text"],
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                editedBy: { type: "string" }
              }
            }
          },
          {
            name: "process_approval_response",
            description: "Parse and apply a human response such as approve: reason, reject: reason, or edit: text.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "message", "actor"],
              properties: {
                id: { type: "string" },
                message: { type: "string" },
                actor: { type: "string" },
                channel: { type: "string" }
              }
            }
          },
          {
            name: "post_approved_reply",
            description: "Post an approved reply only when all guardrails pass.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["tweetId"],
              properties: {
                tweetId: { type: "string" },
                actor: { type: "string" }
              }
            }
          },
          {
            name: "record_opt_out",
            description: "Record a user opt-out.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["username"],
              properties: {
                username: { type: "string" },
                actor: { type: "string" },
                reason: { type: "string" }
              }
            }
          },
          {
            name: "list_campaigns",
            description: "List configured YAML campaigns.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {}
            }
          },
          {
            name: "run_campaigns_once",
            description: "Run one configured campaign or all enabled campaigns once.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                campaignId: { type: "string" }
              }
            }
          },
          {
            name: "get_stats",
            description: "Get x-hermes queue and audit stats.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {}
            }
          },
          {
            name: "get_feedback_profile",
            description: "Get approval/rejection feedback examples and drafting guidance for an LLM.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                limit: { type: "number" }
              }
            }
          }
        ]
      };

    case "tools/call":
      return await handleToolCall(request.params ?? {});

    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

async function handleToolCall(params: Record<string, unknown>): Promise<unknown> {
  const name = asString(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};

  try {
    switch (name) {
      case "status": {
        const report = await collectStatus({ withHermes: false, mutateStorage: false });
        return toolResult(report);
      }

      case "scan_recent_posts": {
        const { scanRecentPosts } = await import("./scanner.js");
        return toolResult(
          await scanRecentPosts({
            query: optionalString(args.query),
            watchQueryId: optionalString(args.watchQueryId),
            limit: optionalNumber(args.limit) ?? 25
          })
        );
      }

      case "list_candidates": {
        const { listCandidates } = await import("./queue.js");
        return toolResult(
          await listCandidates({
            status: optionalString(args.status) as CandidateStatus | undefined,
            limit: optionalNumber(args.limit) ?? 50
          })
        );
      }

      case "get_candidate": {
        const { getCandidateDetails } = await import("./queue.js");
        return toolResult(await getCandidateDetails({ tweetId: requiredString(args.tweetId, "tweetId") }));
      }

      case "queue_reply_draft": {
        const { queueReplyDraft } = await import("./queue.js");
        return toolResult(
          await queueReplyDraft({
            tweetId: requiredString(args.tweetId, "tweetId"),
            text: requiredString(args.text, "text"),
            draftedBy: optionalString(args.draftedBy) ?? "hermes"
          })
        );
      }

      case "approve_candidate": {
        const { approveCandidate } = await import("./queue.js");
        return toolResult(
          await approveCandidate({
            tweetId: requiredString(args.tweetId, "tweetId"),
            approvedBy: requiredString(args.approvedBy, "approvedBy"),
            reason: optionalString(args.reason)
          })
        );
      }

      case "reject_candidate": {
        const { rejectCandidate } = await import("./queue.js");
        await rejectCandidate({
          tweetId: requiredString(args.tweetId, "tweetId"),
          actor: optionalString(args.actor) ?? "hermes",
          reason: optionalString(args.reason)
        });
        return toolResult({ rejected: true, tweetId: args.tweetId });
      }

      case "list_approval_requests": {
        const { listApprovalRequests } = await import("./approvals.js");
        return toolResult(
          await listApprovalRequests({
            status: optionalString(args.status) as
              | "pending"
              | "approved"
              | "rejected"
              | "expired"
              | undefined,
            limit: optionalNumber(args.limit) ?? 50
          })
        );
      }

      case "get_approval_request": {
        const { getApprovalRequestDetails } = await import("./approvals.js");
        return toolResult(await getApprovalRequestDetails({ id: requiredString(args.id, "id") }));
      }

      case "render_approval_request": {
        const { getApprovalRequestDetails, renderApprovalRequestMessage } = await import("./approvals.js");
        const details = await getApprovalRequestDetails({ id: requiredString(args.id, "id") });
        return toolResult({
          request: details.request,
          message: details.request.messageText ?? renderApprovalRequestMessage(details)
        });
      }

      case "record_approval_delivery": {
        const { recordApprovalDelivery } = await import("./approvals.js");
        return toolResult(
          await recordApprovalDelivery({
            id: requiredString(args.id, "id"),
            deliveryStatus: requiredString(args.deliveryStatus, "deliveryStatus") as "sent" | "failed",
            channel: optionalString(args.channel),
            recipient: optionalString(args.recipient),
            externalMessageId: optionalString(args.externalMessageId),
            actor: optionalString(args.actor) ?? "hermes"
          })
        );
      }

      case "approve_request": {
        const { approveApprovalRequest } = await import("./approvals.js");
        return toolResult(
          await approveApprovalRequest({
            id: requiredString(args.id, "id"),
            approvedBy: requiredString(args.approvedBy, "approvedBy"),
            reason: optionalString(args.reason)
          })
        );
      }

      case "reject_request": {
        const { rejectApprovalRequest } = await import("./approvals.js");
        return toolResult(
          await rejectApprovalRequest({
            id: requiredString(args.id, "id"),
            rejectedBy: requiredString(args.rejectedBy, "rejectedBy"),
            reason: optionalString(args.reason)
          })
        );
      }

      case "edit_draft": {
        const { editApprovalRequestDraft } = await import("./approvals.js");
        return toolResult(
          await editApprovalRequestDraft({
            id: requiredString(args.id, "id"),
            text: requiredString(args.text, "text"),
            editedBy: optionalString(args.editedBy) ?? "hermes"
          })
        );
      }

      case "process_approval_response": {
        const { processApprovalResponse } = await import("./approvals.js");
        return toolResult(
          await processApprovalResponse({
            id: requiredString(args.id, "id"),
            message: requiredString(args.message, "message"),
            actor: requiredString(args.actor, "actor"),
            channel: optionalString(args.channel)
          })
        );
      }

      case "post_approved_reply": {
        const { postApprovedReply } = await import("./posting.js");
        const result = await postApprovedReply({
          tweetId: requiredString(args.tweetId, "tweetId"),
          actor: optionalString(args.actor) ?? "hermes"
        });
        return result.posted ? toolResult(result) : toolError(result);
      }

      case "record_opt_out": {
        const { recordOptOut } = await import("./queue.js");
        await recordOptOut({
          username: requiredString(args.username, "username"),
          actor: optionalString(args.actor) ?? "hermes",
          reason: optionalString(args.reason)
        });
        return toolResult({ recorded: true, username: args.username });
      }

      case "list_campaigns": {
        const { loadConfig } = await import("./config.js");
        const loaded = await loadConfig();
        return toolResult(loaded.config.campaigns);
      }

      case "run_campaigns_once": {
        const { runCampaignsOnce } = await import("./campaigns.js");
        return toolResult(
          await runCampaignsOnce({
            campaignId: optionalString(args.campaignId),
            output: process.stderr
          })
        );
      }

      case "get_stats": {
        const { openXHermesDatabase } = await import("./db.js");
        const db = await openXHermesDatabase();
        try {
          return toolResult(db.getStats());
        } finally {
          db.close();
        }
      }

      case "get_feedback_profile": {
        const { getFeedbackProfile } = await import("./feedback.js");
        const { openXHermesDatabase } = await import("./db.js");
        const db = await openXHermesDatabase();
        try {
          return toolResult(getFeedbackProfile(db, optionalNumber(args.limit) ?? 100));
        } finally {
          db.close();
        }
      }

      default:
        return toolError(`Unsupported tool: ${String(name)}`);
    }
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function parseContentLength(header: string): number | null {
  for (const line of header.split(/\r?\n/)) {
    const [key, value] = line.split(":").map((part) => part.trim());
    if (key.toLowerCase() === "content-length") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function startsWithContentLengthHeader(buffer: Buffer): boolean {
  return buffer.subarray(0, 16).toString("utf8").toLowerCase().startsWith("content-length:");
}

function findHeader(buffer: Buffer): { text: string; end: number; delimiterLength: number } | null {
  const crlfEnd = buffer.indexOf("\r\n\r\n");
  const lfEnd = buffer.indexOf("\n\n");
  const candidates = [
    crlfEnd === -1 ? undefined : { end: crlfEnd, delimiterLength: 4 },
    lfEnd === -1 ? undefined : { end: lfEnd, delimiterLength: 2 }
  ].filter((candidate): candidate is { end: number; delimiterLength: number } =>
    Boolean(candidate)
  );
  if (!candidates.length) {
    return null;
  }

  const selected = candidates.sort((a, b) => a.end - b.end)[0]!;
  return {
    ...selected,
    text: buffer.subarray(0, selected.end).toString("utf8")
  };
}

function toolResult(value: unknown): unknown {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function toolError(value: unknown): unknown {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return result;
}

if (isDirectExecution()) {
  startMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}
