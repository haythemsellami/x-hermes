import { runProcess } from "./process.js";
import type { NotificationEvent, XHermesConfig } from "./types.js";

export interface NotificationPayload {
  event: NotificationEvent;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationResult {
  channelId: string;
  ok: boolean;
  message: string;
}

export async function notify(
  config: XHermesConfig,
  event: NotificationEvent,
  input: Omit<NotificationPayload, "event" | "createdAt">,
  options: {
    env?: NodeJS.ProcessEnv;
    output?: NodeJS.WritableStream;
  } = {}
): Promise<NotificationResult[]> {
  if (!isEventEnabled(config, event)) {
    return [];
  }

  const payload: NotificationPayload = {
    event,
    title: input.title,
    message: input.message,
    data: input.data,
    createdAt: new Date().toISOString()
  };
  const results: NotificationResult[] = [];

  for (const channel of config.notifications.channels) {
    if (!channel.enabled) {
      continue;
    }
    if (channel.events && !channel.events.includes(event)) {
      continue;
    }

    if (channel.type === "stdout") {
      const output = options.output ?? process.stdout;
      output.write(`[x-hermes] ${event}: ${payload.title}\n${payload.message}\n`);
      results.push({ channelId: channel.id, ok: true, message: "written to stdout" });
      continue;
    }

    if (channel.type === "command") {
      if (!channel.command) {
        results.push({ channelId: channel.id, ok: false, message: "command is required" });
        continue;
      }
      const result = await runProcess(channel.command, channel.args ?? [], {
        env: options.env,
        timeoutMs: 15_000,
        stdin: `${JSON.stringify(payload)}\n`
      });
      results.push({
        channelId: channel.id,
        ok: result.ok,
        message: result.ok
          ? "command notification sent"
          : (result.stderr || result.stdout || "command notification failed").trim()
      });
      continue;
    }

    if (channel.type === "hermes") {
      if (!channel.target) {
        results.push({ channelId: channel.id, ok: false, message: "target is required" });
        continue;
      }
      const command = channel.command ?? options.env?.X_HERMES_HERMES_BIN ?? "hermes";
      const args = [
        ...(channel.args ?? []),
        "send",
        "--to",
        channel.target,
        "--file",
        "-",
        "--subject",
        channel.subject ?? `[x-hermes] ${payload.title}`,
        "--quiet"
      ];
      const result = await runProcess(command, args, {
        env: options.env,
        timeoutMs: 20_000,
        stdin: formatHermesMessage(payload)
      });
      results.push({
        channelId: channel.id,
        ok: result.ok,
        message: result.ok
          ? "Hermes notification sent"
          : (result.stderr || result.stdout || "Hermes notification failed").trim()
      });
    }
  }

  return results;
}

function formatHermesMessage(payload: NotificationPayload): string {
  const lines = [
    payload.message,
    "",
    `event: ${payload.event}`,
    `createdAt: ${payload.createdAt}`
  ];

  if (payload.data) {
    for (const [key, value] of Object.entries(payload.data)) {
      if (value === undefined || value === null) {
        continue;
      }
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function isEventEnabled(config: XHermesConfig, event: NotificationEvent): boolean {
  switch (event) {
    case "post":
      return config.notifications.onPost;
    case "error":
      return config.notifications.onError;
    case "approval_request":
      return config.notifications.onApprovalRequest;
  }
}
