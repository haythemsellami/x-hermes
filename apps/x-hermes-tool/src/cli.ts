#!/usr/bin/env node
import { collectStatus, printStatusReport, runSetup } from "./setup.js";
import {
  getConfigPath,
  loadConfig,
  normalizeConfig,
  resolvedDefaultConfig,
  saveConfig,
  serializeConfig,
  validateConfig
} from "./config.js";
import type {
  ApprovalMode,
  ApprovalRequestStatus,
  CampaignConfig,
  CandidateStatus,
  SetupOptions,
  XHermesConfig
} from "./types.js";

const VERSION = "0.1.0";

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (hasFlag(parsed, "--version") || parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (hasFlag(parsed, "--help") || parsed.command === "help") {
    printHelp();
    return 0;
  }

  switch (parsed.command) {
    case "setup": {
      const options: SetupOptions = {
        checkOnly: hasFlag(parsed, "--check-only"),
        withHermes: hasFlag(parsed, "--with-hermes"),
        nonInteractive: hasFlag(parsed, "--non-interactive"),
        json: hasFlag(parsed, "--json")
      };
      const report = await runSetup(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      return report.ready ? 0 : 1;
    }

    case "status": {
      const report = await collectStatus({
        withHermes: hasFlag(parsed, "--with-hermes"),
        mutateStorage: false
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printStatusReport("x-hermes status", report, {
          input: process.stdin,
          output: process.stdout
        });
      }
      return report.ready ? 0 : 1;
    }

    case "doctor": {
      const report = await collectStatus({
        withHermes: hasFlag(parsed, "--with-hermes"),
        mutateStorage: false
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printStatusReport("x-hermes doctor", report, {
          input: process.stdin,
          output: process.stdout
        });
      }
      return report.ready ? 0 : 1;
    }

    case "mcp": {
      const { startMcpServer } = await import("./mcp.js");
      await startMcpServer();
      return 0;
    }

    case "config":
      return await runConfigCommand(parsed);

    case "campaigns":
      return await runCampaignsCommand(parsed);

    case "run":
      return await runRunCommand(parsed);

    case "service":
      return await runServiceCommand(parsed);

    case "watch-queries":
      return await runWatchQueryCommand(parsed);

    case "scan":
      return await runScanCommand(parsed);

    case "candidates":
      return await runCandidatesCommand(parsed);

    case "draft":
      return await runDraftCommand(parsed);

    case "approve":
      return await runApproveCommand(parsed);

    case "reject":
      return await runRejectCommand(parsed);

    case "approvals":
      return await runApprovalsCommand(parsed);

    case "feedback":
      return await runFeedbackCommand(parsed);

    case "opt-out":
      return await runOptOutCommand(parsed);

    case "post-approved":
      return await runPostApprovedCommand(parsed);

    case "stats":
      return await runStatsCommand(parsed);

    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
      printHelp();
      return 2;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inlineValue] = arg.split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(arg);
  }

  const command = positionals[0] ?? "help";
  const subcommand = positionals[1];
  return {
    command,
    subcommand,
    positionals: positionals.slice(2),
    flags
  };
}

function printHelp(): void {
  process.stdout.write(`x-hermes ${VERSION}

Usage:
  x-hermes setup [--check-only] [--with-hermes] [--non-interactive] [--json]
  x-hermes status [--with-hermes] [--json]
  x-hermes doctor [--with-hermes] [--json]
  x-hermes config init [--force]
  x-hermes config show [--json]
  x-hermes config validate
  x-hermes config set <path> <value>
  x-hermes campaigns add <id> --query <query> --reply-text <text> [--limit 10]
  x-hermes campaigns list [--json]
  x-hermes campaigns show <id> [--json]
  x-hermes campaigns run <id> [--json]
  x-hermes run [--once] [--campaign <id>] [--json]
  x-hermes service install [--enable]
  x-hermes service status [--json]
  x-hermes service logs
  x-hermes service uninstall
  x-hermes watch-queries add <name> --query <query>
  x-hermes watch-queries list [--json]
  x-hermes scan [--query <query> | --watch <id>] [--limit 25] [--json]
  x-hermes candidates list [--status <status>] [--limit 50] [--json]
  x-hermes candidates show <tweet-id> [--json]
  x-hermes draft <tweet-id> --text <reply> [--by <actor>]
  x-hermes approve <tweet-id> --by <actor> [--reason <reason>]
  x-hermes reject <tweet-id> [--by <actor>] [--reason <reason>]
  x-hermes approvals list [--status pending] [--limit 50] [--json]
  x-hermes approvals show <request-id> [--json]
  x-hermes approvals message <request-id>
  x-hermes approvals approve <request-id> [--by <actor>] [--reason <reason>]
  x-hermes approvals reject <request-id> [--by <actor>] [--reason <reason>]
  x-hermes approvals edit <request-id> --text <reply> [--by <actor>]
  x-hermes approvals respond <request-id> --message <message> [--by <actor>] [--json]
  x-hermes approvals deliver <request-id> --status sent [--channel <name>] [--recipient <id>] [--external-id <id>]
  x-hermes feedback profile [--json]
  x-hermes feedback examples [--decision approved|rejected] [--limit 50] [--json]
  x-hermes post-approved <tweet-id> [--by <actor>] [--json]
  x-hermes opt-out add <username> [--by <actor>] [--reason <reason>]
  x-hermes stats [--json]
  x-hermes mcp

Setup collects X OAuth secrets only through local terminal prompts.
`);
}

async function runConfigCommand(parsed: ParsedArgs): Promise<number> {
  switch (parsed.subcommand) {
    case "init": {
      const loaded = await loadConfig();
      const target = getConfigPath();
      if (loaded.exists && loaded.path === target && !hasFlag(parsed, "--force")) {
        process.stdout.write(`Config already exists at ${target}\n`);
        return 0;
      }
      const savedPath = await saveConfig(loaded.config);
      process.stdout.write(`Wrote config to ${savedPath}\n`);
      return 0;
    }

    case "path": {
      process.stdout.write(`${getConfigPath()}\n`);
      return 0;
    }

    case "show": {
      const loaded = await loadConfig();
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
      } else {
        process.stdout.write(serializeConfig(loaded.config));
      }
      return 0;
    }

    case "validate": {
      const loaded = await loadConfig();
      const errors = validateConfig(loaded.config);
      if (errors.length === 0) {
        process.stdout.write(`Config is valid: ${loaded.path}\n`);
        return 0;
      }
      process.stderr.write(`Config has ${errors.length} issue(s):\n`);
      for (const error of errors) {
        process.stderr.write(`  - ${error}\n`);
      }
      return 1;
    }

    case "set": {
      const keyPath = parsed.positionals[0];
      const rawValue = parsed.positionals.slice(1).join(" ");
      if (!keyPath || rawValue.length === 0) {
        process.stderr.write("Usage: x-hermes config set <path> <value>\n");
        return 2;
      }
      const loaded = await loadConfig();
      const beforeErrors = new Set(validateConfig(loaded.config));
      const next = structuredClone(loaded.config) as XHermesConfig;
      setConfigValue(next as unknown as Record<string, unknown>, keyPath, parseConfigValue(rawValue));
      const normalized = normalizeConfig(resolvedDefaultConfig(), next);
      const afterErrors = validateConfig(normalized);
      const newErrors = afterErrors.filter((error) => !beforeErrors.has(error));
      if (newErrors.length > 0) {
        process.stderr.write("Refusing to save invalid config change:\n");
        for (const error of newErrors) {
          process.stderr.write(`  - ${error}\n`);
        }
        return 1;
      }
      const savedPath = await saveConfig(normalized);
      process.stdout.write(`Updated ${keyPath} in ${savedPath}\n`);
      if (afterErrors.length > 0) {
        process.stderr.write("Config still needs attention:\n");
        for (const error of afterErrors) {
          process.stderr.write(`  - ${error}\n`);
        }
      }
      return 0;
    }

    default:
      process.stderr.write("Usage: x-hermes config <init|path|show|validate|set>\n");
      return 2;
  }
}

async function runCampaignsCommand(parsed: ParsedArgs): Promise<number> {
  switch (parsed.subcommand) {
    case "add": {
      const id = parsed.positionals[0];
      const query = getStringFlag(parsed, "--query");
      const replyText = getStringFlag(parsed, "--reply-text") ?? getStringFlag(parsed, "--text");
      if (!id || !query || !replyText) {
        process.stderr.write(
          "Usage: x-hermes campaigns add <id> --query <query> --reply-text <text> [--limit 10]\n"
        );
        return 2;
      }

      const loaded = await loadConfig();
      const beforeErrors = new Set(validateConfig(loaded.config));
      const next = structuredClone(loaded.config) as XHermesConfig;
      const existingIndex = next.campaigns.findIndex((campaign) => campaign.id === id);
      if (existingIndex >= 0 && !hasFlag(parsed, "--force")) {
        process.stderr.write(`Campaign already exists: ${id}. Use --force to replace it.\n`);
        return 1;
      }
      const postLimit = getNumberFlag(parsed, "--post-limit", getNumberFlag(parsed, "--limit", 10));
      const campaign: CampaignConfig = {
        id,
        enabled: getBooleanFlag(parsed, "--enabled", true),
        query,
        replyText,
        fetchLimit: getNumberFlag(parsed, "--fetch-limit", 25),
        postLimit,
        approvalMode: getApprovalMode(parsed),
        dryRun: getOptionalBooleanFlag(parsed, "--dry-run"),
        requireOptInForAutoPost: hasFlag(parsed, "--allow-cold-replies")
          ? false
          : getOptionalBooleanFlag(parsed, "--require-opt-in")
      };
      if (campaign.approvalMode === undefined) {
        delete campaign.approvalMode;
      }
      if (campaign.dryRun === undefined) {
        delete campaign.dryRun;
      }
      if (campaign.requireOptInForAutoPost === undefined) {
        delete campaign.requireOptInForAutoPost;
      }

      if (existingIndex >= 0) {
        next.campaigns[existingIndex] = campaign;
      } else {
        next.campaigns.push(campaign);
      }
      const normalized = normalizeConfig(resolvedDefaultConfig(), next);
      const errors = validateConfig(normalized);
      const newErrors = errors.filter((error) => !beforeErrors.has(error));
      if (newErrors.length > 0) {
        process.stderr.write("Campaign config is invalid:\n");
        for (const error of newErrors) {
          process.stderr.write(`  - ${error}\n`);
        }
        return 1;
      }
      const savedPath = await saveConfig(normalized);
      process.stdout.write(`Saved campaign ${id} to ${savedPath}\n`);
      if (errors.length > 0) {
        process.stderr.write("Config still needs attention:\n");
        for (const error of errors) {
          process.stderr.write(`  - ${error}\n`);
        }
      }
      return 0;
    }

    case "list": {
      const loaded = await loadConfig();
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(loaded.config.campaigns, null, 2)}\n`);
        return 0;
      }
      if (loaded.config.campaigns.length === 0) {
        process.stdout.write("No campaigns configured.\n");
        return 0;
      }
      for (const campaign of loaded.config.campaigns) {
        const state = campaign.enabled ? "enabled" : "disabled";
        process.stdout.write(
          `${campaign.id}\t${state}\tfetch=${campaign.fetchLimit}\tpost=${campaign.postLimit}\t${campaign.query}\n`
        );
      }
      return 0;
    }

    case "show": {
      const id = parsed.positionals[0];
      if (!id) {
        process.stderr.write("Usage: x-hermes campaigns show <id> [--json]\n");
        return 2;
      }
      const loaded = await loadConfig();
      const campaign = loaded.config.campaigns.find((item) => item.id === id);
      if (!campaign) {
        process.stderr.write(`Campaign not found: ${id}\n`);
        return 1;
      }
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(campaign, null, 2)}\n`);
      } else {
        process.stdout.write(serializeConfig({ ...loaded.config, campaigns: [campaign] }));
      }
      return 0;
    }

    case "run": {
      const campaignId = parsed.positionals[0];
      const { runCampaignsOnce } = await import("./campaigns.js");
      const summary = await runCampaignsOnce({
        campaignId,
        output: hasFlag(parsed, "--json") ? process.stderr : process.stdout
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        printCampaignRunSummary(summary);
      }
      return hasCampaignFailures(summary) ? 1 : 0;
    }

    default:
      process.stderr.write("Usage: x-hermes campaigns <add|list|show|run>\n");
      return 2;
  }
}

