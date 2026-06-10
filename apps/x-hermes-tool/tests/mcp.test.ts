import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openXHermesDatabase } from "../src/db.js";
import { handleMcpRequest, MinimalMcpServer } from "../src/mcp.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("mcp", () => {
  it("lists the x-hermes workflow tools", async () => {
    const response = (await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as { tools: Array<{ name: string }> };

    expect(response.tools.map((tool) => tool.name)).toEqual([
      "status",
      "scan_recent_posts",
      "list_candidates",
      "get_candidate",
      "queue_reply_draft",
      "approve_candidate",
      "reject_candidate",
      "post_approved_reply",
      "record_opt_out",
      "get_stats"
    ]);
  });

  it("supports newline-delimited JSON stdio transport", async () => {
    const transport = startTestTransport();
    try {
      transport.input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" }
          }
        })}\n`
      );
      transport.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

      const responses = await waitForLineResponses(transport.output, 2);
      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "x-hermes" }
        }
      });
      expect(responses[1]).toMatchObject({
        jsonrpc: "2.0",
        id: 2
      });
      expect(
        (responses[1] as { result: { tools: Array<{ name: string }> } }).result.tools.map(
          (tool) => tool.name
        )
      ).toContain("status");
    } finally {
      transport.close();
    }
  });

  it("supports Content-Length framed stdio transport", async () => {
    const transport = startTestTransport();
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" }
        }
      });
      transport.input.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);

      expect(await waitForFramedResponse(transport.output)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "x-hermes" }
        }
      });
    } finally {
      transport.close();
    }
  });

  it("queues a draft and lists candidates through MCP tool calls", async () => {
    const root = await tempDir();
    process.env.X_HERMES_DATA_DIR = path.join(root, "data");
    const db = await openXHermesDatabase({ env: process.env });
    try {
      db.upsertAuthor({ authorId: "user-1", username: "alice" });
      db.upsertCandidate({
        tweetId: "tweet-1",
        authorId: "user-1",
        authorUsername: "alice",
        text: "hello",
        status: "found",
        score: 10,
        riskFlags: [],
        sensitive: false
      });
    } finally {
      db.close();
    }

    const queued = await callTool("queue_reply_draft", {
      tweetId: "tweet-1",
      text: "Draft from MCP",
      draftedBy: "test"
    });
    expect(queued.isError).toBe(false);
    expect(JSON.parse(queued.content[0].text)).toMatchObject({
      tweetId: "tweet-1",
      text: "Draft from MCP",
      status: "approval_pending"
    });

    const listed = await callTool("list_candidates", { status: "approval_pending" });
    expect(listed.isError).toBe(false);
    const candidates = JSON.parse(listed.content[0].text) as Array<{ tweetId: string }>;
    expect(candidates.map((candidate) => candidate.tweetId)).toEqual(["tweet-1"]);
  });
});

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; content: Array<{ type: string; text: string }> }> {
  return (await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  })) as { isError: boolean; content: Array<{ type: string; text: string }> };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

function startTestTransport(): {
  input: PassThrough;
  output: PassThrough;
  close: () => void;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const server = new MinimalMcpServer(input, output, errorOutput);
  server.start();

  return {
    input,
    output,
    close: () => {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
    }
  };
}

async function waitForLineResponses(output: PassThrough, count: number): Promise<unknown[]> {
  const responses: unknown[] = [];
  let buffered = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const lineEnd = buffered.indexOf("\n");
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 1);
      if (line.trim()) {
        responses.push(JSON.parse(line));
      }
    }
  });

  await waitFor(() => responses.length >= count);
  return responses.slice(0, count);
}

async function waitForFramedResponse(output: PassThrough): Promise<unknown> {
  let buffered = Buffer.alloc(0);

  output.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
  });

  await waitFor(() => {
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return false;
    }
    const header = buffered.subarray(0, headerEnd).toString("utf8");
    const lengthLine = header.split("\r\n").find((line) => line.toLowerCase().startsWith("content-length:"));
    if (!lengthLine) {
      return false;
    }
    const contentLength = Number(lengthLine.split(":")[1]?.trim());
    return buffered.length >= headerEnd + 4 + contentLength;
  });

  const headerEnd = buffered.indexOf("\r\n\r\n");
  const header = buffered.subarray(0, headerEnd).toString("utf8");
  const lengthLine = header.split("\r\n").find((line) => line.toLowerCase().startsWith("content-length:"));
  const contentLength = Number(lengthLine?.split(":")[1]?.trim());
  const bodyStart = headerEnd + 4;
  const body = buffered.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
  return JSON.parse(body);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for MCP transport response");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
