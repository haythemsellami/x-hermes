import path from "node:path";

import {
  checkWritableDir,
  getDataDir,
  loadConfig,
  saveConfig
} from "./config.js";
import { promptConfirm, promptSecret, promptText, isInteractive, type PromptIo } from "./prompt.js";
import { runProcessInherited } from "./process.js";
import { runXurl, runXurlInherited } from "./xurl.js";
import type {
  DiagnosticCheck,
  LoadedConfig,
  SetupOptions,
  StatusOptions,
  StatusReport,
  XHermesConfig
} from "./types.js";

const INSTALL_XURL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash";

export async function collectStatus(
  options: StatusOptions & { mutateStorage?: boolean } = { withHermes: false }
): Promise<StatusReport> {
  const loaded = await loadConfig();
  const dataDir = getDataDir();
  const checks: DiagnosticCheck[] = [];

  checks.push(checkPlatform());
  checks.push(checkNodeVersion(process.versions.node));
  checks.push(checkConfig(loaded));
  checks.push(await checkStorage(dataDir, Boolean(options.mutateStorage)));

  const xurlHelp = await runXurl(["--help"], { timeoutMs: 10_000 });
  checks.push(checkXurlHelp(xurlHelp.ok));

  if (xurlHelp.ok) {
    const authStatus = await runXurl(["auth", "status"], { timeoutMs: 15_000 });
    checks.push(checkXurlAuth(authStatus.ok, authStatus.stderr || authStatus.stdout));

    const whoami = await runXurl(["whoami"], { timeoutMs: 15_000 });
    checks.push(checkXurlWhoami(whoami.ok, whoami.stdout || whoami.stderr));
  } else {
    checks.push({
      id: "xurl-auth",
      label: "xurl auth",
      status: "error",
      message: "Cannot verify xurl auth because xurl is not installed or not on PATH.",
      remediation: `Run x-hermes setup, or install xurl manually with: ${INSTALL_XURL_COMMAND}`
    });
  }

  if (options.withHermes) {
    checks.push(await checkHermes());
  }

  return {
    ready: !checks.some((check) => check.status === "error"),
    configPath: loaded.path,
    dataDir,
    checks,
    config: loaded.exists ? loaded.config : undefined
  };
}

export async function runSetup(
  options: SetupOptions,
  io: PromptIo = { input: process.stdin, output: process.stdout }
): Promise<StatusReport> {
  io.output.write("Running x-hermes setup checks...\n");

  let status = await collectStatus({
    withHermes: options.withHermes,
    mutateStorage: false
  });

  printChecks(status.checks, io);

  if (options.checkOnly) {
    io.output.write("\nCheck-only mode: no installs, auth changes, or config writes were performed.\n");
    return status;
  }

  const xurlInstalled = status.checks.some((check) => check.id === "xurl" && check.status === "ok");
  const setupBlocker = status.checks.find((check) =>
    ["platform", "node", "storage"].includes(check.id) && check.status === "error"
  );

  if (setupBlocker) {
    io.output.write(`\nSetup cannot continue: ${setupBlocker.message}\n`);
    return status;
  }

  if (!xurlInstalled) {
    if (options.nonInteractive || !isInteractive(io)) {
      io.output.write(
        `\nxurl is required. Install it manually, then rerun setup:\n${INSTALL_XURL_COMMAND}\n`
      );
      return status;
    }

    const install = await promptConfirm(io, "Install xurl with the official installer?", {
      defaultValue: false
    });
    if (!install) {
      io.output.write("Skipped xurl installation.\n");
      return status;
    }

    io.output.write("Installing xurl...\n");
    const code = await runProcessInherited("bash", ["-lc", INSTALL_XURL_COMMAND]);
    if (code !== 0) {
      io.output.write("xurl installer failed. Rerun setup after installing xurl.\n");
      return await collectStatus({ withHermes: options.withHermes, mutateStorage: false });
    }
  }

  await collectStatus({ withHermes: options.withHermes, mutateStorage: true });

  status = await collectStatus({
    withHermes: options.withHermes,
    mutateStorage: false
  });

  if (status.ready) {
    io.output.write("\nx-hermes already looks configured.\n");
    if (options.withHermes) {
      printHermesMcpConfig(io);
    }
    if (options.nonInteractive || !isInteractive(io)) {
      return status;
    }

    const reconfigure = await promptConfirm(io, "Reconfigure xurl app/auth anyway?", {
      defaultValue: false
    });
    if (!reconfigure) {
      return status;
    }
  }

  if (options.nonInteractive || !isInteractive(io)) {
    io.output.write("\nInteractive terminal input is required to collect OAuth app secrets.\n");
    return status;
  }

  const loaded = await loadConfig();
  const nextConfig = await promptForConfig(loaded, io);

  io.output.write("\nConfiguring xurl app profile...\n");
  const appResult = await runXurl(
    [
      "auth",
      "apps",
      "add",
      nextConfig.config.xurlApp,
      "--client-id",
      nextConfig.clientId,
      "--client-secret",
      nextConfig.clientSecret,
      "--redirect-uri",
      nextConfig.redirectUri
    ],
    {
      timeoutMs: 30_000,
      secrets: [nextConfig.clientId, nextConfig.clientSecret]
    }
  );

  if (!appResult.ok) {
    io.output.write("Failed to configure the xurl app profile.\n");
    printProcessOutput(appResult.stdout, appResult.stderr, io);
    return await collectStatus({ withHermes: options.withHermes, mutateStorage: false });
  }

  printProcessOutput(appResult.stdout, appResult.stderr, io);

  io.output.write("\nStarting xurl OAuth flow. Follow the local terminal/browser instructions.\n");
  const oauthCode = await runXurlInherited([
    "auth",
    "oauth2",
    "--app",
    nextConfig.config.xurlApp,
    nextConfig.config.username
  ]);
  if (oauthCode !== 0) {
    io.output.write("xurl OAuth flow failed or was cancelled.\n");
    return await collectStatus({ withHermes: options.withHermes, mutateStorage: false });
  }

  const defaultResult = await runXurl(
    ["auth", "default", nextConfig.config.xurlApp, nextConfig.config.username],
    {
      timeoutMs: 15_000
    }
  );
  if (!defaultResult.ok) {
    io.output.write("Failed to set xurl default app/account.\n");
    printProcessOutput(defaultResult.stdout, defaultResult.stderr, io);
    return await collectStatus({ withHermes: options.withHermes, mutateStorage: false });
  }

  await saveConfig(nextConfig.config);
  io.output.write(`Saved non-secret config to ${loaded.path}\n`);

  const whoami = await runXurl(["whoami"], { timeoutMs: 15_000 });
  printProcessOutput(whoami.stdout, whoami.stderr, io);

  await maybeRunSearchSmokeCheck(nextConfig.config.username, io);

  if (options.withHermes) {
    printHermesMcpConfig(io);
  }

  status = await collectStatus({
    withHermes: options.withHermes,
    mutateStorage: false
  });

  return status;
}