async function runRunCommand(parsed: ParsedArgs): Promise<number> {
  const campaignId = getStringFlag(parsed, "--campaign");
  const loaded = await loadConfig();
  const runOnce = hasFlag(parsed, "--once") || loaded.config.runtime.mode === "once";
  if (runOnce) {
    const { runCampaignsOnce } = await import("./campaigns.js");
    const summary = await runCampaignsOnce({
      campaignId,
      output: hasFlag(parsed, "--json") ? process.stderr : process.stdout
    });
    if (hasFlag(parsed, "--json")) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printCampaignRunSummary(summary);
    }
    return hasCampaignFailures(summary) ? 1 : 0;
  }

  const { runCampaignDaemon } = await import("./campaigns.js");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  process.stdout.write(
    `x-hermes is running. Scan interval: ${loaded.config.runtime.scanIntervalMinutes} minute(s).\n`
  );
  await runCampaignDaemon({
    campaignId,
    output: hasFlag(parsed, "--json") ? process.stderr : process.stdout,
    signal: controller.signal
  });
  return 0;
}

async function runServiceCommand(parsed: ParsedArgs): Promise<number> {
  const { getServiceInfo, installService, uninstallService } = await import("./service.js");
  switch (parsed.subcommand) {
    case "install": {
      const info = await installService({ enable: hasFlag(parsed, "--enable") });
      process.stdout.write(`Wrote ${info.manager} service: ${info.path}\n`);
      if (info.enabled) {
        process.stdout.write("Service enabled and started.\n");
      } else if (info.installCommands.length > 0) {
        process.stdout.write("To enable it, run:\n");
        for (const command of info.installCommands) {
          process.stdout.write(`  ${command}\n`);
        }
      }
      if (info.logCommand) {
        process.stdout.write(`Logs: ${info.logCommand}\n`);
      }
      if (info.enableOutput?.trim()) {
        process.stdout.write(`${info.enableOutput.trim()}\n`);
      }
      return info.enabled || !hasFlag(parsed, "--enable") ? 0 : 1;
    }

    case "status": {
      const info = await getServiceInfo();
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`Manager: ${info.manager}\n`);
      process.stdout.write(`Path: ${info.path || "unsupported"}\n`);
      process.stdout.write(`Installed: ${info.exists ? "yes" : "no"}\n`);
      if (info.installCommands.length > 0) {
        process.stdout.write("Enable commands:\n");
        for (const command of info.installCommands) {
          process.stdout.write(`  ${command}\n`);
        }
      }
      if (info.logCommand) {
        process.stdout.write(`Logs: ${info.logCommand}\n`);
      }
      return info.manager === "unsupported" ? 1 : 0;
    }

    case "logs": {
      const info = await getServiceInfo();
      if (!info.logCommand) {
        process.stderr.write("No service log command is available for this platform.\n");
        return 1;
      }
      process.stdout.write(`${info.logCommand}\n`);
      return 0;
    }

    case "uninstall": {
      const info = await uninstallService();
      process.stdout.write(`Removed service file: ${info.path || "unsupported"}\n`);
      return 0;
    }

    default:
      process.stderr.write("Usage: x-hermes service <install|status|logs|uninstall>\n");
      return 2;
  }
}

