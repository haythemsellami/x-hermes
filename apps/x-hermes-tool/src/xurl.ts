import { runProcess, runProcessInherited } from "./process.js";
import type { ProcessResult } from "./types.js";

export interface XurlRunOptions {
  timeoutMs?: number;
  secrets?: string[];
  env?: NodeJS.ProcessEnv;
}

const REDACT_NEXT_FLAGS = new Set(["--client-id", "--client-secret"]);

export function assertAllowedXurlArgs(args: string[]): void {
  if (args.length === 0) {
    throw new Error("Refusing to run xurl without an explicit operation.");
  }

  const [first, second, third] = args;

  if (first === "--help" && args.length === 1) {
    return;
  }

  if (first === "auth" && second === "status") {
    return;
  }

  if (first === "auth" && second === "apps" && third === "add") {
    return;
  }

  if (first === "auth" && second === "oauth2") {
    return;
  }

  if (first === "auth" && second === "default") {
    return;
  }

  if (first === "whoami" && args.length === 1) {
    return;
  }

  if (first === "search" && args.length >= 2) {
    return;
  }

  if (first === "read" && args.length >= 2) {
    return;
  }

  if (first === "reply" && args.length >= 3) {
    return;
  }

  if (first.startsWith("/2/tweets/search/recent")) {
    return;
  }

  throw new Error(`Refusing to run unsupported xurl operation: ${redactArgv(args).join(" ")}`);
}

export function redactArgv(args: string[], secrets: string[] = []): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    const arg = redacted[index];
    if (REDACT_NEXT_FLAGS.has(arg) && redacted[index + 1]) {
      redacted[index + 1] = "[redacted]";
      index += 1;
      continue;
    }

    for (const secret of secrets) {
      if (secret.length > 0 && arg.includes(secret)) {
        redacted[index] = arg.split(secret).join("[redacted]");
      }
    }
  }
  return redacted;
}

export async function runXurl(
  args: string[],
  options: XurlRunOptions = {}
): Promise<ProcessResult> {
  assertAllowedXurlArgs(args);
  const command = getXurlCommand(options.env);
  const result = await runProcess(command, args, {
    timeoutMs: options.timeoutMs,
    secrets: options.secrets,
    env: options.env
  });
  return {
    ...result,
    command: ["xurl", ...redactArgv(args, options.secrets)]
  };
}

export async function runXurlInherited(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number | null> {
  assertAllowedXurlArgs(args);
  return await runProcessInherited(getXurlCommand(env), args, env);
}

export function getXurlCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.X_HERMES_XURL_BIN || "xurl";
}
