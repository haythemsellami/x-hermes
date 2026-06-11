import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import {
  DEFAULT_CONFIG,
  type ActiveHours,
  type ApprovalMode,
  type CampaignConfig,
  type LoadedConfig,
  type NotificationChannelConfig,
  type NotificationEvent,
  type NotificationsConfig,
  type PostingConfig,
  type QualityConfig,
  type RuntimeConfig,
  type RuntimeMode,
  type XHermesConfig
} from "./types.js";

const SECRET_KEY_PATTERN = /(secret|token|password|private|credential|apiKey)/i;
const YAML_CONFIG_FILE = "config.yaml";
const LEGACY_JSON_CONFIG_FILE = "config.json";

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
  if (env.X_HERMES_CONFIG_PATH) {
    return env.X_HERMES_CONFIG_PATH;
  }
  return path.join(getConfigDir(env), YAML_CONFIG_FILE);
}

export function getLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), LEGACY_JSON_CONFIG_FILE);
}

export function resolvedDefaultConfig(): XHermesConfig {
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_CONFIG.activeHours.timezone;
  return {
    ...DEFAULT_CONFIG,
    runtime: {
      ...DEFAULT_CONFIG.runtime
    },
    posting: {
      ...DEFAULT_CONFIG.posting,
      activeHours: {
        ...DEFAULT_CONFIG.posting.activeHours,
        timezone
      }
    },
    quality: {
      ...DEFAULT_CONFIG.quality
    },
    notifications: {
      ...DEFAULT_CONFIG.notifications,
      channels: DEFAULT_CONFIG.notifications.channels.map((channel) => ({ ...channel }))
    },
    campaigns: [...DEFAULT_CONFIG.campaigns],
    activeHours: {
      ...DEFAULT_CONFIG.activeHours,
      timezone
    }
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const configPaths = [getConfigPath(env), getLegacyConfigPath(env)].filter(
    (value, index, values) => values.indexOf(value) === index
  );
  const defaults = resolvedDefaultConfig();

  for (const configPath of configPaths) {
    try {
      const raw = await readFile(configPath, "utf8");
      const parsed = parseConfigFile(raw, configPath) as Partial<XHermesConfig>;
      const config = normalizeConfig(defaults, parsed);
      return {
        path: configPath,
        exists: true,
        config
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return {
    path: getConfigPath(env),
    exists: false,
    config: defaults
  };
}

export async function saveConfig(
  config: XHermesConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  assertNoSecretKeys(config);
  const configPath = getConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });

  const tmpPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(`${tmpPath}`, serializeConfig(config), {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tmpPath, configPath);
  return configPath;
}

export function serializeConfig(config: XHermesConfig): string {
  return YAML.stringify(configToFileShape(config), {
    lineWidth: 100,
    sortMapEntries: false
  });
}

export function validateConfig(config: XHermesConfig): string[] {
  const errors: string[] = [];
  if (!config.xurlApp.trim()) {
    errors.push("xurlApp is required.");
  }
  if (!config.username.trim()) {
    errors.push("username is required.");
  }
  if (!["once", "daemon"].includes(config.runtime.mode)) {
    errors.push("runtime.mode must be once or daemon.");
  }
  positiveInteger(errors, "runtime.scanIntervalMinutes", config.runtime.scanIntervalMinutes, 1, 24 * 60);
  positiveInteger(errors, "posting.maxRepliesPerDay", config.posting.maxRepliesPerDay, 1, 10_000);
  positiveInteger(errors, "posting.maxRepliesPerRun", config.posting.maxRepliesPerRun, 1, 500);
  positiveInteger(errors, "quality.minimumFollowers", config.quality.minimumFollowers, 0, 100_000_000);
  positiveInteger(errors, "quality.minimumAccountAgeDays", config.quality.minimumAccountAgeDays, 0, 100_000);
  positiveInteger(errors, "posting.perAuthorCooldownHours", config.posting.perAuthorCooldownHours, 0, 100_000);
  validateActiveHours(errors, "posting.activeHours", config.posting.activeHours);

  const ids = new Set<string>();
  for (const campaign of config.campaigns) {
    if (!campaign.id.trim()) {
      errors.push("campaigns[].id is required.");
    }
    if (ids.has(campaign.id)) {
      errors.push(`campaign id is duplicated: ${campaign.id}`);
    }
    ids.add(campaign.id);
    if (!campaign.query.trim()) {
      errors.push(`campaign ${campaign.id}: query is required.`);
    }
    if (!campaign.replyText.trim()) {
      errors.push(`campaign ${campaign.id}: replyText is required.`);
    }
    positiveInteger(errors, `campaign ${campaign.id}: fetchLimit`, campaign.fetchLimit, 10, 100);
    positiveInteger(errors, `campaign ${campaign.id}: postLimit`, campaign.postLimit, 1, 100);
  }

  return errors;
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

export function parseConfigFile(raw: string, configPath: string): Partial<XHermesConfig> {
  const parsed = configPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain an object: ${configPath}`);
  }
  return parsed as Partial<XHermesConfig>;
}

export function normalizeConfig(
  defaults: XHermesConfig,
  parsed: Partial<XHermesConfig>
): XHermesConfig {
  const source = isRecord(parsed) ? parsed : {};
  const parsedRuntime = recordValue(source.runtime);
  const parsedPosting = recordValue(source.posting);
  const parsedQuality = recordValue(source.quality);
  const parsedNotifications = recordValue(source.notifications);

  const runtime: RuntimeConfig = {
    mode: runtimeModeValue(parsedRuntime.mode, defaults.runtime.mode),
    scanIntervalMinutes: numberValue(
      parsedRuntime.scanIntervalMinutes,
      defaults.runtime.scanIntervalMinutes
    ),
    dryRun: booleanValue(parsedRuntime.dryRun, defaults.runtime.dryRun)
  };

  const posting: PostingConfig = {
    enabled: booleanValue(parsedPosting.enabled, defaults.posting.enabled),
    approvalMode: approvalModeValue(parsedPosting.approvalMode, defaults.posting.approvalMode),
    maxRepliesPerDay: numberValue(
      parsedPosting.maxRepliesPerDay,
      defaults.posting.maxRepliesPerDay
    ),
    maxRepliesPerRun: numberValue(parsedPosting.maxRepliesPerRun, defaults.posting.maxRepliesPerRun),
    activeHours: activeHoursValue(
      recordValue(parsedPosting.activeHours),
      defaults.posting.activeHours
    ),
    perAuthorCooldownHours: numberValue(
      parsedPosting.perAuthorCooldownHours,
      defaults.posting.perAuthorCooldownHours
    ),
    blockDuplicateReplyText: booleanValue(
      parsedPosting.blockDuplicateReplyText,
      defaults.posting.blockDuplicateReplyText
    ),
    requireOptInForAutoPost: booleanValue(
      parsedPosting.requireOptInForAutoPost,
      defaults.posting.requireOptInForAutoPost
    )
  };

  const quality: QualityConfig = {
    minimumFollowers: numberValue(parsedQuality.minimumFollowers, defaults.quality.minimumFollowers),
    minimumAccountAgeDays: numberValue(
      parsedQuality.minimumAccountAgeDays,
      defaults.quality.minimumAccountAgeDays
    ),
    skipSensitive: booleanValue(parsedQuality.skipSensitive, defaults.quality.skipSensitive),
    skipScamLanguage: booleanValue(parsedQuality.skipScamLanguage, defaults.quality.skipScamLanguage),
    useFeedbackSignals: booleanValue(
      parsedQuality.useFeedbackSignals,
      defaults.quality.useFeedbackSignals
    )
  };

  const notifications: NotificationsConfig = {
    onPost: booleanValue(parsedNotifications.onPost, defaults.notifications.onPost),
    onError: booleanValue(parsedNotifications.onError, defaults.notifications.onError),
    onApprovalRequest: booleanValue(
      parsedNotifications.onApprovalRequest,
      defaults.notifications.onApprovalRequest
    ),
    channels: normalizeNotificationChannels(parsedNotifications.channels, defaults.notifications.channels)
  };

  applyLegacyAliases(source, posting, quality, defaults);

  const config: XHermesConfig = {
    ...defaults,
    xurlApp: stringValue(source.xurlApp, defaults.xurlApp),
    username: stringValue(source.username, defaults.username),
    runtime,
    posting,
    quality,
    notifications,
    campaigns: normalizeCampaigns(source.campaigns, defaults),
    replyTextDefault: stringValue(source.replyTextDefault, defaults.replyTextDefault),
    requireApprovalForKeywordSearch: booleanValue(
      source.requireApprovalForKeywordSearch,
      posting.approvalMode !== "none"
    ),
    activeHours: posting.activeHours,
    maxRepliesPerDay: posting.maxRepliesPerDay,
    postingEnabled: posting.enabled,
    minimumFollowers: quality.minimumFollowers,
    minimumAccountAgeDays: quality.minimumAccountAgeDays,
    perAuthorCooldownHours: posting.perAuthorCooldownHours,
    blockDuplicateReplyText: posting.blockDuplicateReplyText,
    requireOptInForAutoPost: posting.requireOptInForAutoPost
  };

  return config;
}

export function configToFileShape(config: XHermesConfig): Record<string, unknown> {
  const normalized = normalizeConfig(resolvedDefaultConfig(), config);
  return {
    xurlApp: normalized.xurlApp,
    username: normalized.username,
    runtime: normalized.runtime,
    posting: normalized.posting,
    quality: normalized.quality,
    notifications: normalized.notifications,
    campaigns: normalized.campaigns
  };
}

function applyLegacyAliases(
  source: Record<string, unknown>,
  posting: PostingConfig,
  quality: QualityConfig,
  defaults: XHermesConfig
): void {
  if (shouldUseLegacyAlias(source, "posting", "enabled", "postingEnabled", defaults.posting.enabled)) {
    posting.enabled = booleanValue(source.postingEnabled, posting.enabled);
  }
  if (
    shouldUseLegacyAlias(
      source,
      "posting",
      "maxRepliesPerDay",
      "maxRepliesPerDay",
      defaults.posting.maxRepliesPerDay
    )
  ) {
    posting.maxRepliesPerDay = numberValue(source.maxRepliesPerDay, posting.maxRepliesPerDay);
  }
  if (
    shouldUseLegacyAlias(
      source,
      "posting",
      "activeHours",
      "activeHours",
      defaults.posting.activeHours
    )
  ) {
    posting.activeHours = activeHoursValue(recordValue(source.activeHours), posting.activeHours);
  }
  if (
    shouldUseLegacyAlias(
      source,
      "posting",
      "perAuthorCooldownHours",
      "perAuthorCooldownHours",
      defaults.posting.perAuthorCooldownHours
    )
  ) {
    posting.perAuthorCooldownHours = numberValue(
      source.perAuthorCooldownHours,
      posting.perAuthorCooldownHours
    );
  }
  if (
    shouldUseLegacyAlias(
      source,
      "posting",
      "blockDuplicateReplyText",
      "blockDuplicateReplyText",
      defaults.posting.blockDuplicateReplyText
    )
  ) {
    posting.blockDuplicateReplyText = booleanValue(
      source.blockDuplicateReplyText,
      posting.blockDuplicateReplyText
    );
  }
  if (
    shouldUseLegacyAlias(
      source,
      "posting",
      "requireOptInForAutoPost",
      "requireOptInForAutoPost",
      defaults.posting.requireOptInForAutoPost
    )
  ) {
    posting.requireOptInForAutoPost = booleanValue(
      source.requireOptInForAutoPost,
      posting.requireOptInForAutoPost
    );
  }
  if (
    shouldUseLegacyAlias(
      source,
      "quality",
      "minimumFollowers",
      "minimumFollowers",
      defaults.quality.minimumFollowers
    )
  ) {
    quality.minimumFollowers = numberValue(source.minimumFollowers, quality.minimumFollowers);
  }
  if (
    shouldUseLegacyAlias(
      source,
      "quality",
      "minimumAccountAgeDays",
      "minimumAccountAgeDays",
      defaults.quality.minimumAccountAgeDays
    )
  ) {
    quality.minimumAccountAgeDays = numberValue(
      source.minimumAccountAgeDays,
      quality.minimumAccountAgeDays
    );
  }
}

function shouldUseLegacyAlias(
  source: Record<string, unknown>,
  blockName: "posting" | "quality",
  nestedKey: string,
  legacyKey: string,
  defaultValue: unknown
): boolean {
  if (!(legacyKey in source)) {
    return false;
  }
  const block = recordValue(source[blockName]);
  if (!(nestedKey in block)) {
    return true;
  }
  return deepEqual(block[nestedKey], defaultValue);
}

function normalizeCampaigns(value: unknown, defaults: XHermesConfig): CampaignConfig[] {
  if (!Array.isArray(value)) {
    return defaults.campaigns.map((campaign) => ({ ...campaign }));
  }
  return value.map((item) => {
    const source = recordValue(item);
    const campaign: CampaignConfig = {
      id: stringValue(source.id, ""),
      enabled: booleanValue(source.enabled, true),
      query: stringValue(source.query, ""),
      replyText: stringValue(source.replyText, defaults.replyTextDefault),
      fetchLimit: numberValue(source.fetchLimit, 25),
      postLimit: numberValue(source.postLimit, defaults.posting.maxRepliesPerRun)
    };
    if ("approvalMode" in source) {
      campaign.approvalMode = approvalModeValue(source.approvalMode, defaults.posting.approvalMode);
    }
    if ("dryRun" in source) {
      campaign.dryRun = booleanValue(source.dryRun, defaults.runtime.dryRun);
    }
    if ("requireOptInForAutoPost" in source) {
      campaign.requireOptInForAutoPost = booleanValue(
        source.requireOptInForAutoPost,
        defaults.posting.requireOptInForAutoPost
      );
    }
    return campaign;
  });
}

function normalizeNotificationChannels(
  value: unknown,
  defaults: NotificationChannelConfig[]
): NotificationChannelConfig[] {
  if (!Array.isArray(value)) {
    return defaults.map((channel) => ({ ...channel }));
  }
  return value.map((item) => {
    const source = recordValue(item);
    const channel: NotificationChannelConfig = {
      id: stringValue(source.id, ""),
      type: source.type === "command" ? "command" : "stdout",
      enabled: booleanValue(source.enabled, true)
    };
    if ("command" in source) {
      channel.command = stringValue(source.command, "");
    }
    if (Array.isArray(source.args)) {
      channel.args = source.args.map((arg) => String(arg));
    }
    if (Array.isArray(source.events)) {
      channel.events = source.events.filter(isNotificationEvent);
    }
    return channel;
  });
}

function positiveInteger(
  errors: string[],
  name: string,
  value: unknown,
  minimum: number,
  maximum: number
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    errors.push(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function validateActiveHours(errors: string[], name: string, value: ActiveHours): void {
  if (!isClock(value.start)) {
    errors.push(`${name}.start must use HH:MM 24-hour time.`);
  }
  if (!isClock(value.end)) {
    errors.push(`${name}.end must use HH:MM 24-hour time.`);
  }
  if (typeof value.timezone !== "string" || !value.timezone.trim()) {
    errors.push(`${name}.timezone is required.`);
  }
}

function activeHoursValue(source: Record<string, unknown>, defaults: ActiveHours): ActiveHours {
  return {
    start: stringValue(source.start, defaults.start),
    end: stringValue(source.end, defaults.end),
    timezone: stringValue(source.timezone, defaults.timezone)
  };
}

function runtimeModeValue(value: unknown, fallback: RuntimeMode): RuntimeMode {
  return value === "once" || value === "daemon" ? value : typeof value === "string" ? (value as RuntimeMode) : fallback;
}

function approvalModeValue(value: unknown, fallback: ApprovalMode): ApprovalMode {
  return value === "required" || value === "none" || value === "opt_in_auto_post"
    ? value
    : typeof value === "string"
      ? (value as ApprovalMode)
      : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isClock(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isNotificationEvent(value: unknown): value is NotificationEvent {
  return value === "post" || value === "error" || value === "approval_request";
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