async function runWatchQueryCommand(parsed: ParsedArgs): Promise<number> {
  const { openXHermesDatabase } = await import("./db.js");
  const db = await openXHermesDatabase();
  try {
    switch (parsed.subcommand) {
      case "add": {
        const name = parsed.positionals[0];
        const query = getStringFlag(parsed, "--query");
        if (!name || !query) {
          process.stderr.write("Usage: x-hermes watch-queries add <name> --query <query>\n");
          return 2;
        }
        const saved = db.upsertWatchQuery({ name, query });
        db.recordAuditEvent({
          eventType: "watch_query.created",
          actor: "cli",
          entityType: "watch_query",
          entityId: saved.id,
          details: { name: saved.name, query: saved.query }
        });
        process.stdout.write(`Added watch query ${saved.id}: ${saved.name}\n`);
        return 0;
      }

      case "list": {
        const queries = db.listWatchQueries();
        if (hasFlag(parsed, "--json")) {
          process.stdout.write(`${JSON.stringify(queries, null, 2)}\n`);
        } else if (queries.length === 0) {
          process.stdout.write("No watch queries configured.\n");
        } else {
          for (const query of queries) {
            const state = query.enabled ? "enabled" : "disabled";
            process.stdout.write(`${query.id}\t${state}\t${query.name}\t${query.query}\n`);
          }
        }
        return 0;
      }

      default:
        process.stderr.write("Usage: x-hermes watch-queries <add|list>\n");
        return 2;
    }
  } finally {
    db.close();
  }
}

