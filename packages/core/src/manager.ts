import { EventEmitter } from "node:events";
import { join } from "node:path";
import { CredentialBroker } from "./credentials/broker.js";
import { LogBuffer } from "./logs.js";
import type { ChildRegistry } from "./children.js";
import type { Metrics } from "./metrics.js";
import type { SignInStore } from "./credentials/signins.js";
import type { ConfigStore } from "./store.js";
import { validateServer } from "./store.js";
import type { ServerConfig, ServerStatus } from "./types.js";
import { UpstreamConnection } from "./upstream.js";

export interface ManagerOptions {
  store: ConfigStore;
  broker: CredentialBroker;
  metrics: Metrics;
  /** Port the HTTP server is actually listening on. */
  getPort: () => number;
  baseEnv: () => NodeJS.ProcessEnv;
  /** Folder for per-server log files. Omit to keep logs in memory only. */
  logDir?: string;
  /** Where remembered OAuth sign-ins are kept. */
  signIns?: SignInStore;
  /** Remembers started stdio servers so a later start can stop leftovers from a crash. */
  children?: ChildRegistry;
}

/** Owns every upstream connection and keeps them in line with the persisted config. */
export class HubManager extends EventEmitter {
  private readonly conns = new Map<string, UpstreamConnection>();
  private readonly logs = new Map<string, LogBuffer>();
  private changeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ManagerOptions) {
    super();
    for (const cfg of opts.store.servers) this.createConnection(cfg);
    opts.broker.on("change", () => this.scheduleChange());
  }

  private origin(): string {
    return `http://127.0.0.1:${this.opts.getPort()}`;
  }

  mcpUrl = (id: string): string => `${this.origin()}/mcp/${id}`;
  callbackUrl = (): string => `${this.origin()}/oauth/callback`;

  private createConnection(cfg: ServerConfig): UpstreamConnection {
    const logs = new LogBuffer(500, this.opts.logDir ? join(this.opts.logDir, `${cfg.id}.jsonl`) : undefined, this.opts.broker.box);
    logs.on("line", (line) => this.emit("log", { serverId: cfg.id, line }));
    const conn = new UpstreamConnection(cfg, {
      broker: this.opts.broker,
      metrics: this.opts.metrics,
      logs,
      baseEnv: this.opts.baseEnv,
      callbackUrl: this.callbackUrl,
      mcpUrl: this.mcpUrl,
      reveal: (c) => this.opts.store.reveal(c),
      signIns: this.opts.signIns,
      children: this.opts.children,
      rememberSignIn: (c) => c.oauth?.remember ?? this.opts.store.settings.rememberSignIns,
    });
    conn.on("change", () => this.scheduleChange());
    conn.on("config-changed", (next: ServerConfig) => this.opts.store.upsertServer(next));
    conn.on("needs-auth", (url?: string) => this.emit("needs-auth", { serverId: cfg.id, url }));
    this.conns.set(cfg.id, conn);
    this.logs.set(cfg.id, logs);
    return conn;
  }

  /** Coalesce bursts of changes into one event. */
  notifyChange(): void {
    this.scheduleChange();
  }

  private scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("change");
    }, 120);
    this.changeTimer.unref();
  }

  get(id: string): UpstreamConnection | undefined {
    return this.conns.get(id);
  }

  list(): ServerStatus[] {
    return this.opts.store.servers.map((s) => this.conns.get(s.id)!.status());
  }

  /** Connect everything that is enabled and keep-alive. Failures are recorded per server. */
  async start(): Promise<void> {
    const tasks = this.opts.store.servers
      .filter((s) => s.enabled && s.lifecycle === "keep-alive")
      .map((s) => this.conns.get(s.id)!.connect().catch(() => {}));
    await Promise.all(tasks);
  }

  async add(cfg: ServerConfig): Promise<ServerStatus> {
    const err = validateServer(cfg);
    if (err) throw new HttpError(400, err);
    if (this.conns.has(cfg.id)) throw new HttpError(409, `A server with id "${cfg.id}" already exists`);
    if (typeof cfg.notes === "string" && !cfg.notes.trim()) delete cfg.notes;
    this.opts.store.upsertServer(cfg);
    const conn = this.createConnection(this.opts.store.getServer(cfg.id)!);
    if (cfg.enabled && cfg.lifecycle === "keep-alive") void conn.connect().catch(() => {});
    this.scheduleChange();
    return conn.status();
  }

  async update(id: string, patch: Partial<ServerConfig>): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    const next: ServerConfig = { ...this.opts.store.reveal(conn.config), ...patch, id };
    // An emptied notes box means no notes, not an empty string kept in the config.
    if (typeof next.notes === "string" && !next.notes.trim()) delete next.notes;
    const err = validateServer(next);
    if (err) throw new HttpError(400, err);
    const wasConnected = conn.state === "connected" || conn.state === "connecting";
    this.opts.store.upsertServer(next);
    conn.updateConfig(this.opts.store.getServer(id)!);
    conn.syncRememberedSignIn();
    const stored = this.opts.store.getServer(id)!;
    if (wasConnected || (stored.enabled && stored.lifecycle === "keep-alive")) {
      await conn.disconnect();
      if (stored.enabled && (wasConnected || stored.lifecycle === "keep-alive")) void conn.connect().catch(() => {});
    } else if (!stored.enabled && conn.state !== "disconnected") {
      await conn.disconnect();
    }
    return conn.status();
  }

  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    await conn.disconnect();
    conn.forgetSignIn();
    this.conns.delete(id);
    this.logs.get(id)?.destroy();
    this.logs.delete(id);
    this.opts.store.removeServer(id);
    this.opts.metrics.forget(id);
    this.scheduleChange();
  }

  /** The "remember sign-ins" default changed: save or delete sign-ins of the servers that follow it. */
  syncRememberedSignIns(): void {
    for (const conn of this.conns.values()) conn.syncRememberedSignIn();
    this.scheduleChange();
  }

  /** Zero the running totals shown on the server cards (all servers, or one). */
  resetStats(serverId?: string): void {
    for (const [id, conn] of this.conns) if (!serverId || id === serverId) conn.resetStats();
    this.scheduleChange();
  }

  /** Pick up servers that were changed in the store behind the manager's back (key recovery). */
  async refreshFromStore(ids: string[]): Promise<void> {
    for (const id of ids) {
      const conn = this.conns.get(id);
      const cfg = this.opts.store.getServer(id);
      if (!conn || !cfg) continue;
      conn.updateConfig(cfg);
      if (!cfg.enabled) await conn.disconnect();
    }
    this.scheduleChange();
  }

  /** Servers that failed only because their credentials couldn't be read get another go. */
  retryCredentialFailures(): void {
    for (const conn of this.conns.values()) {
      const s = conn.status();
      if (s.state === "error" && s.credentials === "failed" && s.config.enabled) void conn.connect().catch(() => {});
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    this.opts.store.upsertServer({ ...conn.config, enabled });
    conn.updateConfig({ ...conn.config, enabled });
    if (enabled) {
      // Fire and forget: the UI follows the "connecting" state through events.
      void conn.connect().catch(() => {});
    } else {
      await conn.disconnect();
    }
    return conn.status();
  }

  async restart(id: string): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    await conn.disconnect();
    void conn.connect().catch(() => {});
    return conn.status();
  }

  /** Begin (or resume) an OAuth sign-in. Returns the URL to open in the browser. */
  async beginSignIn(id: string): Promise<string> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    if (conn.config.auth !== "oauth") throw new HttpError(400, "This server does not use OAuth");
    if (conn.state !== "needs-auth" || !conn.authUrl) {
      await conn.disconnect();
      await conn.connect().catch(() => {});
    }
    if (conn.state === "connected") throw new HttpError(409, "Already signed in");
    const url = conn.authUrl;
    if (!url) throw new HttpError(502, conn.error ?? "The server did not provide a sign-in URL");
    return url;
  }

  async signOut(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    await conn.signOut();
  }

  /** Route an OAuth redirect to whichever connection started it (matched by `state`). */
  async handleOAuthCallback(code: string, state: string | null): Promise<string> {
    for (const conn of this.conns.values()) {
      if (conn.state !== "needs-auth") continue;
      try {
        await conn.completeAuth(code, state);
        return conn.config.name;
      } catch (err) {
        if ((err as Error).message === "OAuth state mismatch" || (err as Error).message.startsWith("No sign-in")) continue;
        throw err;
      }
    }
    throw new HttpError(400, "No server is waiting for this sign-in. Start it again from MCP Hub.");
  }

  logsFor(id: string): LogBuffer | undefined {
    return this.logs.get(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.disconnect().catch(() => {})));
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
