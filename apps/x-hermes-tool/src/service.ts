import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runProcess } from "./process.js";

export interface ServiceInfo {
  platform: NodeJS.Platform;
  serviceName: string;
  path: string;
  exists: boolean;
  manager: "systemd" | "launchd" | "unsupported";
  installCommands: string[];
  logCommand?: string;
}

export interface ServiceInstallResult extends ServiceInfo {
  written: boolean;
  enabled: boolean;
  enableOutput?: string;
}

const SERVICE_NAME = "x-hermes";
const SERVICE_ENV_KEYS = [
  "PATH",
  "X_HERMES_CONFIG_DIR",
  "X_HERMES_CONFIG_PATH",
  "X_HERMES_DATA_DIR",
  "X_HERMES_DB_PATH",
  "X_HERMES_XURL_BIN",
  "X_HERMES_HERMES_BIN"
];

export async function getServiceInfo(env: NodeJS.ProcessEnv = process.env): Promise<ServiceInfo> {
  const definition = serviceDefinition(env);
  return {
    platform: process.platform,
    serviceName: SERVICE_NAME,
    path: definition.path,
    exists: await exists(definition.path),
    manager: definition.manager,
    installCommands: definition.installCommands,
    logCommand: definition.logCommand
  };
}

export async function installService(options: {
  enable?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ServiceInstallResult> {
  const definition = serviceDefinition(options.env ?? process.env);
  if (definition.manager === "unsupported") {
    throw new Error("x-hermes service install currently supports Linux systemd user services and macOS launchd.");
  }

  await mkdir(path.dirname(definition.path), { recursive: true });
  await writeFile(definition.path, definition.contents, { encoding: "utf8", mode: 0o644 });

  let enabled = false;
  let enableOutput: string | undefined;
  if (options.enable) {
    if (definition.manager === "systemd") {
      const reload = await runProcess("systemctl", ["--user", "daemon-reload"], {
        env: options.env,
        timeoutMs: 15_000
      });
      const enable = await runProcess("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`], {
        env: options.env,
        timeoutMs: 30_000
      });
      enabled = reload.ok && enable.ok;
      enableOutput = [reload.stdout, reload.stderr, enable.stdout, enable.stderr]
        .filter(Boolean)
        .join("\n");
    } else {
      const bootstrap = await runProcess("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, definition.path], {
        env: options.env,
        timeoutMs: 30_000
      });
      enabled = bootstrap.ok;
      enableOutput = [bootstrap.stdout, bootstrap.stderr].filter(Boolean).join("\n");
    }
  }

  return {
    platform: process.platform,
    serviceName: SERVICE_NAME,
    path: definition.path,
    exists: true,
    manager: definition.manager,
    installCommands: definition.installCommands,
    logCommand: definition.logCommand,
    written: true,
    enabled,
    enableOutput
  };
}

export async function uninstallService(options: { env?: NodeJS.ProcessEnv } = {}): Promise<ServiceInfo> {
  const definition = serviceDefinition(options.env ?? process.env);
  if (await exists(definition.path)) {
    await unlink(definition.path);
  }
  return await getServiceInfo(options.env);
}

function serviceDefinition(env: NodeJS.ProcessEnv): {
  manager: ServiceInfo["manager"];
  path: string;
  contents: string;
  installCommands: string[];
  logCommand?: string;
} {
  const execArgs = serviceExecArgs();
  const environment = serviceEnvironment(env);
  if (process.platform === "linux") {
    const servicePath = path.join(configHome(env), "systemd", "user", `${SERVICE_NAME}.service`);
    return {
      manager: "systemd",
      path: servicePath,
      contents: [
        "[Unit]",
        "Description=x-hermes campaign runner",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        ...environment.map(([key, value]) => `Environment=${systemdEnvironment(key, value)}`),
        `ExecStart=${execArgs.map(systemdEscape).join(" ")}`,
        "Restart=always",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        ""
      ].join("\n"),
      installCommands: [
        `systemctl --user daemon-reload`,
        `systemctl --user enable --now ${SERVICE_NAME}.service`
      ],
      logCommand: `journalctl --user -u ${SERVICE_NAME}.service -f`
    };
  }

  if (process.platform === "darwin") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "io.github.x-hermes.plist");
    return {
      manager: "launchd",
      path: plistPath,
      contents: plist(execArgs, environment),
      installCommands: [`launchctl bootstrap gui/$(id -u) ${plistPath}`],
      logCommand: `log stream --predicate 'process == "x-hermes"'`
    };
  }

  return {
    manager: "unsupported",
    path: "",
    contents: "",
    installCommands: []
  };
}

function serviceExecArgs(): string[] {
  const script = process.argv[1];
  if (script?.endsWith("cli.js")) {
    return [process.execPath, script, "run"];
  }
  return ["x-hermes", "run"];
}

function configHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function systemdEscape(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

function systemdEnvironment(key: string, value: string): string {
  return `"${key}=${value.replace(/(["\\])/g, "\\$1")}"`;
}

function serviceEnvironment(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return SERVICE_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return value ? [[key, value] as [string, string]] : [];
  });
}

function plist(args: string[], environment: Array<[string, string]>): string {
  const argsXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  const environmentXml =
    environment.length > 0
      ? `  <key>EnvironmentVariables</key>
  <dict>
${environment
  .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
  .join("\n")}
  </dict>
`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.x-hermes</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${environmentXml}
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function exists(filePath: string): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