async function runScanCommand(parsed: ParsedArgs): Promise<number> {
  const { scanRecentPosts } = await import("./scanner.js");
  const summary = await scanRecentPosts({
    query: getStringFlag(parsed, "--query"),
    watchQueryId: getStringFlag(parsed, "--watch"),
    limit: getNumberFlag(parsed, "--limit", 25)
  });

  if (hasFlag(parsed, "--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  for (const run of summary.runs) {
    process.stdout.write(
      `Scanned "${run.query}": found ${run.foundCount}, new ${run.storedCount}\n`
    );
    for (const candidate of run.candidates) {
      process.stdout.write(
        `  ${candidate.tweetId}\t${candidate.status}\t${candidate.score}\t@${candidate.authorUsername}\t${truncate(candidate.text, 100)}\n`
      );
    }
  }

  return 0;
}

async function runCandidatesCommand(parsed: ParsedArgs): Promise<number> {
  const { getCandidateDetails, listCandidates } = await import("./queue.js");
  switch (parsed.subcommand) {
    case "list": {
      const candidates = await listCandidates({
        status: getStringFlag(parsed, "--status") as CandidateStatus | undefined,
        limit: getNumberFlag(parsed, "--limit", 50)
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
        return 0;
      }
      for (const candidate of candidates) {
        process.stdout.write(
          `${candidate.tweetId}\t${candidate.status}\t${candidate.score}\t@${candidate.authorUsername}\t${truncate(candidate.text, 120)}\n`
        );
      }
      return 0;
    }

    case "show": {
      const tweetId = parsed.positionals[0];
      if (!tweetId) {
        process.stderr.write("Usage: x-hermes candidates show <tweet-id>\n");
        return 2;
      }
      const details = await getCandidateDetails({ tweetId });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
        return 0;
      }
      printCandidateDetails(details);
      return 0;
    }

    default:
      process.stderr.write("Usage: x-hermes candidates <list|show>\n");
      return 2;
  }
}

async function runDraftCommand(parsed: ParsedArgs): Promise<number> {
  const tweetId = parsed.subcommand;
  const text = getStringFlag(parsed, "--text");
  const draftedBy = getStringFlag(parsed, "--by") ?? "cli";
  if (!tweetId || !text) {
    process.stderr.write("Usage: x-hermes draft <tweet-id> --text <reply> [--by <actor>]\n");
    return 2;
  }
  const { queueReplyDraft } = await import("./queue.js");
  const draft = await queueReplyDraft({ tweetId, text, draftedBy });
  process.stdout.write(`Queued draft ${draft.id} for ${tweetId}\n`);
  return 0;
}

async function runApproveCommand(parsed: ParsedArgs): Promise<number> {
  const tweetId = parsed.subcommand;
  const approvedBy = getStringFlag(parsed, "--by");
  if (!tweetId || !approvedBy) {
    process.stderr.write("Usage: x-hermes approve <tweet-id> --by <actor> [--reason <reason>]\n");
    return 2;
  }
  const { approveCandidate } = await import("./queue.js");
  const draft = await approveCandidate({
    tweetId,
    approvedBy,
    reason: getStringFlag(parsed, "--reason")
  });
  process.stdout.write(`Approved ${tweetId} with draft ${draft.id}\n`);
  return 0;
}

async function runRejectCommand(parsed: ParsedArgs): Promise<number> {
  const tweetId = parsed.subcommand;
  if (!tweetId) {
    process.stderr.write("Usage: x-hermes reject <tweet-id> [--by <actor>] [--reason <reason>]\n");
    return 2;
  }
  const { rejectCandidate } = await import("./queue.js");
  await rejectCandidate({
    tweetId,
    actor: getStringFlag(parsed, "--by") ?? "cli",
    reason: getStringFlag(parsed, "--reason")
  });
  process.stdout.write(`Rejected ${tweetId}\n`);
  return 0;
}

async function runApprovalsCommand(parsed: ParsedArgs): Promise<number> {
  const {
    approveApprovalRequest,
    editApprovalRequestDraft,
    getApprovalRequestDetails,
    listApprovalRequests,
    processApprovalResponse,
    recordApprovalDelivery,
    rejectApprovalRequest,
    renderApprovalRequestMessage
  } = await import("./approvals.js");

  switch (parsed.subcommand) {
    case "list": {
      const requests = await listApprovalRequests({
        status: getStringFlag(parsed, "--status") as ApprovalRequestStatus | undefined,
        limit: getNumberFlag(parsed, "--limit", 50)
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(requests, null, 2)}\n`);
        return 0;
      }
      if (requests.length === 0) {
        process.stdout.write("No approval requests found.\n");
        return 0;
      }
      for (const request of requests) {
        process.stdout.write(
          `${request.id}\t${request.status}\t${request.deliveryStatus}\t${request.tweetId}\t${request.draftId}\n`
        );
      }
      return 0;
    }

    case "show": {
      const id = parsed.positionals[0];
      if (!id) {
        process.stderr.write("Usage: x-hermes approvals show <request-id> [--json]\n");
        return 2;
      }
      const details = await getApprovalRequestDetails({ id });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
      } else {
        printApprovalDetails(details);
      }
      return 0;
    }

    case "message": {
      const id = parsed.positionals[0];
      if (!id) {
        process.stderr.write("Usage: x-hermes approvals message <request-id>\n");
        return 2;
      }
      const details = await getApprovalRequestDetails({ id });
      process.stdout.write(`${details.request.messageText ?? renderApprovalRequestMessage(details)}\n`);
      return 0;
    }

    case "deliver": {
      const id = parsed.positionals[0];
      const deliveryStatus = getStringFlag(parsed, "--status") as "sent" | "failed" | undefined;
      if (!id || !deliveryStatus || !["sent", "failed"].includes(deliveryStatus)) {
        process.stderr.write(
          "Usage: x-hermes approvals deliver <request-id> --status sent|failed [--channel <name>] [--recipient <id>] [--external-id <id>]\n"
        );
        return 2;
      }
      const request = await recordApprovalDelivery({
        id,
        deliveryStatus,
        channel: getStringFlag(parsed, "--channel"),
        recipient: getStringFlag(parsed, "--recipient"),
        externalMessageId: getStringFlag(parsed, "--external-id"),
        actor: getStringFlag(parsed, "--by") ?? "cli"
      });
      process.stdout.write(`Recorded ${request.deliveryStatus} delivery for ${request.id}\n`);
      return 0;
    }

    case "approve": {
      const id = parsed.positionals[0];
      if (!id) {
        process.stderr.write("Usage: x-hermes approvals approve <request-id> [--by <actor>] [--reason <reason>]\n");
        return 2;
      }
      const result = await approveApprovalRequest({
        id,
        approvedBy: getStringFlag(parsed, "--by") ?? "human",
        reason: getStringFlag(parsed, "--reason")
      });
      process.stdout.write(`${result.message}\n`);
      return 0;
    }

    case "reject": {
      const id = parsed.positionals[0];
      if (!id) {
        process.stderr.write("Usage: x-hermes approvals reject <request-id> [--by <actor>] [--reason <reason>]\n");
        return 2;
      }
      const result = await rejectApprovalRequest({
        id,
        rejectedBy: getStringFlag(parsed, "--by") ?? "human",
        reason: getStringFlag(parsed, "--reason")
      });
      process.stdout.write(`${result.message}\n`);
      return 0;
    }

    case "edit": {
      const id = parsed.positionals[0];
      const text = getStringFlag(parsed, "--text");
      if (!id || !text) {
        process.stderr.write("Usage: x-hermes approvals edit <request-id> --text <reply> [--by <actor>]\n");
        return 2;
      }
      const result = await editApprovalRequestDraft({
        id,
        text,
        editedBy: getStringFlag(parsed, "--by") ?? "human"
      });
      process.stdout.write(`Updated draft ${result.draft.id} for approval request ${result.request.id}\n`);
      return 0;
    }

    case "respond": {
      const id = parsed.positionals[0];
      const message = getStringFlag(parsed, "--message");
      if (!id || !message) {
        process.stderr.write(
          "Usage: x-hermes approvals respond <request-id> --message <message> [--by <actor>] [--json]\n"
        );
        return 2;
      }
      const result = await processApprovalResponse({
        id,
        message,
        actor: getStringFlag(parsed, "--by") ?? "human",
        channel: getStringFlag(parsed, "--channel")
      });
      if (hasFlag(parsed, "--json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${result.message}\n`);
      }
      return 0;
    }

    default:
      process.stderr.write("Usage: x-hermes approvals <list|show|message|deliver|approve|reject|edit|respond>\n");
      return 2;
  }
}

