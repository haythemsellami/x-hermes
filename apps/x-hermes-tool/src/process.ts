import { spawn } from "node:child_process";

import type { ProcessResult } from "./types.js";

export interface RunProcessOptions {
  timeoutMs?: number;
  secrets?: string[];
  env?: NodeJS.ProcessEnv;
}

export function redactText(text: string, secrets: string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }

  redacted = redacted.replace(
    /(client[_-]?secret["'\s:=]+)([^"'\s]+)/gi,
    "$1[redacted]"
  );
  redacted = redacted.replace(/(access[_-]?token["'\s:=]+)([^"'\s]+)/gi, "$1[redacted]");
  redacted = redacted.replace(/(refresh[_-]?token["'\s:=]+)([^"'\s]+)/gi, "$1[redacted]");

  return redacted;
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const commandForReport = [command, ...args];

  return await new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const rawStdout = Buffer.concat(stdout).toString("utf8");
      const rawStderr = Buffer.concat(stderr).toString("utf8");
      resolve({
        command: commandForReport,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        stdout: redactText(rawStdout, options.secrets),
        stderr: redactText(rawStderr, options.secrets),
        timedOut
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export async function runProcessInherited(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit"
    });

    let settled = false;
    const finish = (code: number | null) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
