import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runCampaignsOnce } from "../src/campaigns.js";
import { saveConfig } from "../src/config.js";
import { openXHermesDatabase, type XHermesDatabase } from "../src/db.js";
import { DEFAULT_CONFIG, type XHermesConfig } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("campaign runner", () => {
  it("selects candidates without mutating drafts in dry-run mode", async () => {
    const fixture = await createFixture();
    const db = await openDb(fixture.root);
    await saveConfig(campaignConfig({ dryRun: true }), fixture.env);

    try {
      const summary = await runCampaignsOnce({
        campaignId: "hyperliquid",
        db,
        env: fixture.env,
        output: new MemoryOutput() as unknown as NodeJS.WriteStream,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(summary.campaigns[0]?.results[0]?.action).toBe("dry_run");
      expect(db.getLatestDraftForCandidate("tweet-1")).toBeUndefined();
      await expect(readFile(fixture.xurlLogPath, "utf8")).resolves.not.toContain("-X POST");
    } finally {
      db.close();
    }
  });

  it("queues approval requests when approval is required", async () => {
    const fixture = await createFixture();
    const db = await openDb(fixture.root);
    await saveConfig(campaignConfig({ approvalMode: "required", dryRun: false }), fixture.env);
    const output = new MemoryOutput();

    try {
      const summary = await runCampaignsOnce({
        campaignId: "hyperliquid",
        db,
        env: fixture.env,
        output: output as unknown as NodeJS.WriteStream,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(summary.campaigns[0]?.results[0]?.action).toBe("approval_requested");
      expect(db.listApprovalRequests({ status: "pending" })).toHaveLength(1);
      expect(output.text).toContain("approval_request");
      await expect(readFile(fixture.xurlLogPath, "utf8")).resolves.not.toContain("-X POST");
    } finally {
      db.close();
    }
  });

  it("auto-posts when no approval is configured and guardrails pass", async () => {
    const fixture = await createFixture();
    const db = await openDb(fixture.root);
    await saveConfig(campaignConfig({ approvalMode: "none", dryRun: false }), fixture.env);
    const output = new MemoryOutput();

    try {
      const summary = await runCampaignsOnce({
        campaignId: "hyperliquid",
        db,
        env: fixture.env,
        output: output as unknown as NodeJS.WriteStream,
        now: new Date("2026-06-10T15:00:00.000Z")
      });

      expect(summary.campaigns[0]?.results[0]?.action).toBe("posted");
      expect(db.getCandidate("tweet-1")?.status).toBe("posted");
      expect(db.countPostedRepliesSince("1970-01-01T00:00:00.000Z")).toBe(1);
      expect(output.text).toContain("Posted reply to @alice");
      const log = await readFile(fixture.xurlLogPath, "utf8");
      expect(log).toContain("-X POST /2/tweets -d");
    } finally {
      db.close();
    }
  });
});

class MemoryOutput extends Writable {
  text = "";
  isTTY = false;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

async function openDb(root: string): Promise<XHermesDatabase> {
  return await openXHermesDatabase({ path: path.join(root, "test.sqlite") });
}

function campaignConfig(options: {
  approvalMode?: "required" | "none";
  dryRun: boolean;
}): XHermesConfig {
  return {
    ...DEFAULT_CONFIG,
    username: "xhermes",
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      dryRun: options.dryRun
    },
    posting: {
      ...DEFAULT_CONFIG.posting,
      enabled: true,
      approvalMode: options.approvalMode ?? "required",
      activeHours: {
        start: "00:00",
        end: "23:59",
        timezone: "UTC"
      },
      blockDuplicateReplyText: false,
      requireOptInForAutoPost: false
    },
    campaigns: [
      {
        id: "hyperliquid",
        enabled: true,
        query: "Hyperliquid lang:en -is:retweet",
        replyText: "Hyperliquid",
        fetchLimit: 25,
        postLimit: 1,
        approvalMode: options.approvalMode,
        requireOptInForAutoPost: false
      }
    ]
  };
}

async function createFixture(): Promise<{
  root: string;
  fakeXurlPath: string;
  xurlLogPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "x-hermes-campaigns-test-"));
  tempDirs.push(root);

  const fakeXurlPath = path.join(root, "fake-xurl.mjs");
  const xurlLogPath = path.join(root, "xurl.log");
  await writeFile(xurlLogPath, "", "utf8");
  await writeFile(
    fakeXurlPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_XURL_LOG, args.join(" ") + "\\n");
if (args[0]?.startsWith("/2/tweets/search/recent")) {
  console.log(process.env.FAKE_XURL_SEARCH_OUTPUT);
  process.exit(0);
}
if (args.join(" ") === "auth status") {
  console.log("authenticated");
  process.exit(0);
}
if (args[0] === "-X" && args[1] === "POST" && args[2] === "/2/tweets") {
  console.log(JSON.stringify({ data: { id: "reply-1" } }));
  process.exit(0);
}
if (args[0] === "--help" || args[0] === "whoami") {
  console.log("ok");
  process.exit(0);
}
console.error("unexpected xurl args", args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(fakeXurlPath, 0o700);

  return {
    root,
    fakeXurlPath,
    xurlLogPath,
    env: {
      ...process.env,
      X_HERMES_CONFIG_DIR: path.join(root, "config"),
      X_HERMES_DATA_DIR: path.join(root, "data"),
      X_HERMES_XURL_BIN: fakeXurlPath,
      FAKE_XURL_LOG: xurlLogPath,
      FAKE_XURL_SEARCH_OUTPUT: JSON.stringify(searchOutput())
    }
  };
}

function searchOutput(): unknown {
  return {
    data: [
      {
        id: "tweet-1",
        text: "What do people think about Hyperliquid HIP-4?",
        author_id: "user-1",
        created_at: "2026-06-10T12:00:00.000Z",
        public_metrics: {
          like_count: 10,
          reply_count: 2,
          retweet_count: 1,
          quote_count: 0,
          impression_count: 1000
        },
        possibly_sensitive: false
      }
    ],
    includes: {
      users: [
        {
          id: "user-1",
          username: "alice",
          name: "Alice",
          verified: false,
          created_at: "2020-01-01T00:00:00.000Z",
          public_metrics: {
            followers_count: 2500,
            following_count: 100,
            listed_count: 4
          }
        }
      ]
    }
  };
}
