import { EventEmitter } from "node:events";
import { join } from "node:path";
import { CredentialBroker } from "./credentials/broker.js";
import type { History } from "./history.js";
import { LogBuffer } from "./logs.js";
import type { ChildRegistry } from "./children.js";
import type { Metrics } from "./metrics.js";
import type { SignInStore } from "./credentials/signins.js";
import type { ConfigStore } from "./store.js";
import { hasLabel, tidyLabels, validateServer } from "./store.js";
import type { ServerConfig, ServerStatus } from "./types.js";
import { UpstreamConnection, type LifecycleEvent } from "./upstream.js";

export interface ManagerOptions {
  store: ConfigStore;
  broker: CredentialBroker;
  metrics: Metrics;
  /** Where server starts, stops and changes are recorded for the user. */
  history?: History;
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
  private readonly lastServerAction = new Map<string, string>();

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
    conn.on("lifecycle", (e: LifecycleEvent) => this.recordLifecycle(cfg.id, e));
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

  /** Say in plain words what a connection just did. A run of identical events (a failing server retrying) is one entry. */
  private recordLifecycle(id: string, e: LifecycleEvent): void {
    const conn = this.conns.get(id);
    if (!this.opts.history || !conn) return;
    let action: string;
    if (e.to === "connected") action = "started";
    else if (e.to === "disconnected" && e.from === "connected") action = e.idle ? "idle-stop" : "stopped";
    else if (e.to === "error" && (e.from === "connecting" || e.from === "connected")) action = "failed";
    else if (e.to === "needs-auth") action = "needs-sign-in";
    else return;
    if (this.lastServerAction.get(id) === action) return;
    this.lastServerAction.set(id, action);
    const mins = conn.config.idleTimeoutMinutes ?? 0;
    this.opts.history.record({
      kind: "server",
      action,
      serverId: id,
      serverName: conn.config.name,
      trigger: action === "started" ? e.trigger : "",
      detail: action === "idle-stop" && mins > 0 ? `${mins} min` : "",
    });
  }

  /** Servers that use credentials and only start when something needs them (always-on ones read theirs as they start). */
  private preloadCandidates(): UpstreamConnection[] {
    return this.opts.store.servers
      .filter((s) => s.enabled && s.lifecycle === "on-demand")
      .map((s) => this.conns.get(s.id)!)
      .filter((c) => c.state === "disconnected" && c.usesCredentials());
  }

  /**
   * Read the secrets of start-when-needed servers ahead of time, so their first start doesn't wait on a password
   * manager. `announce` runs before anything is read so the user is told what is about to happen.
   */
  async preloadSecrets(trigger: string, announce: (serverNames: string[]) => void): Promise<number> {
    const conns = this.preloadCandidates();
    if (!conns.length) return 0;
    announce(conns.map((c) => c.config.name));
    for (const c of conns) await c.preloadCredentials(trigger);
    return conns.length;
  }

  /** Connect everything that is enabled and keep-alive. Failures are recorded per server. */
  async start(): Promise<void> {
    const tasks = this.opts.store.servers
      .filter((s) => s.enabled && s.lifecycle === "keep-alive")
      .map((s) => this.conns.get(s.id)!.connect("MCP Hub started").catch(() => {}));
    await Promise.all(tasks);
  }

  /** Every label in use on servers other than `exceptId`, for spelling a new label like the existing one. */
  private knownLabels(exceptId?: string): string[] {
    return this.opts.store.servers.filter((s) => s.id !== exceptId).flatMap((s) => s.labels ?? []);
  }

  private setLabels(cfg: ServerConfig): void {
    const labels = tidyLabels(cfg.labels, this.knownLabels(cfg.id)) as string[] | undefined;
    if (labels === undefined) delete cfg.labels;
    else cfg.labels = labels;
  }

  /**
   * Would this edit change how the server runs? Its name, description, notes and labels don't, so changing only
   * those leaves the server and the apps attached to it alone.
   */
  changesConnection(id: string, patch: Partial<ServerConfig>): boolean {
    const conn = this.conns.get(id);
    if (!conn) return true;
    const before = this.opts.store.reveal(conn.config);
    return runSignature(before) !== runSignature({ ...before, ...patch, id });
  }

  async add(cfg: ServerConfig): Promise<ServerStatus> {
    this.setLabels(cfg);
    const err = validateServer(cfg);
    if (err) throw new HttpError(400, err);
    if (this.conns.has(cfg.id)) throw new HttpError(409, `A server with id "${cfg.id}" already exists`);
    if (typeof cfg.notes === "string" && !cfg.notes.trim()) delete cfg.notes;
    for (const k of ["headers", "env"] as const) if (cfg[k] && !Object.keys(cfg[k]!).length) delete cfg[k];
    this.opts.store.upsertServer(cfg);
    const conn = this.createConnection(this.opts.store.getServer(cfg.id)!);
    this.opts.history?.record({ kind: "config", action: "added", serverId: cfg.id, serverName: cfg.name });
    if (cfg.enabled && cfg.lifecycle === "keep-alive") void conn.connect("You added this server").catch(() => {});
    this.scheduleChange();
    return conn.status();
  }

