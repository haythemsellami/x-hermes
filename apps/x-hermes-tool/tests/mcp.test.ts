import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openXHermesDatabase } from "../src/db.js";
import { handleMcpRequest } from "../src/mcp.js";

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

