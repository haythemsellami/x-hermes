import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, type LoadedConfig, type XHermesConfig } from "./types.js";

const SECRET_KEY_PATTERN = /(secret|token|password|private|credential|apiKey)/i;

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.X_HERMES_CONFIG_DIR) {
    return env.X_HERMES_CONFIG_DIR;
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "x-hermes");
  }
  return path.join(os.homedir(), ".config", "x-hermes");
}

export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.X_HERMES_DATA_DIR) {
    return env.X_HERMES_DATA_DIR;
  }
  if (env.XDG_DATA_HOME) {
    return path.join(env.XDG_DATA_HOME, "x-hermes");
  }
  return path.join(os.homedir(), ".local", "share", "x-hermes");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "config.json");
}

export function resolvedDefaultConfig(): XHermesConfig {
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_CONFIG.activeHours.timezone;
  return {
    ...DEFAULT_CONFIG,
    activeHours: {
      ...DEFAULT_CONFIG.activeHours,
      timezone
    }
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const configPath = getConfigPath(env);
  const defaults = resolvedDefaultConfig();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<XHermesConfig>;
    return {
      path: configPath,
      exists: true,
      config: mergeConfig(defaults, parsed)
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        path: configPath,
        exists: false,
        config: defaults
      };
    }
    throw error;
  }
}

export async function saveConfig(
  config: XHermesConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  assertNoSecretKeys(config);
  const configPath = getConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });

  const tmpPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(`${tmpPath}`, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tmpPath, configPath);
  return configPath;
}

export async function checkWritableDir(
  dir: string,
  options: { mutate: boolean }
): Promise<{ ok: boolean; created: boolean; message: string }> {
  if (options.mutate) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const testPath = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    await writeFile(testPath, "ok", { encoding: "utf8", mode: 0o600 });
    await unlink(testPath);
    return {
      ok: true,
      created: true,
      message: "Storage directory is writable."
    };
  }

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return {
        ok: false,
        created: false,
        message: "Storage path exists but is not a directory."
      };
    }
    await access(dir, constants.W_OK);
    return {
      ok: true,
      created: false,
      message: "Storage directory exists and is writable."
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      try {
        const ancestor = await nearestExistingAncestor(dir);
        await access(ancestor, constants.W_OK);
        return {
          ok: true,
          created: false,
          message: "Storage directory is missing, but setup can create it."
        };
      } catch {
        return {
          ok: false,
          created: false,
          message: "Storage directory is missing and the parent directory is not writable."
        };
      }
    }
    return {
      ok: false,
      created: false,
      message: error instanceof Error ? error.message : "Storage path is not writable."
    };
  }
}

export function assertNoSecretKeys(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, [...pathParts, String(index)]));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to store secret-like config key: ${nextPath.join(".")}`);
    }
    assertNoSecretKeys(child, nextPath);
  }
}

function mergeConfig(defaults: XHermesConfig, parsed: Partial<XHermesConfig>): XHermesConfig {
  return {
    ...defaults,
    ...parsed,
    activeHours: {
      ...defaults.activeHours,
      ...(parsed.activeHours ?? {})
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) {
        return current;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    current = path.dirname(current);
  }
  return current;
}