async function runFeedbackCommand(parsed: ParsedArgs): Promise<number> {
  const { getFeedbackProfile } = await import("./feedback.js");
  const { openXHermesDatabase } = await import("./db.js");
  const db = await openXHermesDatabase();
  try {
    switch (parsed.subcommand) {
      case "profile": {
        const profile = getFeedbackProfile(db, getNumberFlag(parsed, "--limit", 100));
        if (hasFlag(parsed, "--json")) {
          process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(`Approved examples: ${profile.totals.approved}\n`);
        process.stdout.write(`Rejected examples: ${profile.totals.rejected}\n`);
        process.stdout.write("Guidance:\n");
        for (const line of profile.draftingGuidance) {
          process.stdout.write(`  ${line}\n`);
        }
        if (Object.keys(profile.labels).length > 0) {
          process.stdout.write("Labels:\n");
          for (const [label, count] of Object.entries(profile.labels)) {
            process.stdout.write(`  ${label}: ${count}\n`);
          }
        }
        return 0;
      }

      case "examples": {
        const examples = db.listFeedbackExamples({
          decision: getStringFlag(parsed, "--decision") as "approved" | "rejected" | undefined,
          limit: getNumberFlag(parsed, "--limit", 50)
        });
        if (hasFlag(parsed, "--json")) {
          process.stdout.write(`${JSON.stringify(examples, null, 2)}\n`);
          return 0;
        }
        for (const example of examples) {
          process.stdout.write(
            `${example.id}\t${example.decision}\t@${example.authorUsername}\t${example.labels.join(",")}\t${truncate(example.candidateText, 100)}\n`
          );
        }
        return 0;
      }

      default:
        process.stderr.write("Usage: x-hermes feedback <profile|examples>\n");
        return 2;
    }
  } finally {
    db.close();
  }
}

async function runOptOutCommand(parsed: ParsedArgs): Promise<number> {
  if (parsed.subcommand !== "add") {
    process.stderr.write("Usage: x-hermes opt-out add <username> [--by <actor>] [--reason <reason>]\n");
    return 2;
  }
  const username = parsed.positionals[0];
  if (!username) {
    process.stderr.write("Usage: x-hermes opt-out add <username> [--by <actor>] [--reason <reason>]\n");
    return 2;
  }
  const { recordOptOut } = await import("./queue.js");
  await recordOptOut({
    username,
    actor: getStringFlag(parsed, "--by") ?? "cli",
    reason: getStringFlag(parsed, "--reason")
  });
  process.stdout.write(`Recorded opt-out for ${username}\n`);
  return 0;
}

async function runPostApprovedCommand(parsed: ParsedArgs): Promise<number> {
  const tweetId = parsed.subcommand;
  if (!tweetId) {
    process.stderr.write("Usage: x-hermes post-approved <tweet-id> [--by <actor>] [--json]\n");
    return 2;
  }
  const { postApprovedReply } = await import("./posting.js");
  const result = await postApprovedReply({
    tweetId,
    actor: getStringFlag(parsed, "--by") ?? "cli"
  });

  if (hasFlag(parsed, "--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.posted ? 0 : 1;
  }

  if (!result.posted) {
    process.stderr.write(`Posting blocked for ${tweetId}:\n`);
    for (const failure of result.guardrails.failures) {
      process.stderr.write(`  ${failure.id}: ${failure.message}\n`);
    }
    return 1;
  }

  process.stdout.write(`Posted reply ${result.replyTweetId} for ${tweetId}\n`);
  return 0;
}

async function runStatsCommand(parsed: ParsedArgs): Promise<number> {
  const { openXHermesDatabase } = await import("./db.js");
  const db = await openXHermesDatabase();
  try {
    const stats = db.getStats();
    if (hasFlag(parsed, "--json")) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return 0;
    }
    process.stdout.write("Candidates:\n");
    for (const [status, count] of Object.entries(stats.candidatesByStatus)) {
      process.stdout.write(`  ${status}: ${count}\n`);
    }
    process.stdout.write(`Reply drafts: ${stats.replyDrafts}\n`);
    process.stdout.write(`Posted replies: ${stats.postedReplies}\n`);
    process.stdout.write(`Opt-outs: ${stats.optOuts}\n`);
    process.stdout.write(`Audit events: ${stats.auditEvents}\n`);
    return 0;
  } finally {
    db.close();
  }
}

function setConfigValue(target: Record<string, unknown>, keyPath: string, value: unknown): void {
  const segments = keyPath.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("Config path cannot be empty.");
  }

  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    const nextSegment = segments[index + 1] ?? "";
    const nextIsArray = /^\d+$/.test(nextSegment);
    if (Array.isArray(cursor)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) {
        throw new Error(`Invalid array index in config path: ${segment}`);
      }
      if (cursor[arrayIndex] === undefined) {
        cursor[arrayIndex] = nextIsArray ? [] : {};
      }
      cursor = cursor[arrayIndex] as Record<string, unknown> | unknown[];
      continue;
    }
    if (cursor[segment] === undefined) {
      cursor[segment] = nextIsArray ? [] : {};
    }
    cursor = cursor[segment] as Record<string, unknown> | unknown[];
  }

  const leaf = segments[segments.length - 1] ?? "";
  if (Array.isArray(cursor)) {
    const arrayIndex = Number(leaf);
    if (!Number.isInteger(arrayIndex) || arrayIndex < 0) {
      throw new Error(`Invalid array index in config path: ${leaf}`);
    }
    cursor[arrayIndex] = value;
    return;
  }
  cursor[leaf] = value;
}

