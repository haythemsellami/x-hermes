#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectStatus } from "./setup.js";
import type { CandidateStatus } from "./types.js";

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

class MinimalMcpServer {
  private buffer = Buffer.alloc(0);

  start(): void {
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("error", (error) => {
      process.stderr.write(`mcp stdin error: ${error.message}\n`);
    });
    process.stdin.resume();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(header);
      if (contentLength === null) {
        process.stderr.write("mcp message missing Content-Length header\n");
        this.buffer = Buffer.alloc(0);
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      void this.handleBody(body);
    }
  }

  private async handleBody(body: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.writeResponse(null, {
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
      this.writeResponse(request.id ?? null, undefined, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeResponse(request.id ?? null, {
        code: -32603,
        message
      });
    }
  }

  private writeResponse(
    id: string | number | null,
    error?: { code: number; message: string },
    result?: unknown
  ): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result })
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
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
            name: "get_stats",
            description: "Get x-hermes queue and audit stats.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {}
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

      case "get_stats": {
        const { openXHermesDatabase } = await import("./db.js");
        const db = await openXHermesDatabase();
        try {
          return toolResult(db.getStats());
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
  for (const line of header.split("\r\n")) {
    const [key, value] = line.split(":").map((part) => part.trim());
    if (key.toLowerCase() === "content-length") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
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
