export type CheckStatus = "ok" | "warn" | "error";

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface ActiveHours {
  start: string;
  end: string;
  timezone: string;
}

export interface XHermesConfig {
  xurlApp: string;
  username: string;
  activeHours: ActiveHours;
  maxRepliesPerDay: number;
  replyTextDefault: string;
  postingEnabled: boolean;
  perAuthorCooldownHours: number;
  requireApprovalForKeywordSearch: boolean;
  requireOptInForAutoPost: boolean;
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: XHermesConfig;
}

export interface StatusReport {
  ready: boolean;
  configPath: string;
  dataDir: string;
  checks: DiagnosticCheck[];
  config?: XHermesConfig;
}

export interface ProcessResult {
  command: string[];
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SetupOptions {
  checkOnly: boolean;
  withHermes: boolean;
  nonInteractive: boolean;
  json: boolean;
}

export interface StatusOptions {
  withHermes: boolean;
}

export const DEFAULT_CONFIG: XHermesConfig = {
  xurlApp: "x-hermes",
  username: "",
  activeHours: {
    start: "09:00",
    end: "21:00",
    timezone: "America/New_York"
  },
  maxRepliesPerDay: 120,
  replyTextDefault: "Configure this per project",
  postingEnabled: false,
  perAuthorCooldownHours: 168,
  requireApprovalForKeywordSearch: true,
  requireOptInForAutoPost: true
};

