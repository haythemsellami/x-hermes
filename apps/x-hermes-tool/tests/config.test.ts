import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoSecretKeys,
  getConfigPath,
  loadConfig,
  saveConfig
} from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("config", () => {
  it("loads defaults when no config exists", async () => {
    const dir = await tempDir();
    const env = { X_HERMES_CONFIG_DIR: dir };

    const loaded = await loadConfig(env);

    expect(loaded.exists).toBe(false);
    expect(loaded.path).toBe(path.join(dir, "config.yaml"));
    expect(loaded.config.xurlApp).toBe("x-hermes");
    expect(loaded.config.postingEnabled).toBe(false);
    expect(loaded.config.posting.enabled).toBe(false);
  });

  it("saves non-secret config with private file permissions intent", async () => {
    const dir = await tempDir();
    const env = { X_HERMES_CONFIG_DIR: dir };
    const config = {
      ...DEFAULT_CONFIG,
      username: "example_user"
    };

    await saveConfig(config, env);

    const raw = await readFile(getConfigPath(env), "utf8");
    expect(raw).toContain("username: example_user");
    expect(raw).toContain("posting:");
    expect(raw).not.toMatch(/clientSecret|accessToken|refreshToken/i);

    const loaded = await loadConfig(env);
    expect(loaded.exists).toBe(true);
    expect(loaded.config.username).toBe("example_user");
  });

  it("loads legacy JSON config and maps flat aliases into nested config", async () => {
    const dir = await tempDir();
    const env = { X_HERMES_CONFIG_DIR: dir };
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        xurlApp: "x-hermes",
        username: "legacy_user",
        postingEnabled: true,
        minimumFollowers: 1234,
        perAuthorCooldownHours: 7,
        activeHours: {
          start: "00:00",
          end: "23:59",
          timezone: "UTC"
        }
      }),
      "utf8"
    );

    const loaded = await loadConfig(env);

    expect(loaded.exists).toBe(true);
    expect(loaded.path).toBe(path.join(dir, "config.json"));
    expect(loaded.config.username).toBe("legacy_user");
    expect(loaded.config.posting.enabled).toBe(true);
    expect(loaded.config.postingEnabled).toBe(true);
    expect(loaded.config.quality.minimumFollowers).toBe(1234);
    expect(loaded.config.posting.perAuthorCooldownHours).toBe(7);
    expect(loaded.config.posting.activeHours.timezone).toBe("UTC");
  });

  it("rejects secret-like keys before writing config", () => {
    expect(() =>
      assertNoSecretKeys({
        ...DEFAULT_CONFIG,
        clientSecret: "do-not-store"
      })
    ).toThrow(/Refusing to store/);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-hermes-config-test-"));
  tempDirs.push(dir);
  return dir;
}