function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    return JSON.parse(trimmed);
  }
  return raw;
}

function getApprovalMode(parsed: ParsedArgs): ApprovalMode | undefined {
  if (hasFlag(parsed, "--no-approval")) {
    return "none";
  }
  if (hasFlag(parsed, "--require-approval")) {
    return "required";
  }
  const value = getStringFlag(parsed, "--approval-mode") ?? getStringFlag(parsed, "--approval");
  if (!value) {
    return undefined;
  }
  if (value === "required" || value === "none" || value === "opt_in_auto_post") {
    return value;
  }
  throw new Error("Approval mode must be required, none, or opt_in_auto_post.");
}

function getOptionalBooleanFlag(parsed: ParsedArgs, flag: string): boolean | undefined {
  if (!parsed.flags.has(flag)) {
    return undefined;
  }
  return getBooleanFlag(parsed, flag, true);
}

function getBooleanFlag(parsed: ParsedArgs, flag: string, defaultValue: boolean): boolean {
  const value = parsed.flags.get(flag);
  if (value === undefined) {
    return defaultValue;
  }
  if (value === true) {
    return true;
  }
  if (/^(true|1|yes|y|on)$/i.test(value)) {
    return true;
  }
  if (/^(false|0|no|n|off)$/i.test(value)) {
    return false;
  }
  return defaultValue;
}

