export type ConnectionState = "disconnected" | "connecting" | "connected" | "needs-auth" | "error";
export type SourceType = "1password" | "keychain" | "vault" | "manual" | "env";

export interface ServerConfig {
  id: string;
  name: string;
  description?: string;
  notes?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "none" | "oauth";
  oauth?: { clientId?: string; clientSecret?: string; scope?: string; remember?: boolean };
  enabled: boolean;
  lifecycle: "keep-alive" | "on-demand";
  idleTimeoutMinutes?: number;
}

export interface ServerClient {
  id: string;
  name: string;
  sessions: number;
  inFlight: number;
  active: boolean;
  lastActivityAt: number | null;
}

export interface ClientUsage {
  /** "" means traffic recorded before apps were tracked. */
  client: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
}

export interface ServerStatus {
  id: string;
  config: ServerConfig;
  state: ConnectionState;
  authenticated: boolean;
  credentials: "none" | "resolving" | "ok" | "failed";
  activeSessions: number;
  inFlight: number;
  inUse: boolean;
  clients: ServerClient[];
  lastActivityAt: number | null;
  connectedAt: number | null;
  error?: string;
  authUrl?: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  toolCount?: number;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
  mcpUrl: string;
}

export interface SourceConfig {
  id: string;
  type: SourceType;
  name: string;
  enabled: boolean;
  options: Record<string, string>;
}

export interface Settings {
  port: number;
  rememberSignIns: boolean;
  signInTtlSeconds: number;
  cacheTtlSeconds: number;
  denialCooldownSeconds: number;
  requireClientToken: boolean;
  allowTcpMcp: boolean;
  clientToken: string;
  retentionDays: number;
  notifyOnCredentialPrompt: boolean;
  onboarded: boolean;
  recoveryKeySaved: boolean;
}

export interface ClientInfo {
  id: string;
  name: string;
  pid: number;
  path: string;
  status: "pending" | "allowed" | "denied";
  since: number;
  lastSeen: number;
  requests: number;
  servers: string[];
}

export interface ImportApp {
  client: string;
  path: string;
}

export interface Snapshot {
  version: string;
  platform: string;
  port: number;
  baseUrl: string;
  shim: { command: string; args: string[] } | null;
  socket: string | null;
  clients: ClientInfo[];
  servers: ServerStatus[];
  sources: SourceConfig[];
  credentials: {
    cached: Array<{ ref: string; sourceId: string; expiresAt: number | null; fetchedAt: number }>;
    reading: Array<{ ref: string; requester: string; sourceName: string; sourceType: SourceType; startedAt: number }>;
    manualSecrets: string[];
    /** OAuth sign-ins saved (encrypted) so a restart doesn't need a new browser sign-in. `available` is false when there is no safe place to keep them. */
    signIns: { available: boolean; remembered: Array<{ serverId: string; savedAt: number; accessExpiresAt?: number; refreshable: boolean }> };
    /** How secrets are protected: the cipher, where its key lives, and whether they can be saved to disk. */
    encryption: { algorithm: string; keyStore: string; persistent: boolean; problem?: string; locked: boolean };
  };
  settings: Settings;
  environment: { vaultAddress: string | null };
}

export interface LogLine {
  t: number;
  level: "info" | "warn" | "error" | "stderr";
  text: string;
}

export type UsageRange = "1h" | "24h" | "7d" | "30d";

export interface UsageResult {
  range: UsageRange;
  bucketMs: number;
  since: number;
  points: Array<{ t: number; serverId: string; bytesIn: number; bytesOut: number; requests: number; errors: number }>;
  totals: Array<{ serverId: string; bytesIn: number; bytesOut: number; requests: number; errors: number; avgLatencyMs: number; p95LatencyMs: number }>;
  tools: Array<{ serverId: string; tool: string; calls: number; errors: number }>;
  clients: ClientUsage[];
}

export interface ImportSource {
  client: string;
  path: string;
  servers: Array<{ name: string; config?: ServerConfig; viaHub?: boolean }>;
}

export interface InstallResult {
  client: string;
  path: string;
  status: "added" | "replaced" | "already" | "conflict" | "no-file" | "error";
  message: string;
  backup?: string;
}

/** What installing would do to one app's config, before anything is changed. */
export interface InstallPreview {
  client: string;
  path: string;
  status: "add" | "replace" | "already" | "conflict" | "no-file" | "error";
  message: string;
  /** Entries that would be replaced; `summary` is the command or URL, never arguments or headers. */
  existing: Array<{ key: string; summary: string }>;
}

/** Installing several servers into one app: one entry per server. */
export interface AppInstallPreview {
  client: string;
  path: string;
  servers: Array<{ serverId: string; status: InstallPreview["status"]; message: string; existing: InstallPreview["existing"] }>;
}

export interface AppInstallResult {
  client: string;
  path: string;
  /** Copy of the file as it was before it changed; one for the whole batch. */
  backup?: string;
  servers: Array<{ serverId: string; status: InstallResult["status"]; message: string }>;
}

export interface MigrateResponse {
  servers: Array<{ name: string; id: string; mode: "added" | "replaced" | "reused" }>;
  /** Servers MCP Hub couldn't get running. `blocked` ones were left as the app had them. */
  problems?: Array<{ name: string; id: string; reason: string; blocked: boolean }>;
  config: InstallResult & { migrated: string[]; skipped: Array<{ name: string; reason: string }> };
}

export interface SetupStatus {
  sourceId: string;
  type: SourceType;
  ready: boolean;
  detail: string;
  version?: string;
  path?: string;
  canInstall?: boolean;
  canSignIn?: boolean;
  signInMethod?: string;
  help?: { title: string; steps: string[]; commands: string[]; links: Array<{ label: string; url: string }> };
}