export function printStatusReport(title: string, report: StatusReport, io: PromptIo): void {
  io.output.write(`${title}\n`);
  io.output.write(`Config: ${report.configPath}\n`);
  io.output.write(`Data:   ${report.dataDir}\n`);

  if (report.config) {
    io.output.write(`xurl app: ${report.config.xurlApp}\n`);
    io.output.write(`username: ${report.config.username || "(not set)"}\n`);
    io.output.write(
      `active hours: ${report.config.activeHours.start}-${report.config.activeHours.end} ${report.config.activeHours.timezone}\n`
    );
    io.output.write(`posting enabled: ${String(report.config.postingEnabled)}\n`);
  }

  io.output.write("\n");
  printChecks(report.checks, io);
  io.output.write(`\nReady: ${report.ready ? "yes" : "no"}\n`);
}

export function printChecks(checks: DiagnosticCheck[], io: PromptIo): void {
  for (const check of checks) {
    io.output.write(`[${check.status}] ${check.label}: ${check.message}\n`);
    if (check.remediation && check.status !== "ok") {
      io.output.write(`  ${check.remediation}\n`);
    }
  }
}

export function getHermesMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      "x-hermes": {
        command: "x-hermes-mcp",
        args: []
      }
    }
  };
}

function checkPlatform(): DiagnosticCheck {
  if (process.platform === "darwin" || process.platform === "linux") {
    return {
      id: "platform",
      label: "Platform",
      status: "ok",
      message: `${process.platform} is supported.`
    };
  }

  return {
    id: "platform",
    label: "Platform",
    status: "error",
    message: `${process.platform} is not a first-target platform for x-hermes.`,
    remediation: "Use macOS or Linux until xurl and Hermes support are verified on this platform."
  };
}

function checkNodeVersion(version: string): DiagnosticCheck {
  const major = Number(version.split(".")[0]);
  if (major >= 24) {
    return {
      id: "node",
      label: "Node.js",
      status: "ok",
      message: `Node ${version} satisfies >=24.`
    };
  }

  return {
    id: "node",
    label: "Node.js",
    status: "error",
    message: `Node ${version} does not satisfy >=24.`,
    remediation: "Install Node.js 24 or newer."
  };
}

function checkConfig(loaded: LoadedConfig): DiagnosticCheck {
  if (!loaded.exists) {
    return {
      id: "config",
      label: "Config",
      status: "error",
      message: `No x-hermes config found at ${loaded.path}.`,
      remediation: "Run x-hermes setup."
    };
  }

  if (!loaded.config.xurlApp || !loaded.config.username) {
    return {
      id: "config",
      label: "Config",
      status: "error",
      message: "Config exists but xurlApp or username is missing.",
      remediation: "Run x-hermes setup to repair non-secret config."
    };
  }

  return {
    id: "config",
    label: "Config",
    status: "ok",
    message: `Found non-secret config at ${loaded.path}.`
  };
}