function printCampaignRunSummary(summary: {
  campaigns: Array<{
    campaignId: string;
    fetched: number;
    selected: number;
    results: Array<{
      action: string;
      tweetId?: string;
      authorUsername?: string;
      score?: number;
      reason?: string;
      replyTweetId?: string;
      approvalRequestId?: string;
      guardrailFailures?: Array<{ id: string; message: string }>;
    }>;
  }>;
}): void {
  for (const campaign of summary.campaigns) {
    process.stdout.write(
      `Campaign ${campaign.campaignId}: fetched ${campaign.fetched}, selected ${campaign.selected}\n`
    );
    for (const result of campaign.results) {
      const subject = result.tweetId
        ? `${result.tweetId}${result.authorUsername ? ` @${result.authorUsername}` : ""}`
        : "campaign";
      const detail =
        result.replyTweetId ??
        result.approvalRequestId ??
        result.reason ??
        result.guardrailFailures?.map((failure) => failure.id).join(", ") ??
        "";
      process.stdout.write(`  ${result.action}\t${subject}${detail ? `\t${detail}` : ""}\n`);
    }
  }
}

function hasCampaignFailures(summary: {
  campaigns: Array<{ results: Array<{ action: string }> }>;
}): boolean {
  return summary.campaigns.some((campaign) =>
    campaign.results.some((result) => result.action === "failed")
  );
}

