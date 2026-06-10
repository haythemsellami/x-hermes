#!/usr/bin/env node
import { collectStatus, printStatusReport, runSetup } from "./setup.js";
import type { SetupOptions } from "./types.js";

const VERSION = "0.1.0";

interface ParsedArgs {
  command: string;
  flags: Set<string>;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.flags.has("--help") || parsed.command === "help") {
    printHelp();
    return 0;
  }

  if (parsed.flags.has("--version") || parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (parsed.command) {
    case "setup": {
      const options: SetupOptions = {
        checkOnly: parsed.flags.has("--check-only"),
        withHermes: parsed.flags.has("--with-hermes"),
        nonInteractive: parsed.flags.has("--non-interactive"),
        json: parsed.flags.has("--json")
      };
      const report = await runSetup(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      return report.ready ? 0 : 1;
    }

    case "status": {
      const report = await collectStatus({
        withHermes: parsed.flags.has("--with-hermes"),
        mutateStorage: false
      });
      if (parsed.flags.has("--json")) {
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
        withHermes: parsed.flags.has("--with-hermes"),
        mutateStorage: false
      });
      if (parsed.flags.has("--json")) {
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

    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
      printHelp();
      return 2;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv.find((arg) => !arg.startsWith("-")) ?? "help";
  const flags = new Set(argv.filter((arg) => arg.startsWith("-")));
  return { command, flags };
}

function printHelp(): void {
  process.stdout.write(`x-hermes ${VERSION}

Usage:
  x-hermes setup [--check-only] [--with-hermes] [--non-interactive] [--json]
  x-hermes status [--with-hermes] [--json]
  x-hermes doctor [--with-hermes] [--json]
  x-hermes mcp

Setup collects X OAuth secrets only through local terminal prompts.
`);
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

