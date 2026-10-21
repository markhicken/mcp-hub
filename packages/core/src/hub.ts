import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { ClientGate, type GateOptions } from "./clients.js";
import { ChildRegistry } from "./children.js";
import { childrenPath } from "./paths.js";
import { SecretBox } from "./credentials/box.js";
import { CredentialBroker, type AccessEvent, type PromptEvent } from "./credentials/broker.js";
import { SignInStore } from "./credentials/signins.js";
import { loadSecretBox, osKeyStore, type KeyStore } from "./credentials/keystore.js";
import { run as runCommand } from "./credentials/exec.js";
import { installOnePasswordCli, type InstalledCli } from "./credentials/op-installer.js";
import { detectSetup } from "./credentials/setup.js";
import { installVaultCli } from "./credentials/vault-installer.js";
import { candidatePaths, knownApps, scanClientConfigs } from "./import.js";
import { buildExport, parseImport, planImport, type ClashChoice } from "./config-transfer.js";
import { installServer, installServers, migrateClientConfig, previewInstall, previewInstallServers } from "./install.js";
import { History, HISTORY_KINDS, type HistoryKind } from "./history.js";
import { HubManager, HttpError } from "./manager.js";
import { McpEndpoint, readJson } from "./mcp-endpoint.js";
import { Metrics, type UsageRange } from "./metrics.js";
import { ConfigStore, slugify } from "./store.js";
import { notify, openExternal, pickSavePath, revealInFileManager } from "./system.js";
import { SETTING_LIMITS, type ServerConfig, type Settings, type SourceConfig, type SourceType } from "./types.js";
import { detectAdHocSigning } from "./signing.js";
import { VERSION } from "./version.js";

type Msg = Record<string, any>;

/** Server fields that a replacement starts from scratch on, so nothing of the old definition lingers. */
const RESET_FIELDS = ["description", "command", "args", "env", "cwd", "url", "headers", "auth", "oauth"] as const;
/** Replacing from an exported file also takes the file's notes and idle timeout (or clears them). */
const RESET_FROM_FILE = [...RESET_FIELDS, "notes", "idleTimeoutMinutes"] as const;

export interface HubOptions {
  dataDir: string;
  /** Per-run secret shared with the UI. Required for every /api call. */
  uiToken: string;
  metricsPath: string;
  /** Replaces the check for an ad-hoc signed app (tests). */
  detectAdHocSigning?: () => Promise<boolean>;
  /** Where the plain-language activity history is kept. Defaults to next to the usage database (in memory for ":memory:"). */
  historyPath?: string;
  configPath: string;
  uiDir?: string;
  /** Command clients can use to launch the stdio shim. */
  shim?: { command: string; args: string[] };
  baseEnv?: () => NodeJS.ProcessEnv;
  /** Extra allowed browser origins (dev server). */
  extraOrigins?: string[];
  /** Disable OS notifications (tests). */
  quiet?: boolean;
  /** Unix socket that approved apps connect through (macOS and Linux). */
  socketPath?: string;
  /** Overrides for how connecting apps are identified (tests). */
  gate?: GateOptions;
  /** Replaces the 1Password CLI download (tests). */
  installOnePasswordCli?: (toolsDir: string) => Promise<InstalledCli>;
  /** Replaces the Vault CLI download (tests). */
  installVaultCli?: (toolsDir: string) => Promise<InstalledCli>;
  /** Where the master encryption key is kept. Defaults to the OS keychain; tests pass an in-memory one. */
  keyStore?: KeyStore;
  /** Shows a "Save As" dialog: the chosen path, null if cancelled, undefined if the platform has none. Tests replace it. */
  pickSavePath?: (suggestedName: string, prompt: string) => Promise<string | null | undefined>;
  /** Shows a file in the file manager. Tests replace it. */
  reveal?: (path: string) => void;
}

