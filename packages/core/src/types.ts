export type Transport = "stdio" | "http";
export type Lifecycle = "keep-alive" | "on-demand";

export interface OAuthSettings {
  clientId?: string;
  /** May be a credential template such as {{op://vault/item/field}}. */
  clientSecret?: string;
  scope?: string;
  /** Keep this server's sign-in (encrypted) across restarts. Unset follows the "remember sign-ins" setting. */
  remember?: boolean;
}

/** Persisted definition of one proxied MCP server. Never contains resolved secrets. */
export interface ServerConfig {
  /** URL-safe slug, used in /mcp/<id>. */
  id: string;
  name: string;
  description?: string;
  /** The user's own free-form notes about this server. Shown on its card; never sent anywhere. */
  notes?: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "none" | "oauth";
  oauth?: OAuthSettings;
  /** Whether the hub may connect to this server (startup and on demand). */
  enabled: boolean;
  lifecycle: Lifecycle;
  /** on-demand only: disconnect after this many idle minutes. 0 = never. */
  idleTimeoutMinutes?: number;
}

export type SourceType = "1password" | "keychain" | "vault" | "manual" | "env";

export interface SourceConfig {
  id: string;
  type: SourceType;
  name: string;
  enabled: boolean;
  options: Record<string, string>;
}

export interface Settings {
  port: number;
  /** Keep OAuth sign-ins (encrypted) across restarts, for servers that don't choose for themselves. */
  rememberSignIns: boolean;
  /** Seconds a remembered sign-in is kept after it was last signed in or renewed. 0 = until the user forgets it. */
  signInTtlSeconds: number;
  /** Seconds a resolved secret stays in memory. 0 = until the user forgets everything or the hub quits. */
  cacheTtlSeconds: number;
  /** Internal: set once the old 1-hour default has been migrated to "until locked". */
  cacheTtlMigrated?: boolean;
  /** Internal: set once the 1Password and keychain sources have been added automatically. */
  sourcesAutoConfigured?: boolean;
  /** Internal: set once a Vault source has been added automatically (only for people with VAULT_ADDR set). */
  vaultAutoConfigured?: boolean;
  /** After the user denies a credential prompt, wait this many seconds before asking again. */
  denialCooldownSeconds: number;
  /** Require "Authorization: Bearer <clientToken>" on /mcp endpoints. */
  requireClientToken: boolean;
  /** Let clients reach /mcp/* over localhost HTTP with no approval (they would otherwise use the bridge). */
  allowTcpMcp: boolean;
  clientToken: string;
  /** Days of usage history to keep. */
  retentionDays: number;
  notifyOnCredentialPrompt: boolean;
  onboarded: boolean;
  /** The user confirmed they saved their encryption recovery key. */
  recoveryKeySaved: boolean;
}

export interface PersistedConfig {
  version: 1;
  servers: ServerConfig[];
  sources: SourceConfig[];
  settings: Settings;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "needs-auth" | "error";

export type CredentialState = "none" | "resolving" | "ok" | "failed";

export interface ServerStatus {
  id: string;
  config: ServerConfig;
  state: ConnectionState;
  /** True once connected AND (credentials resolved OR none needed OR OAuth completed). */
  authenticated: boolean;
  credentials: CredentialState;
  /** Client sessions currently attached. */
  activeSessions: number;
  inFlight: number;
  /** True when a request was served in the last 10 seconds or one is in flight. */
  inUse: boolean;
  clients: ServerClient[];
  lastActivityAt: number | null;
  connectedAt: number | null;
  error?: string;
  authUrl?: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  toolCount?: number;
  /** Bytes since the hub started. */
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
  mcpUrl: string;
}

export interface UsageTotals {
  serverId: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface UsagePoint {
  t: number;
  serverId: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
}

export interface ClientUsage {
  /** App name; "" means the traffic was recorded before apps were tracked. */
  client: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
}

/** Identifies the app on the other end of a downstream session. */
export interface ClientRef {
  id: string;
  name: string;
}

/** An app attached to a server right now. */
export interface ServerClient {
  id: string;
  name: string;
  sessions: number;
  inFlight: number;
  /** In flight now, or active within the last few seconds. */
  active: boolean;
  lastActivityAt: number | null;
}

export interface ToolUsage {
  serverId: string;
  tool: string;
  calls: number;
  errors: number;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 47615,
  rememberSignIns: false,
  signInTtlSeconds: 30 * 86400,
  cacheTtlSeconds: 0,
  denialCooldownSeconds: 10,
  requireClientToken: false,
  // Unix sockets need no flag; Windows has no socket support yet, so it keeps the HTTP endpoint on.
  allowTcpMcp: process.platform === "win32",
  clientToken: "",
  retentionDays: 30,
  notifyOnCredentialPrompt: true,
  onboarded: false,
  recoveryKeySaved: false,
};
