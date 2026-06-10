import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { saveConfig } from "../src/config.js";
import { runSetup, collectStatus } from "../src/setup.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { PromptIo } from "../src/prompt.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("setup and status", () => {
  it("reports ready when config exists and fake xurl auth works", async () => {
    const fixture = await createFixture();
    await saveConfig(
      {
        ...DEFAULT_CONFIG,
        username: "tester"
      },
      fixture.env
    );

    const report = await collectStatus({ withHermes: false, mutateStorage: false, env: fixture.env });

    expect(report.ready).toBe(true);
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["platform", "ok"],
      ["node", "ok"],
      ["config", "ok"],
      ["storage", "ok"],
      ["xurl", "ok"],
      ["xurl-auth", "ok"],
      ["xurl-whoami", "ok"]
    ]);
  });

  it("does not create config or data directories in check-only setup", async () => {
    const fixture = await createFixture();
    const output = new MemoryOutput();

    const report = await runSetup(
      {
        checkOnly: true,
        withHermes: false,
        nonInteractive: true,
        json: false
      },
      { input: process.stdin, output: output as unknown as NodeJS.WriteStream },
      fixture.env
    );

    expect(report.ready).toBe(false);
    await expect(stat(fixture.configDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.text).toContain("Check-only mode");
  });

  it("does not prompt or reconfigure when non-interactive setup is already ready", async () => {
    const fixture = await createFixture();
    await saveConfig(
      {
        ...DEFAULT_CONFIG,
        username: "tester"
      },
      fixture.env
    );
    const output = new MemoryOutput();

    const report = await runSetup(
      {
        checkOnly: false,
        withHermes: false,
        nonInteractive: true,
        json: false
      },
      { input: process.stdin, output: output as unknown as NodeJS.WriteStream },
      fixture.env
    );

    expect(report.ready).toBe(true);
    expect(output.text).toContain("x-hermes already looks configured");
    const log = await readFile(fixture.xurlLogPath, "utf8");
    expect(log).not.toContain("auth apps add");
    expect(log).not.toContain("auth oauth2");
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

async function createFixture(): Promise<{
  root: string;
  configDir: string;
  dataDir: string;
  fakeXurlPath: string;
  xurlLogPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "x-hermes-setup-test-"));
  tempDirs.push(root);

  const fakeXurlPath = path.join(root, "fake-xurl.mjs");
  const xurlLogPath = path.join(root, "xurl.log");
  await writeFile(
    fakeXurlPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_XURL_LOG, args.join(" ") + "\\n");
if (args[0] === "--help") {
  console.log("fake xurl help");
  process.exit(0);
}
if (args.join(" ") === "auth status") {
  console.log("authenticated");
  process.exit(0);
}
if (args[0] === "whoami") {
  console.log(JSON.stringify({ data: { username: "tester" } }));
  process.exit(0);
}
if (args.slice(0, 3).join(" ") === "auth apps add") {
  console.log("app added");
  process.exit(0);
}
if (args.slice(0, 2).join(" ") === "auth oauth2") {
  console.log("oauth complete");
  process.exit(0);
}
if (args.slice(0, 2).join(" ") === "auth default") {
  console.log("default set");
  process.exit(0);
}
if (args[0] === "search") {
  console.log("[]");
  process.exit(0);
}
console.error("unexpected xurl args", args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(fakeXurlPath, 0o700);

  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const env = {
    ...process.env,
    X_HERMES_CONFIG_DIR: configDir,
    X_HERMES_DATA_DIR: dataDir,
    X_HERMES_XURL_BIN: fakeXurlPath,
    FAKE_XURL_LOG: xurlLogPath
  };

  return {
    root,
    configDir,
    dataDir,
    fakeXurlPath,
    xurlLogPath,
    env
  };
}

