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
  /**
   * The user's own labels ("work", "personal"), used to filter the cards and to turn a group of servers on or off
   * together. Trimmed, unique ignoring case, and spelled like the same label on other servers; none is left out.
   */
  labels?: string[];
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
  /** Days of usage and activity history to keep. */
  retentionDays: number;
  notifyOnCredentialPrompt: boolean;
  /**
   * Read the secrets of start-when-needed servers when MCP Hub starts, so the password manager asks once, up front,
   * while you are looking. Off by default: nothing is read until a server is actually wanted.
   */
  preloadSecrets: boolean;
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
  // Apps reach the hub over a local socket (a Unix socket, or a named pipe on Windows), so the HTTP endpoint is opt-in.
  allowTcpMcp: false,
  clientToken: "",
  retentionDays: 30,
  notifyOnCredentialPrompt: true,
  preloadSecrets: false,
  onboarded: false,
  recoveryKeySaved: false,
};

/** The range each numeric setting accepts. Anything outside it (or not a number) falls back to the default. */
export const SETTING_LIMITS = {
  port: [1024, 65535],
  cacheTtlSeconds: [0, 30 * 86400],
  signInTtlSeconds: [0, 365 * 86400],
  denialCooldownSeconds: [0, 3600],
  retentionDays: [1, 3650],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

const BOOLEAN_SETTINGS = ["rememberSignIns", "requireClientToken", "allowTcpMcp", "notifyOnCredentialPrompt", "preloadSecrets", "onboarded", "recoveryKeySaved"] as const;

/**
 * Turns whatever was saved (an older version's file, a hand-edited one) into settings that are all valid.
 * A missing, mistyped or out-of-range value becomes its default, so every setting always has a sane value.
 */
export function normalizeSettings(saved: Partial<Record<keyof Settings, unknown>> | undefined): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) };
  for (const [key, [min, max]] of Object.entries(SETTING_LIMITS) as Array<[keyof typeof SETTING_LIMITS, readonly [number, number]]>) {
    const v = out[key];
    out[key] = typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : DEFAULT_SETTINGS[key];
  }
  for (const key of BOOLEAN_SETTINGS) if (typeof out[key] !== "boolean") out[key] = DEFAULT_SETTINGS[key];
  if (typeof out.clientToken !== "string") out.clientToken = DEFAULT_SETTINGS.clientToken;
  return out;
}