function hasFlag(parsed: ParsedArgs, flag: string): boolean {
  return parsed.flags.has(flag);
}

function getStringFlag(parsed: ParsedArgs, flag: string): string | undefined {
  const value = parsed.flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

function getNumberFlag(parsed: ParsedArgs, flag: string, defaultValue: number): number {
  const value = getStringFlag(parsed, flag);
  if (!value) {
    return defaultValue;
  }
  const parsedNumber = Number(value);
  return Number.isFinite(parsedNumber) && parsedNumber > 0 ? Math.trunc(parsedNumber) : defaultValue;
}

function printCandidateDetails(details: {
  candidate: {
    tweetId: string;
    status: string;
    score: number;
    authorUsername: string;
    text: string;
    riskFlags: string[];
    url?: string;
  };
  draft?: { id: string; status: string; text: string };
}): void {
  const candidate = details.candidate;
  process.stdout.write(`Tweet: ${candidate.tweetId}\n`);
  process.stdout.write(`Author: @${candidate.authorUsername}\n`);
  process.stdout.write(`Status: ${candidate.status}\n`);
  process.stdout.write(`Score: ${candidate.score}\n`);
  process.stdout.write(`Risk flags: ${candidate.riskFlags.join(", ") || "none"}\n`);
  if (candidate.url) {
    process.stdout.write(`URL: ${candidate.url}\n`);
  }
  process.stdout.write(`Text:\n${candidate.text}\n`);
  if (details.draft) {
    process.stdout.write(`\nDraft ${details.draft.id} (${details.draft.status}):\n`);
    process.stdout.write(`${details.draft.text}\n`);
  }
}

function printApprovalDetails(details: {
  request: {
    id: string;
    status: string;
    deliveryStatus: string;
    channel?: string;
    recipient?: string;
    decisionReason?: string;
    decisionLabels: string[];
  };
  candidate: {
    tweetId: string;
    status: string;
    score: number;
    authorUsername: string;
    text: string;
    riskFlags: string[];
    url?: string;
  };
  draft: { id: string; status: string; text: string };
}): void {
  process.stdout.write(`Approval: ${details.request.id}\n`);
  process.stdout.write(`Status: ${details.request.status}\n`);
  process.stdout.write(`Delivery: ${details.request.deliveryStatus}\n`);
  if (details.request.channel) {
    process.stdout.write(`Channel: ${details.request.channel}\n`);
  }
  if (details.request.recipient) {
    process.stdout.write(`Recipient: ${details.request.recipient}\n`);
  }
  if (details.request.decisionReason) {
    process.stdout.write(`Reason: ${details.request.decisionReason}\n`);
  }
  if (details.request.decisionLabels.length > 0) {
    process.stdout.write(`Feedback labels: ${details.request.decisionLabels.join(", ")}\n`);
  }
  process.stdout.write("\n");
  printCandidateDetails({
    candidate: details.candidate,
    draft: details.draft
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