const SOURCE_TYPES: SourceType[] = ["1password", "keychain", "vault", "manual", "env"];
const RANGES: UsageRange[] = ["1h", "24h", "7d", "30d"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

export class Hub {
  readonly store: ConfigStore;
  readonly broker: CredentialBroker;
  readonly signIns: SignInStore;
  readonly children: ChildRegistry;
  private signInSweeper?: NodeJS.Timeout;
  readonly metrics: Metrics;
  readonly history: History;
  private historyPruner?: NodeJS.Timeout;
  /** Whether this is the packaged app signed ad hoc; only ever used to show an explanation. */
  private adHocSigned = false;
  readonly manager: HubManager;
  readonly endpoint: McpEndpoint;
  readonly clients: ClientGate;
  private server?: Server;
  private socketServer?: Server;
  private listeningPort = 0;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly lastNotify = new Map<string, number>();
  private historyPing?: NodeJS.Timeout;
  private baseEnvCache: () => NodeJS.ProcessEnv;
  private readonly keyStore: KeyStore;
  private readonly box: SecretBox;
  private installs = new Map<string, Promise<InstalledCli>>();
  /** The last file the user saved an export to; the only file "show in Finder" will reveal. */
  private lastExportPath?: string;

  constructor(private readonly opts: HubOptions) {
    this.baseEnvCache = opts.baseEnv ?? (() => process.env);
    // The master key lives in the OS key store, never in MCP Hub's own files. A new one is only made on the very
    // first run: if sealed data already exists, a missing key is reported instead of silently replaced.
    const secretsPath = join(opts.dataDir, "secrets.json");
    const signInsPath = join(opts.dataDir, "signins.json");
    this.keyStore = opts.keyStore ?? osKeyStore();
    const box = loadSecretBox(this.keyStore, { allowCreate: !ConfigStore.hasSealed(opts.configPath) && !existsSync(secretsPath) && !existsSync(signInsPath) });
    this.box = box;
    this.store = new ConfigStore(opts.configPath, box);
    this.signIns = new SignInStore(box, signInsPath, () => this.store.settings.signInTtlSeconds);
    this.children = new ChildRegistry(childrenPath(opts.dataDir));
    this.signIns.prune(this.store.servers.map((s) => s.id));
    this.signInSweeper = setInterval(() => {
      if (this.signIns.expire()) this.manager.notifyChange();
    }, 60_000);
    this.signInSweeper.unref();
    this.autoConfigureVault();
    this.metrics = new Metrics(opts.metricsPath);
    this.history = new History(opts.historyPath ?? (opts.metricsPath === ":memory:" ? ":memory:" : join(dirname(opts.metricsPath), "history.sqlite")));
    this.history.onChange(() => this.scheduleHistoryPing());
    this.broker = new CredentialBroker({
      getSources: () => this.store.sources,
      getCacheTtlSeconds: () => this.store.settings.cacheTtlSeconds,
      getDenialCooldownSeconds: () => this.store.settings.denialCooldownSeconds,
      env: this.baseEnvCache(),
      box,
      secretsPath,
    });
    this.manager = new HubManager({
      store: this.store,
      broker: this.broker,
      metrics: this.metrics,
      history: this.history,
      getPort: () => this.listeningPort,
      baseEnv: this.baseEnvCache,
      logDir: join(opts.dataDir, "logs"),
      signIns: this.signIns,
      children: this.children,
    });
    this.endpoint = new McpEndpoint(this.manager, this.metrics);
    this.clients = new ClientGate(opts.gate);
    this.clients.on("change", () => this.broadcast("state", this.snapshot()));
    this.clients.on("gone", (id: string, name: string, status: string) => {
      this.endpoint.dropClientSessions(id);
      if (status === "allowed") this.history.record({ kind: "app", action: "left", app: name });
    });
    this.clients.on("pending", (c: { name: string }) => {
      this.history.record({ kind: "app", action: "asked", app: c.name });
      if (!opts.quiet) notify("MCP Hub", `${c.name} wants to use MCP Hub. Open MCP Hub to allow or deny it.`);
    });
    this.clients.on("decided", (c: { name: string; status: string; allowed: string[] | null }, before: string) => {
      const names = (c.allowed ?? []).map((id) => this.manager.get(id)?.config.name).filter((n): n is string => !!n);
      const detail = c.allowed === null ? "every server" : names.length ? names.join(", ") : "no servers";
      const action = c.status === "denied" ? (before === "allowed" ? "revoked" : "denied") : before === "allowed" ? "changed" : "allowed";
      this.history.record({ kind: "app", action, app: c.name, detail });
    });

    this.manager.on("change", () => this.broadcast("state", this.snapshot()));
    this.manager.on("log", (e) => this.broadcast("log", e));
    // Every use of a secret goes in the history, whether it came from the password manager or from memory.
    this.broker.on("access", (a: AccessEvent) => {
      this.history.record({
        kind: "secret",
        action: a.outcome,
        serverId: a.requester,
        serverName: this.manager.get(a.requester)?.config.name ?? a.requester,
        source: a.sourceName,
        trigger: a.trigger,
        outcome: a.outcome,
      });
    });
    this.broker.on("prompt", (p: PromptEvent) => {
      if (opts.quiet || !this.store.settings.notifyOnCredentialPrompt) return;
      // Throttled per server, so a burst of reads for one server is one notification but another server still gets its own.
      const last = this.lastNotify.get(p.requester) ?? 0;
      if (Date.now() - last < 15_000) return;
      this.lastNotify.set(p.requester, Date.now());
      const name = this.manager.get(p.requester)?.config.name ?? p.requester;
      notify("MCP Hub", `"${name}" is requesting a secret from ${p.sourceName}${p.trigger ? ` (${p.trigger})` : ""}`);
    });
  }

  /**
   * People who use Vault already have VAULT_ADDR in their shell. When it is set, add a Vault source that uses it, so
   * {{vault://…}} works with nothing to fill in. Nobody else is shown anything about Vault. Done once, so removing
   * the source later sticks.
   */
  private autoConfigureVault(): void {
    const { store } = this;
    if (store.settings.vaultAutoConfigured) return;
    const env = this.baseEnvCache();
    if (!env.VAULT_ADDR) return;
    if (!store.sources.some((s) => s.type === "vault")) {
      store.upsertSource({ id: "vault", type: "vault", name: "HashiCorp Vault", enabled: true, options: { mount: "secret", kvVersion: "2", tokenSource: env.VAULT_TOKEN ? "env" : "file" } });
    }
    store.updateSettings({ vaultAutoConfigured: true });
  }

  get port(): number {
    return this.listeningPort;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  /** Listen on the preferred port, falling back to a random free one. */
  async listen(preferredPort: number): Promise<number> {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => this.fail(res, err));
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    const tryListen = (port: number) =>
      new Promise<number>((resolveP, reject) => {
        const onError = (e: NodeJS.ErrnoException) => reject(e);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolveP((server.address() as { port: number }).port);
        });
      });
    try {
      this.listeningPort = await tryListen(preferredPort);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      this.listeningPort = await tryListen(0);
    }
    this.server = server;
    await this.listenSocket();
    this.metrics.start();
    void (this.opts.detectAdHocSigning ?? detectAdHocSigning)().then(
      (adHoc) => {
        this.adHocSigned = adHoc;
        if (adHoc) this.manager.notifyChange();
      },
      () => {},
    );
    this.pruneHistory();
    this.historyPruner = setInterval(() => this.pruneHistory(), 3_600_000);
    this.historyPruner.unref();
    return this.listeningPort;
  }

  /** Keep usage and activity history to the "keep history for" setting. */
  private pruneHistory(): void {
    const days = this.store.settings.retentionDays;
    this.metrics.prune(days);
    this.history.prune(days);
  }

  /** Tells open UIs the history changed; bursts become one nudge. */
  private scheduleHistoryPing(): void {
    if (this.historyPing) return;
    this.historyPing = setTimeout(() => {
      this.historyPing = undefined;
      this.broadcast("history", {});
    }, 250);
    this.historyPing.unref();
  }

  /**
   * Start the always-on servers and, if the user asked for it, read the secrets of the start-when-needed ones ahead of
   * time. Reading secrets is never silent: the user is told which servers and why before the first read, and each
   * read lands in the history like any other.
   */
  async startServers(): Promise<void> {
    const preload = this.store.settings.preloadSecrets
      ? this.manager.preloadSecrets("MCP Hub started (loading secrets ahead of time)", (names) => {
          this.history.record({ kind: "preload", action: "announced", detail: `Loading secrets ahead of time for ${names.join(", ")}` });
          if (!this.opts.quiet && this.store.settings.notifyOnCredentialPrompt) notify("MCP Hub", `Loading secrets for ${names.length} server${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
        })
      : Promise.resolve(0);
    await Promise.all([this.manager.start(), preload.catch(() => 0)]);
  }

  /** The socket apps connect through, if it is up. */
  get socket(): string | undefined {
    return this.socketServer ? this.opts.socketPath : undefined;
  }

  private async listenSocket(): Promise<void> {
    const path = this.opts.socketPath;
    if (!path || process.platform === "win32") return;
    // sun_path is limited to about 104 bytes on macOS.
    if (Buffer.byteLength(path) > 100) {
      process.stderr.write(`Socket path is too long, so the local socket is disabled: ${path}\n`);
      return;
    }
    const server = createServer((req, res) => {
      this.routeSocket(req, res).catch((err) => this.fail(res, err));
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    try {
      rmSync(path, { force: true });
      await new Promise<void>((ok, bad) => {
        server.once("error", bad);
        server.listen(path, () => {
          server.off("error", bad);
          ok();
        });
      });
      chmodSync(path, 0o600);
      this.socketServer = server;
    } catch (err) {
      process.stderr.write(`Could not open the local socket: ${(err as Error).message}\n`);
    }
  }

  async stop(): Promise<void> {
    this.endpoint.close();
    this.clients.close();
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    await this.manager.shutdown();
    this.children.prune();
    this.broker.lock();
    this.broker.close();
    if (this.signInSweeper) clearInterval(this.signInSweeper);
    this.signInSweeper = undefined;
    await new Promise<void>((r) => {
      if (!this.socketServer) return r();
      this.socketServer.close(() => r());
      this.socketServer.closeAllConnections?.();
    });
    if (this.opts.socketPath) rmSync(this.opts.socketPath, { force: true });
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections?.();
    });
    this.metrics.close();
    if (this.historyPruner) clearInterval(this.historyPruner);
    this.historyPruner = undefined;
    if (this.historyPing) clearTimeout(this.historyPing);
    this.historyPing = undefined;
    this.history.close();
  }

  // ------------------------------------------------------------------ security

  private hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const p = this.listeningPort;
    return host === `127.0.0.1:${p}` || host === `localhost:${p}` || host === `[::1]:${p}`;
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const p = this.listeningPort;
    const own = [`http://127.0.0.1:${p}`, `http://localhost:${p}`];
    return own.includes(origin) || (this.opts.extraOrigins ?? []).includes(origin);
  }

  private bearer(req: IncomingMessage, url: URL): string {
    const h = req.headers.authorization;
    if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
    return url.searchParams.get("token") ?? "";
  }

  private fail(res: ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, status, { error: status === 500 ? `Internal error: ${message}` : message });
  }

  // ------------------------------------------------------------------ routing

  /** Requests on the local socket: only /mcp/*, and only for apps the user has approved. */
  private async routeSocket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path === "/health") return json(res, 200, { ok: true, app: "mcp-hub", version: VERSION });
    const mcp = /^\/mcp\/([^/]+)\/?$/.exec(path);
    if (!mcp) return json(res, 404, { error: "Not found" });

    const pid = Number(req.headers["x-mcp-hub-pid"]);
    const verdict =
      Number.isInteger(pid) && pid > 1
        ? await this.clients.authorize(pid, decodeURIComponent(mcp[1]!))
        : { status: "denied" as const, reason: "This connection did not identify itself. Connect with the MCP Hub bridge." };
    if (verdict.status === "allowed") {
      const c = verdict.client!;
      return this.endpoint.handle(req, res, decodeURIComponent(mcp[1]!), { id: c.id, name: c.name });
    }

    req.resume();
    const who = verdict.client?.name ?? "This app";
    const message =
      verdict.status === "pending"
        ? `Waiting for you to allow ${who} in MCP Hub.`
        : (verdict.reason ?? `${who} was not allowed to use MCP Hub. Restart ${who} to be asked again, or allow it in MCP Hub → Settings.`);
    json(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32001, message, data: { approval: verdict.status } } });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) return json(res, 403, { error: "Forbidden host" });
    if (!this.originAllowed(req)) return json(res, 403, { error: "Forbidden origin" });
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;

    if (path === "/health") return json(res, 200, { ok: true, app: "mcp-hub", version: VERSION });

    if (path === "/oauth/callback") return this.oauthCallback(url, res);

    const mcp = /^\/mcp\/([^/]+)\/?$/.exec(path);
    if (mcp) {
      const s = this.store.settings;
      if (!s.allowTcpMcp) {
        return json(res, 403, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Direct HTTP access to MCP Hub is turned off. Connect with the MCP Hub bridge (mcp-hub-stdio), or allow it in Settings → Security." },
        });
      }
      if (s.requireClientToken) {
        const t = this.bearer(req, url);
        if (!safeEqual(t, s.clientToken) && !safeEqual(t, this.opts.uiToken)) {
          res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcp-hub"' });
          res.end();
          return;
        }
      }
      return this.endpoint.handle(req, res, decodeURIComponent(mcp[1]!));
    }

    if (path.startsWith("/api/")) {
      if (!safeEqual(this.bearer(req, url), this.opts.uiToken)) return json(res, 401, { error: "Unauthorized" });
      return this.api(req, res, url);
    }

    return this.serveStatic(req, res, path);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const dir = this.opts.uiDir;
    if (!dir || !existsSync(dir)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("MCP Hub is running. The UI bundle was not found.\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    const root = resolve(dir);
    let file = resolve(join(root, normalize(decodeURIComponent(path))));
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    const body = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private async oauthCallback(url: URL, res: ServerResponse): Promise<void> {
    const page = (title: string, body: string, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e8eaf0"><div style="text-align:center;max-width:28rem"><h1 style="font-weight:600">${title}</h1><p style="color:#9aa3b2">${body}</p></div>`,
      );
    };
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const err = url.searchParams.get("error");
    if (err) return page("Sign-in failed", esc(url.searchParams.get("error_description") ?? err), 400);
    const code = url.searchParams.get("code");
    if (!code) return page("Sign-in failed", "The sign-in response was missing a code.", 400);
    try {
      const name = await this.manager.handleOAuthCallback(code, url.searchParams.get("state"));
      page("You're signed in", `${esc(name)} is connected. You can close this tab and return to MCP Hub.`);
    } catch (e) {
      page("Sign-in failed", esc((e as Error).message), (e as HttpError).status ?? 500);
    }
  }

  // ------------------------------------------------------------------ SSE

  private broadcast(event: string, data: unknown): void {
    if (!this.sseClients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) if (!c.writableEnded) c.write(frame);
  }

  snapshot(): Msg {
    const s = this.store.settings;
    return {
      version: VERSION,
      platform: process.platform,
      port: this.listeningPort,
      baseUrl: this.baseUrl,
      shim: this.opts.shim ?? null,
      socket: this.socket ?? null,
      clients: this.clients.list(),
      servers: this.manager.list(),
      sources: this.store.sources,
      credentials: {
        cached: this.broker.cached(),
        reading: this.broker.activeReads(),
        manualSecrets: this.broker.memory.names().filter((n) => !n.startsWith("vault-token/")),
        signIns: { available: this.signIns.available, remembered: this.signIns.list() },
        encryption: { ...this.broker.encryption(), locked: !this.box.persistent && (this.store.hasSealedValues() || this.broker.memory.savedCount() > 0 || this.signIns.savedCount() > 0) },
      },
      settings: s,
      signing: { adHoc: this.adHocSigned },
      environment: { vaultAddress: this.baseEnvCache().VAULT_ADDR || null },
    };
  }

  // ------------------------------------------------------------------ API

  /**
   * Adds a server definition to the hub, or replaces `replaceId` in place. Replacing keeps the server's id,
   * on/off state and lifecycle, so anything already pointing at it keeps working.
   */
  /** Wait (bounded) until freshly imported servers have either connected or failed, so the result can say which. */
  private async waitUntilSettled(ids: string[], ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const waiting = ids.filter((id) => {
        const c = this.manager.get(id);
        return !!c?.config.enabled && ["connecting", "disconnected"].includes(c.status().state);
      });
      if (!waiting.length) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async importOne(s: ServerConfig, replaceId?: string): Promise<{ id: string; mode: "added" | "replaced" }> {
    const { manager } = this;
    const existing = replaceId ? manager.get(replaceId) : undefined;
    if (existing) {
      const blank = Object.fromEntries(RESET_FIELDS.map((k) => [k, undefined]));
      this.endpoint.dropServerSessions(existing.id);
      await manager.update(existing.id, { ...blank, ...s, id: existing.id, enabled: existing.config.enabled, lifecycle: existing.config.lifecycle });
      return { id: existing.id, mode: "replaced" };
    }
    let id = slugify(s.id || s.name);
    const base = id;
    for (let i = 2; manager.get(id); i++) id = `${base}-${i}`;
    await manager.add({ ...s, id, enabled: s.enabled ?? true, lifecycle: s.lifecycle ?? "keep-alive" });
    return { id, mode: "added" };
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = req.method ?? "GET";
    const p = url.pathname;
    const { store, manager, broker } = this;
    let r: RegExpExecArray | null;

    if (m === "GET" && p === "/api/state") return json(res, 200, this.snapshot());

    if (m === "GET" && p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      res.write(`event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      this.sseClients.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      res.on("close", () => {
        clearInterval(beat);
        this.sseClients.delete(res);
      });
      return;
    }

    // ---- servers
    if (m === "POST" && p === "/api/servers") {
      const body = (await readJson(req)) as Partial<ServerConfig> | undefined;
      if (!body?.name) throw new HttpError(400, "name is required");
      let id = body.id ? slugify(body.id) : slugify(body.name);
      const base = id;
      for (let i = 2; manager.get(id); i++) id = `${base}-${i}`;
      const cfg: ServerConfig = {
        transport: "stdio",
        enabled: true,
        lifecycle: "keep-alive",
        ...body,
        id,
        name: body.name,
      } as ServerConfig;
      return json(res, 201, await manager.add(cfg));
    }
    if ((r = /^\/api\/servers\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(r[1]!);
      if (m === "PUT") {
        const body = (await readJson(req)) as Partial<ServerConfig>;
        this.endpoint.dropServerSessions(id);
        return json(res, 200, await manager.update(id, body));
      }
      if (m === "DELETE") {
        this.endpoint.dropServerSessions(id);
        await manager.remove(id);
        return json(res, 200, { ok: true });
      }
      if (m === "GET") {
        const c = manager.get(id);
        if (!c) throw new HttpError(404, "No such server");
        return json(res, 200, c.status());
      }
    }
    // Adds this server's MCP Hub entry to the chosen apps' config files. Only touches files the user picked.
    if (m === "POST" && (r = /^\/api\/servers\/([^/]+)\/install$/.exec(p))) {
      const id = decodeURIComponent(r[1]!);
      if (!manager.get(id)) throw new HttpError(404, "No such server");
      const body = (await readJson(req)) as { clients?: unknown; dryRun?: unknown; replace?: unknown; transport?: unknown };
      const apps = knownApps().map((a) => a.client);
      if (!Array.isArray(body?.clients) || !body.clients.length || body.clients.some((c) => typeof c !== "string" || !apps.includes(c))) {
        throw new HttpError(400, "clients must list one or more known apps");
      }
      for (const flag of [body.dryRun, body.replace]) if (flag !== undefined && typeof flag !== "boolean") throw new HttpError(400, "dryRun and replace must be true or false");
      if (body.transport !== undefined && body.transport !== "bridge" && body.transport !== "http") throw new HttpError(400, 'transport must be "bridge" or "http"');
      // Direct HTTP is only offered while the hub accepts it; the token goes in only when the hub asks for one.
      const s = this.store.settings;
      if (body.transport === "http" && !s.allowTcpMcp) throw new HttpError(400, "Direct HTTP access is turned off. Allow it in Settings → Security, or install with the bridge.");
      const http = body.transport === "http" ? { url: manager.mcpUrl(id), ...(s.requireClientToken ? { token: s.clientToken } : {}) } : undefined;
      if (!http && !this.opts.shim) throw new HttpError(400, "The MCP Hub bridge (mcp-hub-stdio) was not found, so there is nothing to install. Use the packaged MCP Hub app.");
      const bridge = this.opts.shim ?? { command: "", args: [] };
      // A dry run only reports what would change (which entries would be replaced); nothing is written.
      if (body.dryRun) return json(res, 200, { preview: previewInstall(id, body.clients as string[], bridge, undefined, { http }) });
      return json(res, 200, { results: installServer(id, body.clients as string[], bridge, undefined, { replace: body.replace === true, http }) });
    }

    // Adds several servers' MCP Hub entries to one app's config file in a single, backed-up edit.
    if (m === "POST" && p === "/api/install") {
      const body = (await readJson(req)) as { client?: unknown; servers?: unknown; dryRun?: unknown; replace?: unknown };
      const apps = knownApps().map((a) => a.client);
      if (typeof body?.client !== "string" || !apps.includes(body.client)) throw new HttpError(400, "client must be a known app");
      if (!Array.isArray(body.servers) || !body.servers.length || body.servers.some((s) => typeof s !== "string" || !manager.get(s))) {
        throw new HttpError(400, "servers must list one or more existing servers");
      }
      for (const flag of [body.dryRun, body.replace]) if (flag !== undefined && typeof flag !== "boolean") throw new HttpError(400, "dryRun and replace must be true or false");
      if (!this.opts.shim) throw new HttpError(400, "The MCP Hub bridge (mcp-hub-stdio) was not found, so there is nothing to install. Use the packaged MCP Hub app.");
      const ids = [...new Set(body.servers as string[])];
      if (body.dryRun) return json(res, 200, { preview: previewInstallServers(ids, body.client, this.opts.shim) });
      return json(res, 200, { result: installServers(ids, body.client, this.opts.shim, undefined, { replace: body.replace === true }) });
    }

    if (m === "POST" && (r = /^\/api\/servers\/([^/]+)\/(enable|disable|restart|signin|signout)$/.exec(p))) {
      const id = decodeURIComponent(r[1]!);
      switch (r[2]) {
        case "enable":
          return json(res, 200, await manager.setEnabled(id, true));
        case "disable":
          return json(res, 200, await manager.setEnabled(id, false));
        case "restart":
          return json(res, 200, await manager.restart(id));
        case "signin": {
          const authUrl = await manager.beginSignIn(id);
          if (!this.opts.quiet) openExternal(authUrl);
          return json(res, 200, { url: authUrl });
        }
        case "signout":
          await manager.signOut(id);
          return json(res, 200, { ok: true });
      }
    }
    if ((r = /^\/api\/servers\/([^/]+)\/logs$/.exec(p))) {
      const logs = manager.logsFor(decodeURIComponent(r[1]!));
      if (!logs) throw new HttpError(404, "No such server");
      if (m === "DELETE") {
        logs.clear();
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { lines: logs.tail(Number(url.searchParams.get("n") ?? 300)) });
    }
    if (m === "GET" && (r = /^\/api\/servers\/([^/]+)\/tools$/.exec(p))) {
      const c = manager.get(decodeURIComponent(r[1]!));
      if (!c) throw new HttpError(404, "No such server");
      if (c.state !== "connected") throw new HttpError(409, "Server is not connected");
      return json(res, 200, { tools: await c.listTools() });
    }

    // ---- credential sources
    if (m === "POST" && p === "/api/sources") {
      const body = (await readJson(req)) as Partial<SourceConfig>;
      if (!body?.type || !SOURCE_TYPES.includes(body.type)) throw new HttpError(400, "Unknown source type");
      if (!body.name?.trim()) throw new HttpError(400, "name is required");
      if ((body.type === "env" || body.type === "manual") && store.sources.some((s) => s.type === body.type)) {
        throw new HttpError(409, `A ${body.type} source already exists`);
      }
      let id = slugify(body.name);
      const base = id;
      for (let i = 2; store.sources.some((s) => s.id === id); i++) id = `${base}-${i}`;
      const src: SourceConfig = { id, type: body.type, name: body.name.trim(), enabled: body.enabled ?? true, options: body.options ?? {} };
      store.upsertSource(src);
      manager.notifyChange();
      return json(res, 201, src);
    }
    if ((r = /^\/api\/sources\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(r[1]!);
      const cur = store.sources.find((s) => s.id === id);
      if (!cur) throw new HttpError(404, "No such source");
      if (m === "PUT") {
        const body = (await readJson(req)) as Partial<SourceConfig>;
        const next: SourceConfig = { ...cur, name: body.name ?? cur.name, enabled: body.enabled ?? cur.enabled, options: body.options ?? cur.options };
        store.upsertSource(next);
        broker.invalidateSource(id);
        manager.notifyChange();
        return json(res, 200, next);
      }
      if (m === "DELETE") {
        if (cur.type === "env" || cur.type === "manual") throw new HttpError(400, "Built-in sources cannot be removed");
        store.removeSource(id);
        broker.invalidateSource(id);
        manager.notifyChange();
        return json(res, 200, { ok: true });
      }
    }
    if (m === "POST" && (r = /^\/api\/sources\/([^/]+)\/test$/.exec(p))) {
      const src = store.sources.find((s) => s.id === decodeURIComponent(r![1]!));
      if (!src) throw new HttpError(404, "No such source");
      return json(res, 200, await broker.testSource(src));
    }
    if (m === "PUT" && (r = /^\/api\/sources\/([^/]+)\/token$/.exec(p))) {
      const id = decodeURIComponent(r[1]!);
      if (!store.sources.some((s) => s.id === id && s.type === "vault")) throw new HttpError(404, "No such Vault source");
      const body = (await readJson(req)) as { value?: string };
      if (!body?.value) throw new HttpError(400, "value is required");
      broker.memory.set(`vault-token/${id}`, body.value);
      manager.notifyChange();
      return json(res, 200, { ok: true });
    }

    // ---- local secrets (encrypted, saved when the OS keychain is available)
    if ((r = /^\/api\/secrets\/([^/]+)$/.exec(p))) {
      const name = decodeURIComponent(r[1]!);
      if (m === "PUT") {
        const body = (await readJson(req)) as { value?: string };
        if (typeof body?.value !== "string" || !body.value) throw new HttpError(400, "value is required");
        broker.memory.set(name, body.value);
        broker.invalidateSource("manual");
        manager.notifyChange();
        return json(res, 200, { ok: true, ref: `{{secret://${name}}}` });
      }
      if (m === "DELETE") {
        broker.memory.delete(name);
        broker.invalidateSource("manual");
        manager.notifyChange();
        return json(res, 200, { ok: true });
      }
    }
    if (m === "POST" && p === "/api/credentials/lock") {
      broker.lock();
      this.history.record({ kind: "vault", action: "locked" });
      return json(res, 200, { ok: true });
    }

    // Forget a single fetched secret; it is read again the next time a server needs it.
    if (m === "DELETE" && p === "/api/credentials/cached") {
      const body = (await readJson(req)) as { sourceId?: unknown; ref?: unknown } | undefined;
      if (typeof body?.sourceId !== "string" || typeof body.ref !== "string") throw new HttpError(400, "sourceId and ref are required.");
      if (!broker.forget(body.sourceId, body.ref)) throw new HttpError(404, "That secret is not in memory.");
      this.history.record({ kind: "vault", action: "forgot-one", source: store.sources.find((s) => s.id === body.sourceId)?.name ?? "" });
      return json(res, 200, { ok: true });
    }

    // ---- recovery: the encryption key was lost, or the user wants a copy of it
    // The recovery key is only handed out on this explicit request, and only when it is the real key.
    if (m === "GET" && p === "/api/credentials/recovery-key") {
      if (!this.box.persistent) throw new HttpError(409, "There is no saved encryption key to show right now.");
      return json(res, 200, { key: this.box.exportKey(), algorithm: this.box.algorithm, keyStore: this.box.keyStore });
    }
    // Put a recovery key back (into the OS key store), after checking that it really opens what is saved.
    if (m === "POST" && p === "/api/credentials/restore-key") {
      const body = (await readJson(req)) as { key?: unknown };
      const text = typeof body?.key === "string" ? body.key.trim() : "";
      const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64") : Buffer.alloc(0);
      if (bytes.length !== 32) throw new HttpError(400, "That isn't a recovery key. It should be 44 characters of letters and numbers, copied from MCP Hub's Show recovery key.");
      const candidate = new SecretBox(bytes, true, this.keyStore.name);
      if (!this.store.hasSealedValues() && !broker.memory.savedCount() && !this.signIns.savedCount()) throw new HttpError(400, "Nothing saved is encrypted, so there is nothing to restore.");
      if (!this.store.canOpenAny(candidate) && !broker.memory.canOpenAny(candidate) && !this.signIns.canOpenAny(candidate)) throw new HttpError(400, "That key doesn't open your saved secrets, so it isn't the right one. Nothing was changed.");
      try {
        this.keyStore.write(bytes);
      } catch (err) {
        throw new HttpError(500, `The key is right, but it couldn't be saved to ${this.keyStore.name}: ${(err as Error).message}`);
      }
      this.box.adopt(bytes, { persistent: true, keyStore: this.keyStore.name });
      this.store.resealAll();
      broker.memory.reload();
      this.signIns.reload();
      broker.invalidateAll();
      manager.retryCredentialFailures();
      manager.notifyChange();
      return json(res, 200, { ok: true, encryption: this.box.info() });
    }
    // Start over with a new key when the old one is gone for good. Whatever was sealed with it can't be read again:
    // local secrets are deleted, and servers that held sealed references are emptied there and switched off.
    if (m === "POST" && p === "/api/credentials/reset-encryption") {
      if (this.box.persistent) throw new HttpError(409, "Encryption is working, so there is nothing to reset.");
      const fresh = randomBytes(32);
      try {
        this.keyStore.write(fresh);
      } catch (err) {
        throw new HttpError(500, `A new key couldn't be saved to ${this.keyStore.name}: ${(err as Error).message}`);
      }
      this.box.adopt(fresh, { persistent: true, keyStore: this.keyStore.name });
      const affected = this.store.blankUnreadable();
      const removed = broker.memory.wipe();
      this.signIns.wipe();
      this.store.resealAll();
      broker.invalidateAll();
      await manager.refreshFromStore(affected.map((a) => a.id));
      return json(res, 200, { ok: true, affected, localSecretsRemoved: removed, encryption: this.box.info() });
    }
    // Looks for the tools 1Password and the keychain need. Nothing is read, so no approval prompt appears.
    // A 1Password CLI found outside the PATH the hub sees is remembered on the source.
    if (m === "GET" && p === "/api/credentials/setup") {
      const statuses = await detectSetup(store.sources.filter((s) => s.enabled || s.type === "1password" || s.type === "keychain"), this.baseEnvCache(), {
        hasSecret: (n) => broker.memory.get(n) !== undefined,
      });
      for (const st of statuses) {
        const src = store.sources.find((s) => s.id === st.sourceId);
        const key = st.type === "1password" ? "opPath" : st.type === "vault" ? "vaultPath" : null;
        if (src && key && st.path && !src.options[key]) {
          store.upsertSource({ ...src, options: { ...src.options, [key]: st.path } });
          broker.invalidateSource(src.id);
          manager.notifyChange();
        }
      }
      return json(res, 200, { statuses });
    }

    // Downloads the official CLI (1Password or Vault) into MCP Hub's own folder and points the source at it.
    if (m === "POST" && (r = /^\/api\/credentials\/setup\/([^/]+)\/install$/.exec(p))) {
      const src = store.sources.find((s) => s.id === decodeURIComponent(r![1]!));
      if (!src || (src.type !== "1password" && src.type !== "vault")) throw new HttpError(404, "That source has no CLI to install");
      const vault = src.type === "vault";
      const installer = vault ? (this.opts.installVaultCli ?? installVaultCli) : (this.opts.installOnePasswordCli ?? installOnePasswordCli);
      const dir = join(this.opts.dataDir, "tools", vault ? "vault" : "op");
      let job = this.installs.get(src.type);
      if (!job) {
        job = installer(dir).finally(() => this.installs.delete(src.type));
        this.installs.set(src.type, job);
      }
      let installed: InstalledCli;
      try {
        installed = await job;
      } catch (err) {
        throw new HttpError(502, (err as Error).message);
      }
      store.upsertSource({ ...src, options: { ...src.options, [vault ? "vaultPath" : "opPath"]: installed.path } });
      broker.invalidateSource(src.id);
      manager.notifyChange();
      return json(res, 200, installed);
    }

    // Signs in to Vault with the CLI (`vault login`). OIDC opens your browser; the token lands in ~/.vault-token.
    if (m === "POST" && (r = /^\/api\/credentials\/setup\/([^/]+)\/sign-in$/.exec(p))) {
      const src = store.sources.find((s) => s.id === decodeURIComponent(r![1]!));
      if (!src || src.type !== "vault") throw new HttpError(404, "That source has no sign-in");
      const env = this.baseEnvCache();
      const address = (src.options.address || env.VAULT_ADDR || "").replace(/\/+$/, "");
      const method = src.options.loginMethod || "oidc";
      if (!address) throw new HttpError(400, "Set the Vault address first");
      if (!/^[a-z0-9_-]+$/i.test(method)) throw new HttpError(400, "The sign-in method must be a plain name such as oidc, ldap or okta");
      try {
        await runCommand(src.options.vaultPath || "vault", ["login", "-no-print", `-address=${address}`, `-method=${method}`], { timeoutMs: 300_000, env });
      } catch (err) {
        const e = err as { stderr?: string; message: string; code?: string | number | null };
        throw new HttpError(502, e.code === "ENOENT" ? "The Vault CLI wasn't found. Install it first." : (e.stderr || e.message).trim().slice(0, 400));
      }
      broker.invalidateSource(src.id);
      manager.notifyChange();
      return json(res, 200, { ok: true });
    }

    // ---- history: what MCP Hub did, in plain words (secret reads, app access, server starts and stops)
    if (m === "GET" && p === "/api/history") {
      const kinds = (url.searchParams.get("kind") ?? "").split(",").filter(Boolean);
      const bad = kinds.find((k) => !HISTORY_KINDS.includes(k as HistoryKind));
      if (bad) throw new HttpError(400, `kind must be one or more of ${HISTORY_KINDS.join(", ")}`);
      const before = Number(url.searchParams.get("before")) || undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return json(res, 200, {
        ...this.history.query({ q: url.searchParams.get("q") ?? undefined, kinds: kinds as HistoryKind[], serverId: url.searchParams.get("server") ?? undefined, before, limit }),
        retentionDays: store.settings.retentionDays,
      });
    }
    if (m === "DELETE" && p === "/api/history") {
      this.history.clear();
      return json(res, 200, { ok: true });
    }

    // ---- usage
    // Start over: forget usage history (everything, or one server) and zero the totals on the server cards.
    if (m === "DELETE" && p === "/api/usage") {
      const server = url.searchParams.get("server") ?? undefined;
      if (server && !manager.get(server)) throw new HttpError(404, "No such server");
      this.metrics.clear(server);
      manager.resetStats(server);
      return json(res, 200, { ok: true });
    }
    if (m === "GET" && p === "/api/usage") {
      const range = (url.searchParams.get("range") ?? "24h") as UsageRange;
      if (!RANGES.includes(range)) throw new HttpError(400, "range must be one of 1h, 24h, 7d, 30d");
      return json(res, 200, this.metrics.query(range, url.searchParams.get("server") ?? undefined, url.searchParams.get("client") ?? undefined));
    }
    if (m === "GET" && p === "/api/usage.csv") {
      const range = (url.searchParams.get("range") ?? "24h") as UsageRange;
      if (!RANGES.includes(range)) throw new HttpError(400, "bad range");
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="mcp-hub-usage-${range}.csv"` });
      res.end(this.metrics.toCsv(range, url.searchParams.get("server") ?? undefined, url.searchParams.get("client") ?? undefined));
      return;
    }

    // ---- settings
    if (p === "/api/settings") {
      if (m === "GET") return json(res, 200, store.settings);
      if (m === "PUT") {
        const body = (await readJson(req)) as Partial<Settings>;
        const patch: Partial<Settings> = {};
        const num = (k: keyof Settings, min: number, max: number) => {
          const v = body[k];
          if (v === undefined) return;
          if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${k} must be a number between ${min} and ${max}`);
          (patch as Record<string, unknown>)[k] = Math.round(v);
        };
        const bool = (k: keyof Settings) => {
          const v = body[k];
          if (v === undefined) return;
          if (typeof v !== "boolean") throw new HttpError(400, `${k} must be a boolean`);
          (patch as Record<string, unknown>)[k] = v;
        };
        num("port", ...SETTING_LIMITS.port);
        num("cacheTtlSeconds", ...SETTING_LIMITS.cacheTtlSeconds);
        num("signInTtlSeconds", ...SETTING_LIMITS.signInTtlSeconds);
        num("denialCooldownSeconds", ...SETTING_LIMITS.denialCooldownSeconds);
        num("retentionDays", ...SETTING_LIMITS.retentionDays);
        bool("requireClientToken");
        bool("allowTcpMcp");
        bool("notifyOnCredentialPrompt");
        bool("preloadSecrets");
        bool("dismissedSigningNotice");
        bool("onboarded");
        bool("recoveryKeySaved");
        bool("rememberSignIns");
        const next = store.updateSettings(patch);
        // A new "forget after" time applies to what is already held, not only to secrets fetched from now on.
        if (patch.cacheTtlSeconds !== undefined) broker.applyTtl();
        if (patch.rememberSignIns !== undefined) manager.syncRememberedSignIns();
        if (patch.signInTtlSeconds !== undefined) this.signIns.expire();
        // A shorter "keep history for" takes effect now, not at the next hourly sweep.
        if (patch.retentionDays !== undefined) this.pruneHistory();
        manager.notifyChange();
        return json(res, 200, { settings: next, restartRequired: patch.port !== undefined && patch.port !== this.listeningPort });
      }
    }
    if (m === "POST" && p === "/api/settings/rotate-client-token") {
      const { randomBytes } = await import("node:crypto");
      const next = store.updateSettings({ clientToken: randomBytes(24).toString("base64url") });
      manager.notifyChange();
      return json(res, 200, next);
    }

    // ---- apps connected through the local socket
    if (m === "POST" && (r = /^\/api\/clients\/([^/]+)\/decision$/.exec(p))) {
      const body = (await readJson(req)) as { allow?: unknown; servers?: unknown };
      if (typeof body?.allow !== "boolean") throw new HttpError(400, "allow must be a boolean");
      // `servers` limits what the app may use. Choosing every server that exists means "all", future ones included.
      let servers: string[] | null = null;
      if (body.servers !== undefined) {
        if (!Array.isArray(body.servers) || body.servers.some((s) => typeof s !== "string" || !manager.get(s))) throw new HttpError(400, "servers must list existing servers");
        const every = store.servers.every((s) => (body.servers as string[]).includes(s.id));
        servers = every ? null : (body.servers as string[]);
      }
      if (!this.clients.decide(decodeURIComponent(r[1]!), body.allow, servers)) throw new HttpError(404, "That app is no longer connected");
      return json(res, 200, { ok: true });
    }

    // ---- export / import of MCP Hub's own configuration (servers and extra credential sources; never secret values)
    if (m === "GET" && p === "/api/config/export") {
      return json(res, 200, buildExport(store.servers.map((s) => store.reveal(s)), store.sources, VERSION));
    }
    // Asks the user where to save (a native Save As dialog the daemon shows, so the app, not a browser, decides
    // where the file goes), then writes it there. The path always comes from that dialog, never from the request.
    if (m === "POST" && p === "/api/config/export/save") {
      const name = `mcp-hub-config-${new Date().toISOString().slice(0, 10)}.json`;
      const chosen = await (this.opts.pickSavePath ?? pickSavePath)(name, "Export your MCP Hub configuration");
      if (chosen === undefined) return json(res, 200, { unsupported: true });
      if (chosen === null) return json(res, 200, { cancelled: true });
      const path = /\.json$/i.test(chosen) ? chosen : `${chosen}.json`;
      try {
        // Servers can hold typed-in values, so the file is private to the user.
        writeFileSync(path, JSON.stringify(buildExport(store.servers.map((s) => store.reveal(s)), store.sources, VERSION), null, 2) + "\n", { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch (err) {
        throw new HttpError(500, `Couldn't save the file: ${(err as Error).message}`);
      }
      this.lastExportPath = path;
      return json(res, 200, { path });
    }
    // Only the file just saved can be shown.
    if (m === "POST" && p === "/api/config/export/reveal") {
      if (!this.lastExportPath) throw new HttpError(404, "Nothing has been exported yet");
      (this.opts.reveal ?? revealInFileManager)(this.lastExportPath);
      return json(res, 200, { ok: true });
    }
    // Shows one of the known apps' config files, or a backup made of it, in the file manager. The path is looked up
    // here from the app's name; one given in the request is never used as it is, and a backup must be a
    // `<config file>.mcp-hub-backup-…` copy sitting next to that app's config file.
    if (m === "POST" && p === "/api/apps/reveal") {
      const body = (await readJson(req)) as { client?: unknown; backup?: unknown };
      const file = typeof body?.client === "string" ? candidatePaths().find((f) => f.client === body.client) : undefined;
      if (!file) throw new HttpError(400, "client must be a known app");
      let target = file.path;
      if (body.backup !== undefined) {
        if (typeof body.backup !== "string") throw new HttpError(400, "backup must be a path");
        const real = (path: string): string | null => {
          try {
            return realpathSync(path);
          } catch {
            return null;
          }
        };
        const config = real(file.path);
        const backup = real(body.backup);
        if (!config || !backup || dirname(backup) !== dirname(config) || !basename(backup).startsWith(`${basename(config)}.mcp-hub-backup-`)) {
          throw new HttpError(404, "That backup can't be found");
        }
        target = backup;
      } else if (!existsSync(file.path)) {
        throw new HttpError(404, `${file.client} has no config file yet`);
      }
      (this.opts.reveal ?? revealInFileManager)(target);
      return json(res, 200, { ok: true });
    }
    // Shows a connected app (the program that is running) in the file manager.
    if (m === "POST" && (r = /^\/api\/clients\/([^/]+)\/reveal$/.exec(p))) {
      const found = this.clients.list().find((c) => c.id === decodeURIComponent(r![1]!));
      if (!found) throw new HttpError(404, "That app is no longer connected");
      if (!existsSync(found.path)) throw new HttpError(404, "That app can't be found any more");
      (this.opts.reveal ?? revealInFileManager)(found.path);
      return json(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/config/import") {
      const body = (await readJson(req)) as { data?: unknown; onClash?: string; includeSources?: boolean; dryRun?: boolean };
      const onClash = (body?.onClash ?? "skip") as ClashChoice;
      if (!["skip", "replace", "copy"].includes(onClash)) throw new HttpError(400, 'onClash must be "skip", "replace" or "copy"');
      if (body?.data === undefined) throw new HttpError(400, "data is required");
      const plan = planImport(
        parseImport(body.data),
        { servers: store.servers.map((s) => ({ id: s.id, name: s.name })), sources: store.sources, localSecrets: broker.memory.names().filter((n) => !n.startsWith("vault-token/")) },
        { onClash, includeSources: body.includeSources !== false },
      );
      const summary = {
        servers: plan.servers.map(({ name, id, action, reason }) => ({ name, id, action, ...(reason ? { reason } : {}) })),
        problems: plan.problems,
        sources: { add: plan.sources.add.map((s) => s.name), skip: plan.sources.skip },
        missingLocalSecrets: plan.missingLocalSecrets,
      };
      if (body.dryRun === true) return json(res, 200, { dryRun: true, ...summary });

      const failed: Array<{ name: string; reason: string }> = [];
      const done = { added: [] as string[], replaced: [] as string[], skipped: [] as string[] };
      for (const s of plan.sources.add) store.upsertSource(s);
      for (const item of plan.servers) {
        if (item.action === "skip") {
          done.skipped.push(item.name);
          continue;
        }
        try {
          if (item.action === "replace") {
            await manager.update(item.id, { ...Object.fromEntries(RESET_FROM_FILE.map((k) => [k, undefined])), ...item.config, id: item.id });
            done.replaced.push(item.name);
          } else {
            await manager.add(item.config);
            done.added.push(item.name);
          }
        } catch (err) {
          failed.push({ name: item.name, reason: (err as Error).message });
        }
      }
      manager.notifyChange();
      return json(res, 200, { dryRun: false, ...summary, ...done, sourcesAdded: plan.sources.add.map((s) => s.name), failed });
    }

    // ---- import (nothing is read from other apps until the user asks for it)
    if (m === "GET" && p === "/api/import/apps") {
      return json(res, 200, { apps: knownApps() });
    }
    if (m === "GET" && p === "/api/import/scan") {
      const client = url.searchParams.get("client") ?? undefined;
      if (client && !knownApps().some((a) => a.client === client)) throw new HttpError(400, "Unknown app");
      return json(res, 200, { sources: scanClientConfigs(new Set(store.servers.map((s) => s.id)), client) });
    }
    if (m === "POST" && p === "/api/import") {
      const body = (await readJson(req)) as { servers?: Array<ServerConfig & { replaceId?: string }> };
      if (!Array.isArray(body?.servers)) throw new HttpError(400, "servers[] is required");
      const added: ServerConfig[] = [];
      const replaced: string[] = [];
      for (const { replaceId, ...s } of body.servers) {
        if (replaceId && !manager.get(replaceId)) throw new HttpError(404, `No such server: ${replaceId}`);
        const r = await this.importOne(s as ServerConfig, replaceId);
        if (r.mode === "replaced") replaced.push(r.id);
        else added.push({ ...s, id: r.id } as ServerConfig);
      }
      return json(res, 201, { added, replaced });
    }

    // Migrate one app: bring its servers into MCP Hub, then point the app's own entries at the hub (same keys, so
    // tool names don't change). Runs only when the user asks, for the one app they chose. The file is backed up first.
    if (m === "POST" && p === "/api/migrate") {
      const body = (await readJson(req)) as { client?: string; names?: unknown; onClash?: string };
      if (typeof body?.client !== "string" || !knownApps().some((a) => a.client === body.client)) throw new HttpError(400, "client must be a known app");
      if (!Array.isArray(body.names) || !body.names.length || body.names.some((n) => typeof n !== "string")) throw new HttpError(400, "names must list the servers to migrate");
      if (body.onClash !== "keep" && body.onClash !== "replace") throw new HttpError(400, 'onClash must be "keep" or "replace"');
      if (!this.opts.shim) throw new HttpError(400, "The MCP Hub bridge (mcp-hub-stdio) was not found, so there is nothing to point the app at. Use the packaged MCP Hub app.");

      const source = scanClientConfigs(new Set(store.servers.map((s) => s.id)), body.client)[0];
      const wanted = new Set(body.names as string[]);
      const candidates = (source?.servers ?? []).filter((c) => c.config && !c.viaHub && wanted.has(c.name));
      if (!candidates.length) throw new HttpError(404, "None of those servers were found in that app's config");

      const plan: Record<string, string> = {};
      const servers: Array<{ name: string; id: string; mode: "added" | "replaced" | "reused" }> = [];
      for (const c of candidates) {
        const existing = store.servers.find((s) => s.name.toLowerCase() === c.name.toLowerCase());
        if (existing && body.onClash === "keep") {
          plan[c.name] = existing.id;
          servers.push({ name: c.name, id: existing.id, mode: "reused" });
          continue;
        }
        const r = await this.importOne(c.config!, existing?.id);
        plan[c.name] = r.id;
        servers.push({ name: c.name, id: r.id, mode: r.mode });
      }
      // Don't replace an entry that works with one the hub can't run: a server whose credentials or references
      // can't be resolved is left as the app had it, and the reason is reported.
      await this.waitUntilSettled(Object.values(plan));
      const problems: Array<{ name: string; id: string; reason: string; blocked: boolean }> = [];
      for (const [name, id] of Object.entries(plan)) {
        const st = manager.get(id)?.status();
        if (!st || st.state !== "error") continue;
        const blocked = st.credentials === "failed";
        problems.push({ name, id, reason: st.error ?? "It could not connect.", blocked });
        if (blocked) delete plan[name];
      }
      if (!Object.keys(plan).length) {
        const message = "Nothing was changed: MCP Hub could not set these servers up, so the app's own settings were left as they were.";
        return json(res, 200, { servers, problems, config: { client: body.client, path: source?.path ?? "", status: "error", message, migrated: [], skipped: [] } });
      }
      const config = migrateClientConfig(body.client, plan, this.opts.shim);
      return json(res, 200, { servers, problems, config });
    }

    json(res, 404, { error: "Not found" });
  }
}
