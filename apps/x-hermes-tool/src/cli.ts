#!/usr/bin/env node
import { collectStatus, printStatusReport, runSetup } from "./setup.js";
import type { CandidateStatus, SetupOptions } from "./types.js";

const VERSION = "0.1.0";

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (hasFlag(parsed, "--help") || parsed.command === "help") {
    printHelp();
    return 0;
  }

  if (hasFlag(parsed, "--version") || parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
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

    case "opt-out":
      return await runOptOutCommand(parsed);

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
  x-hermes watch-queries add <name> --query <query>
  x-hermes watch-queries list [--json]
  x-hermes scan [--query <query> | --watch <id>] [--limit 25] [--json]
  x-hermes candidates list [--status <status>] [--limit 50] [--json]
  x-hermes candidates show <tweet-id> [--json]
  x-hermes draft <tweet-id> --text <reply> [--by <actor>]
  x-hermes approve <tweet-id> --by <actor> [--reason <reason>]
  x-hermes reject <tweet-id> [--by <actor>] [--reason <reason>]
  x-hermes opt-out add <username> [--by <actor>] [--reason <reason>]
  x-hermes stats [--json]
  x-hermes mcp

Setup collects X OAuth secrets only through local terminal prompts.
`);
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
