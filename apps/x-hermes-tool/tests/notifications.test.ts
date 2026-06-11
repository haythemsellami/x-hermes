import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { notify } from "../src/notifications.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("notifications", () => {
  it("delivers post notifications through Hermes send", async () => {
    const root = await tempDir();
    const fakeHermes = path.join(root, "fake-hermes.mjs");
    const logPath = path.join(root, "hermes.log");
    await writeFile(
      fakeHermes,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.HERMES_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
process.exit(0);
`,
      { encoding: "utf8", mode: 0o700 }
    );
    await chmod(fakeHermes, 0o700);

    const results = await notify(
      {
        ...DEFAULT_CONFIG,
        notifications: {
          ...DEFAULT_CONFIG.notifications,
          channels: [
            {
              id: "hermes",
              type: "hermes",
              enabled: true,
              command: fakeHermes,
              target: "telegram",
              events: ["post"]
            }
          ]
        }
      },
      "post",
      {
        title: "Posted reply to @alice",
        message: "Reply: Hyperliquid",
        data: {
          tweetId: "tweet-1",
          replyTweetId: "reply-1"
        }
      },
      {
        env: {
          ...process.env,
          HERMES_LOG: logPath
        }
      }
    );

    expect(results).toEqual([
      {
        channelId: "hermes",
        ok: true,
        message: "Hermes notification sent"
      }
    ]);
    const log = JSON.parse((await readFile(logPath, "utf8")).trim()) as {
      args: string[];
      stdin: string;
    };
    expect(log.args).toEqual([
      "send",
      "--to",
      "telegram",
      "--file",
      "-",
      "--subject",
      "[x-hermes] Posted reply to @alice",
      "--quiet"
    ]);
    expect(log.stdin).toContain("Reply: Hyperliquid");
    expect(log.stdin).toContain("tweetId: tweet-1");
    expect(log.stdin).toContain("replyTweetId: reply-1");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-notifications-test-"));
  tempDirs.push(dir);
  return dir;
}