  async update(id: string, patch: Partial<ServerConfig>): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    const next: ServerConfig = { ...this.opts.store.reveal(conn.config), ...patch, id };
    // An emptied notes box means no notes, not an empty string kept in the config.
    if (typeof next.notes === "string" && !next.notes.trim()) delete next.notes;
    // Likewise, removing every header or variable leaves none, not an empty object.
    for (const k of ["headers", "env"] as const) if (next[k] && !Object.keys(next[k]!).length) delete next[k];
    this.setLabels(next);
    const err = validateServer(next);
    if (err) throw new HttpError(400, err);
    const restart = this.changesConnection(id, patch);
    const wasConnected = conn.state === "connected" || conn.state === "connecting";
    this.opts.store.upsertServer(next);
    conn.updateConfig(this.opts.store.getServer(id)!);
    conn.syncRememberedSignIn();
    this.opts.history?.record({ kind: "config", action: "changed", serverId: id, serverName: next.name });
    if (!restart) return conn.status();
    const stored = this.opts.store.getServer(id)!;
    if (wasConnected || (stored.enabled && stored.lifecycle === "keep-alive")) {
      await conn.disconnect();
      if (stored.enabled && (wasConnected || stored.lifecycle === "keep-alive")) void conn.connect("You changed this server").catch(() => {});
    } else if (!stored.enabled && conn.state !== "disconnected") {
      await conn.disconnect();
    }
    return conn.status();
  }

  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    const name = conn.config.name;
    await conn.disconnect();
    conn.forgetSignIn();
    this.conns.delete(id);
    this.lastServerAction.delete(id);
    this.logs.get(id)?.destroy();
    this.logs.delete(id);
    this.opts.store.removeServer(id);
    this.opts.metrics.forget(id);
    this.opts.history?.record({ kind: "config", action: "removed", serverId: id, serverName: name });
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
      if (s.state === "error" && s.credentials === "failed" && s.config.enabled) void conn.connect("Credential settings changed").catch(() => {});
    }
  }

  async setEnabled(id: string, enabled: boolean, trigger = "You turned it on"): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    this.opts.store.upsertServer({ ...conn.config, enabled });
    conn.updateConfig({ ...conn.config, enabled });
    if (enabled) {
      // Fire and forget: the UI follows the "connecting" state through events.
      void conn.connect(trigger).catch(() => {});
    } else {
      await conn.disconnect();
    }
    return conn.status();
  }

  /**
   * Turn a labeled group of servers on or off, or every server when `label` is null. "only" works like switching
   * profiles: the servers with the label are turned on and every other server is turned off. Returns the names of
   * the servers that changed.
   */
  async applyLabel(label: string | null, action: LabelAction): Promise<{ label: string | null; on: string[]; off: string[] }> {
    const servers = this.opts.store.servers;
    let named: string | null = null;
    if (label !== null) {
      named = servers.flatMap((s) => s.labels ?? []).find((l) => l.toLowerCase() === label.trim().toLowerCase()) ?? null;
      if (!named) throw new HttpError(404, `No server has the label "${label.trim()}"`);
    } else if (action === "only") {
      throw new HttpError(400, "A label is required to switch to it");
    }
    const inGroup = (s: ServerConfig) => named === null || hasLabel(s, named);
    const want = (s: ServerConfig) => (action === "only" ? inGroup(s) : inGroup(s) ? action === "on" : s.enabled);
    const on = servers.filter((s) => !s.enabled && want(s));
    const off = servers.filter((s) => s.enabled && !want(s));
    const trigger = named === null ? `You turned on all servers` : action === "only" ? `You switched to the "${named}" label` : `You turned on the "${named}" label`;
    await Promise.all([...off.map((s) => this.setEnabled(s.id, false)), ...on.map((s) => this.setEnabled(s.id, true, trigger))]);
    if (on.length || off.length) this.opts.history?.record({ kind: "config", action: named === null ? `all-${action}` : `label-${action}`, detail: named ?? undefined });
    return { label: named, on: on.map((s) => s.name), off: off.map((s) => s.name) };
  }

  async restart(id: string): Promise<ServerStatus> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    await conn.disconnect();
    void conn.connect("You pressed Restart").catch(() => {});
    return conn.status();
  }

  /** Begin (or resume) an OAuth sign-in. Returns the URL to open in the browser. */
  async beginSignIn(id: string): Promise<string> {
    const conn = this.conns.get(id);
    if (!conn) throw new HttpError(404, "No such server");
    if (conn.config.auth !== "oauth") throw new HttpError(400, "This server does not use OAuth");
    if (conn.state !== "needs-auth" || !conn.authUrl) {
      await conn.disconnect();
      await conn.connect("You started signing in").catch(() => {});
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

export type LabelAction = "on" | "off" | "only";

/** Fields that only describe a server for the user; changing them doesn't need a restart. */
const DESCRIPTIVE = new Set<string>(["name", "description", "notes", "labels"]);

/** A stable fingerprint of everything that affects how a server runs. Unset, empty lists and empty maps count as absent. */
function runSignature(cfg: ServerConfig): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.length ? v.map(norm) : undefined;
    if (v && typeof v === "object") {
      const entries = Object.entries(v)
        .map(([k, x]) => [k, norm(x)] as const)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return v;
  };
  return JSON.stringify(norm(Object.fromEntries(Object.entries(cfg).filter(([k]) => !DESCRIPTIVE.has(k)))) ?? null);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
