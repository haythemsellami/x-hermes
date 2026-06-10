#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectStatus } from "./setup.js";

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
      const result = await handleRequest(request);
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

async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
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
  if (params.name !== "status") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Unsupported tool: ${String(params.name)}`
        }
      ]
    };
  }

  const report = await collectStatus({ withHermes: false, mutateStorage: false });
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify(report, null, 2)
      }
    ]
  };
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