async function checkStorage(dir: string, mutate: boolean): Promise<DiagnosticCheck> {
  const result = await checkWritableDir(dir, { mutate });
  if (result.ok) {
    return {
      id: "storage",
      label: "Storage",
      status: "ok",
      message: result.message,
      details: { path: dir, created: result.created }
    };
  }

  return {
    id: "storage",
    label: "Storage",
    status: "error",
    message: result.message,
    remediation: `Create or fix permissions for ${dir}.`
  };
}

function checkXurlHelp(ok: boolean): DiagnosticCheck {
  if (ok) {
    return {
      id: "xurl",
      label: "xurl",
      status: "ok",
      message: "xurl is installed and callable."
    };
  }

  return {
    id: "xurl",
    label: "xurl",
    status: "error",
    message: "xurl is not installed or not on PATH.",
    remediation: `Run x-hermes setup, or install xurl manually with: ${INSTALL_XURL_COMMAND}`
  };
}

function checkXurlAuth(ok: boolean, output: string): DiagnosticCheck {
  if (ok) {
    return {
      id: "xurl-auth",
      label: "xurl auth",
      status: "ok",
      message: "xurl auth status succeeded."
    };
  }

  return {
    id: "xurl-auth",
    label: "xurl auth",
    status: "error",
    message: "xurl auth status failed.",
    remediation: "Run x-hermes setup to configure xurl OAuth.",
    details: { output: output.trim().slice(0, 500) }
  };
}

function checkXurlWhoami(ok: boolean, output: string): DiagnosticCheck {
  if (ok) {
    return {
      id: "xurl-whoami",
      label: "xurl whoami",
      status: "ok",
      message: "xurl whoami succeeded."
    };
  }

  return {
    id: "xurl-whoami",
    label: "xurl whoami",
    status: "error",
    message: "xurl whoami failed.",
    remediation: "Run x-hermes setup to finish account auth.",
    details: { output: output.trim().slice(0, 500) }
  };
}

async function checkHermes(): Promise<DiagnosticCheck> {
  const result = await import("./process.js").then(({ runProcess }) =>
    runProcess("hermes", ["--help"], { timeoutMs: 10_000 })
  );

  if (result.ok) {
    return {
      id: "hermes",
      label: "Hermes",
      status: "ok",
      message: "Hermes is installed and callable."
    };
  }

  return {
    id: "hermes",
    label: "Hermes",
    status: "warn",
    message: "Hermes is not installed or not on PATH.",
    remediation: "Skip --with-hermes on machines that do not run Hermes."
  };
}

async function promptForConfig(
  loaded: LoadedConfig,
  io: PromptIo
): Promise<{
  config: XHermesConfig;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}> {
  const existing = loaded.config;
  const app = await promptText(io, "xurl app profile name", {
    defaultValue: existing.xurlApp || "x-hermes",
    required: true
  });
  const username = await promptText(io, "X username/handle", {
    defaultValue: existing.username || undefined,
    required: true
  });
  const clientId = await promptSecret(io, "X OAuth Client ID", { required: true });
  const clientSecret = await promptSecret(io, "X OAuth Client Secret", { required: true });
  const redirectUri = await promptText(io, "Redirect URI", {
    defaultValue: "http://localhost:8080/callback",
    required: true
  });

  return {
    config: {
      ...existing,
      xurlApp: app,
      username
    },
    clientId,
    clientSecret,
    redirectUri
  };
}

async function maybeRunSearchSmokeCheck(username: string, io: PromptIo): Promise<void> {
  const runSearch = await promptConfirm(io, "Run a short xurl search smoke test?", {
    defaultValue: false
  });
  if (!runSearch) {
    return;
  }

  const handle = username.replace(/^@/, "");
  const query = `from:${handle} -is:retweet`;
  const result = await runXurl(["search", query, "-n", "3"], { timeoutMs: 20_000 });
  if (!result.ok) {
    io.output.write("Search smoke test failed. This may be due to X API plan access.\n");
  }
  printProcessOutput(result.stdout, result.stderr, io);
}

function printHermesMcpConfig(io: PromptIo): void {
  io.output.write("\nHermes MCP server config:\n");
  io.output.write(`${JSON.stringify(getHermesMcpConfig(), null, 2)}\n`);
}

function printProcessOutput(stdout: string, stderr: string, io: PromptIo): void {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (output) {
    io.output.write(`${output}\n`);
  }
}

export function relativeToCwd(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative.startsWith("..") ? filePath : relative;
}
