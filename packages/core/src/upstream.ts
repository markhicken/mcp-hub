import { EventEmitter } from "node:events";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CredentialBroker } from "./credentials/broker.js";
import { descendantsOf, stopLeftovers, type ChildRegistry } from "./children.js";
import type { SignInStore } from "./credentials/signins.js";
import { CredentialError } from "./credentials/types.js";
import { LogBuffer } from "./logs.js";
import type { Metrics } from "./metrics.js";
import { HubOAuthProvider } from "./oauth.js";
import { mergeEnv } from "./system.js";
import type { ClientRef, ConnectionState, CredentialState, ServerClient, ServerConfig, ServerStatus } from "./types.js";
import { VERSION } from "./version.js";

type Msg = Record<string, any>;
const bytes = (m: unknown) => Buffer.byteLength(JSON.stringify(m));
const isRequest = (m: Msg) => typeof m.method === "string" && m.id !== undefined;
const isNotification = (m: Msg) => typeof m.method === "string" && m.id === undefined;
const isResponse = (m: Msg) => m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

export interface UpstreamDeps {
  broker: CredentialBroker;
  metrics: Metrics;
  logs: LogBuffer;
  /** Environment given to stdio children (hub env + login shell PATH). */
  baseEnv: () => NodeJS.ProcessEnv;
  callbackUrl: () => string;
  mcpUrl: (id: string) => string;
  /** Decrypts the credential references in a stored server definition, for showing it or running it. */
  reveal: (config: ServerConfig) => ServerConfig;
  /** Where remembered OAuth sign-ins are kept. Omit to keep them in memory only. */
  signIns?: SignInStore;
  /** Remembers started stdio servers so a later start can stop leftovers from a crash. */
  children?: ChildRegistry;
  /** Should this server's OAuth sign-in be remembered across restarts? */
  rememberSignIn?: (config: ServerConfig) => boolean;
}

interface Pending {
  sessionId: string;
  client: string;
  origId: string | number;
  started: number;
  method: string;
  tool?: string;
  progressKey?: string;
  onNotify?: (m: Msg) => void;
  resolve: (m: Msg) => void;
  watch?: NodeJS.Timeout;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const requestLabel = (p: { method: string; tool?: string }): string => (p.tool ? `${p.method} ${p.tool}` : p.method);

/**
 * Apps ask what a server offers (`tools/list`, `prompts/list`, `resources/list`, ...) and whether it is alive
 * (`ping`) as part of connecting. That is connection overhead, not use, so it is left out of usage, traffic and
 * "last used". Calling a tool, reading a resource and getting a prompt are use.
 */
export function countsAsUse(method: string): boolean {
  return method !== "ping" && method !== "logging/setLevel" && !method.endsWith("/list");
}

interface Resolved {
  env: Record<string, string>;
  headers: Record<string, string>;
  args: string[];
  command: string;
  cwd?: string;
  url: string;
  clientSecret?: string;
}

/** What happened to a connection, for the history. */
export interface LifecycleEvent {
  from: ConnectionState;
  to: ConnectionState;
  trigger: string;
  /** The stop was the idle timeout, not someone's choice. */
  idle: boolean;
}

/** Every field of a server definition that may hold a {{credential}} reference. */
function credentialTemplates(cfg: ServerConfig): Array<string | undefined> {
  return [cfg.command, cfg.cwd, cfg.url, ...(cfg.args ?? []), ...Object.values(cfg.env ?? {}), ...Object.values(cfg.headers ?? {}), cfg.oauth?.clientSecret];
}

export interface DownstreamHandle {
  id: string;
  /** The app on the other end, for usage tracking and the "in use by" list. */
  client?: ClientRef;
  /** Called for server->client notifications not tied to a specific request. */
  push: (m: Msg) => void;
}

const ACTIVE_WINDOW_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** After this many failed automatic attempts in a row the hub stops and waits for the user to press Retry. */
const MAX_AUTO_RETRIES = 5;
/** A connection that lasts this long counts as healthy, so the retry count starts over if it later drops. */
const STABLE_CONNECTION_MS = 60_000;

/** The server's own reason from an HTTP error body such as `{"error":"Invalid token","message":"…"}`. */
function serverReason(message: string): string {
  const start = message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start)) as { message?: unknown; error?: unknown; error_description?: unknown; title?: unknown };
      const text = [body.error ?? body.title, body.message ?? body.error_description].filter((x) => typeof x === "string" && x).join(": ");
      if (text) return text.slice(0, 300);
    } catch {
      // not JSON: fall through to the raw text
    }
  }
  return message.slice(0, 300);
}

/** Failures that retrying can't fix: the server refused the token or the sign-in has expired. */
const AUTH_TEXT = /invalid[_ ]?(oauth[_ ])?(token|grant)|Err\w*Invalid\w*Token|refresh token|token (is )?(not valid|expired|invalid|revoked)|session expired|unauthori[sz]ed|HTTP 40[13]\b/i;

function isAuthFailure(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) return true;
  return AUTH_TEXT.test(err instanceof Error ? err.message : String(err));
}

function rpcError(id: string | number | null, code: number, message: string): Msg {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * One live connection from the hub to an upstream MCP server (stdio child or remote HTTP),
 * shared by any number of downstream client sessions.
 *
 * The hub performs the MCP handshake itself, answers downstream `initialize` from cache,
 * and multiplexes requests by rewriting JSON-RPC ids so sessions cannot collide.
 */
export class UpstreamConnection extends EventEmitter {
  state: ConnectionState = "disconnected";
  credentials: CredentialState = "none";
  error?: string;
  connectedAt: number | null = null;
  lastActivityAt: number | null = null;
  serverInfo?: { name?: string; version?: string };
  capabilities: Msg = {};
  instructions?: string;
  protocolVersion?: string;
  toolCount?: number;
  bytesIn = 0;
  bytesOut = 0;
  requests = 0;
  errors = 0;

  private transport?: Transport;
  private oauth?: HubOAuthProvider;
  private pendingAuthTransport?: StreamableHTTPClientTransport;
  private pending = new Map<string, Pending>();
  private progress = new Map<string, { sessionId: string; origToken: string | number }>();
  private sessions = new Map<string, DownstreamHandle>();
  private sessionActivity = new Map<string, number>();
  private settleTimer?: NodeJS.Timeout;
  private waiters = new Map<string, (m: Msg) => void>();
  private seq = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private backoff = 1000;
  /** Delay before the first automatic retry; it doubles up to a minute. */
  retryBaseMs = 1000;
  /** How long a server gets to answer the MCP handshake. */
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS;
  /** What a local server printed to stderr while starting; an invalid-token message there explains a failed start. */
  private startupStderr: string[] = [];
  /** Failed automatic attempts in a row; a success or any manual action starts the count again. */
  private failures = 0;
  private autoRetry = false;
  /** Why the current (or last) connect was started; shown in the history and on secret reads. */
  private trigger = "MCP Hub";
  /** Set while an idle stop is under way, so the history can tell it from other stops. */
  private stopReason?: "idle";
  private idleTimer?: NodeJS.Timeout;
  private generation = 0;
  private connecting?: Promise<void>;
  private wantConnected = false;
  /** A request still running after this long gets a warning in the log while it is going. */
  slowWarnMs = 30_000;
  /** Requests slower than this are logged when they finish, even if they succeed. */
  slowLogMs = 5_000;

  constructor(
    public config: ServerConfig,
    private readonly deps: UpstreamDeps,
  ) {
    super();
  }

  get id(): string {
    return this.config.id;
  }

  get logs(): LogBuffer {
    return this.deps.logs;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  status(): ServerStatus {
    const inUse = this.pending.size > 0 || (this.lastActivityAt !== null && Date.now() - this.lastActivityAt < ACTIVE_WINDOW_MS);
    const authenticated =
      this.state === "connected" && this.credentials !== "failed" && (this.config.auth !== "oauth" || !!this.oauth?.hasTokens);
    return {
      id: this.id,
      config: this.deps.reveal(this.config),
      state: this.state,
      authenticated,
      credentials: this.credentials,
      activeSessions: this.sessions.size,
      inFlight: this.pending.size,
      inUse,
      clients: this.attachedClients(),
      lastActivityAt: this.lastActivityAt,
      connectedAt: this.connectedAt,
      error: this.error,
      authUrl: this.state === "needs-auth" ? this.oauth?.authUrl : undefined,
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
      toolCount: this.toolCount,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      requests: this.requests,
      errors: this.errors,
      mcpUrl: this.deps.mcpUrl(this.id),
    };
  }

  /** Nothing else announces that the "in use" window has lapsed, so push one more update when it does. */
  private settleSoon(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.emit("change"), ACTIVE_WINDOW_MS + 300);
    this.settleTimer.unref();
  }

  /** Apps attached to this server, and which of them are using it right now. */
  private attachedClients(): ServerClient[] {
    const now = Date.now();
    const byId = new Map<string, ServerClient>();
    for (const h of this.sessions.values()) {
      const ref = h.client ?? { id: "unknown", name: "Unknown app" };
      const c = byId.get(ref.id) ?? { id: ref.id, name: ref.name, sessions: 0, inFlight: 0, active: false, lastActivityAt: null };
      c.sessions++;
      const last = this.sessionActivity.get(h.id) ?? null;
      if (last !== null && (c.lastActivityAt === null || last > c.lastActivityAt)) c.lastActivityAt = last;
      byId.set(ref.id, c);
    }
    for (const p of this.pending.values()) {
      const c = byId.get(this.sessions.get(p.sessionId)?.client?.id ?? "unknown");
      if (c) c.inFlight++;
    }
    for (const c of byId.values()) c.active = c.inFlight > 0 || (c.lastActivityAt !== null && now - c.lastActivityAt < ACTIVE_WINDOW_MS);
    return [...byId.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  private setState(state: ConnectionState, error?: string): void {
    const from = this.state;
    this.state = state;
    this.error = error;
    if (from !== state) this.emit("lifecycle", { from, to: state, trigger: this.trigger, idle: this.stopReason === "idle" } satisfies LifecycleEvent);
    this.emit("change");
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Connect (idempotent). Resolves when connected or rejects with the failure reason.
   * `trigger` says why, as a short phrase for the history ("Claude connected"); it is also what a secret read
   * made on the way is attributed to.
   */
  connect(trigger?: string): Promise<void> {
    this.wantConnected = true;
    if (this.state === "connected") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.trigger = this.autoRetry ? "Automatic retry" : (trigger ?? "MCP Hub");
    if (!this.autoRetry) {
      this.failures = 0;
      this.backoff = this.retryBaseMs;
    }
    this.clearReconnect();
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const gen = ++this.generation;
    this.setState("connecting");
    this.startupStderr = [];
    this.deps.logs.add("info", `Connecting (${this.config.transport})…`);

    let resolved: Resolved;
    try {
      resolved = await this.resolveConfig();
    } catch (err) {
      if (gen !== this.generation) return;
      this.credentials = "failed";
      const msg = err instanceof CredentialError ? err.message : `Could not resolve credentials: ${(err as Error).message}`;
      this.deps.logs.add("error", msg);
      this.setState("error", msg);
      // A refusal is the user's decision: don't keep re-prompting. They can press Retry.
      if (!(err instanceof CredentialError && err.kind === "denied")) this.scheduleReconnect();
      throw err;
    }
    if (gen !== this.generation) return;

    const transport = this.createTransport(resolved);
    this.transport = transport;
    this.wire(transport, gen);

    try {
      await transport.start();
      if (transport instanceof StdioClientTransport && transport.pid) this.deps.children?.add(transport.pid, resolved.command);
      await this.handshake(transport);
    } catch (err) {
      if (gen !== this.generation) return;
      await this.handleConnectFailure(err, transport, resolved, gen);
      if (this.state !== "connected") throw err;
      return;
    }
    if (gen !== this.generation) return;
    this.markConnected();
  }

  private markConnected(): void {
    this.connectedAt = Date.now();
    this.setState("connected");
    this.deps.logs.add("info", `Connected${this.serverInfo?.name ? ` to ${this.serverInfo.name} ${this.serverInfo.version ?? ""}` : ""}`);
    void this.refreshToolCount();
    this.armIdleTimer();
  }

  private async resolveConfig(): Promise<Resolved> {
    // The references are only readable for the duration of this call.
    const cfg = this.deps.reveal(this.config);
    const { broker } = this.deps;
    const templates = credentialTemplates(cfg);
    const needs = broker.needsCredentials(templates);
    this.credentials = needs ? "resolving" : "none";
    if (needs) this.emit("change");

    const secrets = new Set<string>();
    const track = async (s: string | undefined): Promise<string | undefined> => {
      if (s === undefined) return undefined;
      const v = await broker.resolveTemplate(s, cfg.id, this.trigger);
      if (v !== s) {
        secrets.add(v);
        const bearer = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v);
        if (bearer) secrets.add(bearer[1]!);
      }
      return v;
    };
    const command = (await track(cfg.command)) ?? "";
    const cwd = await track(cfg.cwd);
    const url = (await track(cfg.url)) ?? "";
    const args: string[] = [];
    for (const a of cfg.args ?? []) args.push((await track(a)) ?? "");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = (await track(v)) ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = (await track(v)) ?? "";
    const clientSecret = await track(cfg.oauth?.clientSecret);

    this.deps.logs.setSecrets(secrets);
    this.credentials = needs ? "ok" : "none";
    return { command, cwd, url, args, env, headers, clientSecret };
  }

  /**
   * The environment a stdio server starts with. On Windows the SDK adds its own default variables (`PATH`, `SYSTEMROOT`
   * …) in upper case, so ours are merged case-insensitively onto those first; otherwise the child could get `Path`
   * and `PATH` both and see either.
   */
  private childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    if (process.platform !== "win32") return { ...this.deps.baseEnv(), ...extra };
    return mergeEnv(getDefaultEnvironment(), mergeEnv(this.deps.baseEnv(), extra));
  }

  private createTransport(r: Resolved): Transport {
    const cfg = this.config;
    if (cfg.transport === "stdio") {
      const t = new StdioClientTransport({
        command: r.command,
        args: r.args,
        cwd: r.cwd || undefined,
        env: this.childEnv(r.env) as Record<string, string>,
        stderr: "pipe",
      });
      t.stderr?.on("data", (d: Buffer) => {
        const text = d.toString("utf-8");
        this.deps.logs.add("stderr", text);
        if (this.state === "connecting" && this.startupStderr.length < 50) this.startupStderr.push(...text.split(/\r?\n/).filter(Boolean));
      });
      return t;
    }
    if (cfg.auth === "oauth" && !this.oauth) {
      this.oauth = new HubOAuthProvider(
        this.deps.callbackUrl,
        { clientId: cfg.oauth?.clientId, clientSecret: r.clientSecret, scope: cfg.oauth?.scope },
        () => this.deps.logs.add("info", "Sign-in required"),
        this.deps.signIns && {
          remember: () => this.remembersSignIn(),
          origin: new URL(r.url).origin,
          load: () => this.deps.signIns?.get(this.id),
          save: (s) => this.deps.signIns?.set(this.id, s),
          clear: () => void this.deps.signIns?.delete(this.id),
        },
      );
    }
    return new StreamableHTTPClientTransport(new URL(r.url), {
      requestInit: { headers: r.headers },
      ...(this.oauth ? { authProvider: this.oauth } : {}),
    });
  }

  private wire(transport: Transport, gen: number): void {
    transport.onmessage = (m) => {
      if (gen === this.generation) this.onUpstreamMessage(m as Msg);
    };
    transport.onerror = (err) => {
      if (gen === this.generation) this.deps.logs.add("warn", `Transport error: ${err.message}`);
    };
    transport.onclose = () => {
      if (gen === this.generation) this.onTransportClosed();
    };
  }

  private rpc(method: string, params: Msg, timeoutMs: number, idPrefix = "hub-rpc"): Promise<Msg> {
    const id = `${idPrefix}-${++this.seq}`;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const onClose = (why: string) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(new Error(why));
      };
      this.once("transport-closed", onClose);
      this.waiters.set(id, (m) => {
        clearTimeout(timer);
        this.off("transport-closed", onClose);
        resolve(m);
      });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        this.off("transport-closed", onClose);
        reject(e);
      });
    });
  }

  private async handshake(transport: Transport): Promise<void> {
    const res = await this.rpc(
      "initialize",
      { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "MCP Hub", version: VERSION } },
      this.handshakeTimeoutMs,
      "hub-init",
    );
    if (res.error) throw new Error(`initialize failed: ${res.error.message ?? JSON.stringify(res.error)}`);
    const r = res.result ?? {};
    this.protocolVersion = r.protocolVersion;
    this.capabilities = r.capabilities ?? {};
    this.serverInfo = r.serverInfo;
    this.instructions = r.instructions;
    (transport as { setProtocolVersion?: (v: string) => void }).setProtocolVersion?.(r.protocolVersion);
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  }

  private async handleConnectFailure(err: unknown, transport: Transport, resolved: Resolved, gen: number): Promise<void> {
    if (err instanceof UnauthorizedError && this.oauth) {
      this.pendingAuthTransport = transport as StreamableHTTPClientTransport;
      this.setState("needs-auth", "Sign-in required");
      this.emit("needs-auth", this.oauth.authUrl);
      return;
    }
    // A 401 from a server that was imported without OAuth usually means it wants a browser sign-in.
    // Switch it to OAuth (unless the user supplied their own Authorization header) and try again.
    if (
      this.config.transport === "http" &&
      !this.oauth &&
      err instanceof StreamableHTTPError &&
      err.code === 401 &&
      !Object.keys(resolved.headers).some((h) => h.toLowerCase() === "authorization")
    ) {
      this.deps.logs.add("info", "The server requires sign-in; switching it to OAuth");
      await this.teardownTransport();
      this.config = { ...this.config, auth: "oauth" };
      this.emit("config-changed", this.config);
      const next = this.createTransport(resolved);
      this.transport = next;
      this.wire(next, gen);
      try {
        await next.start();
        await this.handshake(next);
        this.markConnected();
      } catch (e2) {
        await this.handleConnectFailure(e2, next, resolved, gen);
      }
      return;
    }
    // Servers that only speak the legacy HTTP+SSE protocol reject the streamable POST.
    if (this.config.transport === "http" && !this.oauth && err instanceof StreamableHTTPError && [400, 404, 405].includes(err.code ?? 0)) {
      this.deps.logs.add("info", "Streamable HTTP not supported; falling back to legacy SSE");
      try {
        this.transport = undefined;
        transport.onclose = undefined;
        await transport.close().catch(() => {});
        const extra = resolved.headers;
        const sse = new SSEClientTransport(new URL(resolved.url), {
          requestInit: { headers: extra },
          eventSourceInit: {
            fetch: (u: string | URL | Request, init?: RequestInit) =>
              fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...extra } }),
          },
        });
        this.transport = sse;
        this.wire(sse, gen);
        await sse.start();
        await this.handshake(sse);
        this.markConnected();
        return;
      } catch (e2) {
        err = e2;
      }
    }
    let msg = err instanceof Error ? err.message : String(err);
    const stderrHint = this.config.transport === "stdio" ? this.startupStderr.find((l) => AUTH_TEXT.test(l)) : undefined;
    if (isAuthFailure(err) || stderrHint) {
      // The server refused the token or the sign-in expired (a local server often says so only on stderr).
      // Trying again with the same thing can't succeed.
      const reason = serverReason(isAuthFailure(err) ? msg : stderrHint!);
      const code = err instanceof StreamableHTTPError && err.code ? ` (HTTP ${err.code})` : "";
      msg = `The server rejected the credentials${code}: ${reason}. Sign in again or replace the token in this server's settings, then press Retry.`;
      this.deps.logs.add("error", msg);
      await this.teardownTransport();
      this.setState("error", msg);
      return;
    }
    this.deps.logs.add("error", msg);
    await this.teardownTransport();
    this.setState("error", msg);
    this.scheduleReconnect();
  }

  /** Complete an OAuth sign-in with the code from the redirect, then reconnect. */
  async completeAuth(code: string, state: string | null): Promise<void> {
    if (!this.oauth || !this.pendingAuthTransport) throw new Error("No sign-in is pending for this server");
    if (this.oauth.expectedState && state !== this.oauth.expectedState) throw new Error("OAuth state mismatch");
    const t = this.pendingAuthTransport;
    this.pendingAuthTransport = undefined;
    await t.finishAuth(code);
    await this.teardownTransport();
    await this.connect();
  }

  /** The URL the user must open to sign in, if a sign-in is pending. */
  get authUrl(): string | undefined {
    return this.oauth?.authUrl;
  }

  async signOut(): Promise<void> {
    this.oauth?.signOut();
    this.deps.signIns?.delete(this.id);
    await this.disconnect();
  }

  private remembersSignIn(): boolean {
    return this.config.auth === "oauth" && (this.deps.rememberSignIn?.(this.config) ?? false);
  }

  /** The remember setting changed: save the current sign-in, or delete the saved one. */
  syncRememberedSignIn(): void {
    if (this.oauth) this.oauth.syncRemembered();
    else if (!this.remembersSignIn()) this.deps.signIns?.delete(this.id);
  }

  /** The server is being deleted: forget its saved sign-in. */
  forgetSignIn(): void {
    this.deps.signIns?.delete(this.id);
  }

  async disconnect(): Promise<void> {
    this.wantConnected = false;
    this.clearReconnect();
    this.clearIdle();
    this.generation++;
    this.failAllPending("Server was disconnected in MCP Hub");
    this.emit("transport-closed", "Disconnected");
    this.waiters.clear();
    await this.teardownTransport();
    this.pendingAuthTransport = undefined;
    this.connectedAt = null;
    this.credentials = "none";
    this.setState("disconnected");
    this.deps.logs.add("info", "Disconnected");
  }

  async restart(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  private async teardownTransport(): Promise<void> {
    const t = this.transport;
    this.transport = undefined;
    if (t) {
      t.onclose = undefined;
      // Whatever the server started (an npx wrapper's real server) is found now, before closing orphans it.
      const family = t instanceof StdioClientTransport && t.pid ? await descendantsOf(t.pid) : [];
      try {
        await t.close();
      } catch {
        // already gone
      }
      await stopLeftovers(family);
    }
  }

  private onTransportClosed(): void {
    this.deps.logs.add("warn", "Connection closed");
    this.emit("transport-closed", "The server closed the connection");
    this.failAllPending("Upstream connection closed");
    this.transport = undefined;
    // A connection that stayed up for a while was healthy, so the next drop starts a fresh set of retries.
    // One that dies right away keeps counting, so a server that crashes at startup can't loop forever.
    if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
      this.failures = 0;
      this.backoff = this.retryBaseMs;
    }
    this.connectedAt = null;
    if (this.state === "connected") this.setState("error", "Connection closed unexpectedly");
    if (this.wantConnected && this.config.lifecycle === "keep-alive") this.scheduleReconnect();
  }

  private scheduleReconnect(minDelay?: number): void {
    if (!this.wantConnected || !this.config.enabled || this.reconnectTimer) return;
    if (this.config.lifecycle !== "keep-alive" && this.sessions.size === 0) return;
    if (++this.failures > MAX_AUTO_RETRIES) {
      this.deps.logs.add("error", `Gave up after ${MAX_AUTO_RETRIES} failed attempts. Fix the problem above, then press Retry.`);
      this.setState("error", `${this.error ?? "The connection failed."} MCP Hub stopped retrying after ${MAX_AUTO_RETRIES} attempts; press Retry once it's fixed.`);
      return;
    }
    const delay = Math.max(this.backoff, minDelay ?? 0);
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.deps.logs.add("info", `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.failures} of ${MAX_AUTO_RETRIES})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.autoRetry = true;
      this.connect().catch(() => {});
      this.autoRetry = false;
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private armIdleTimer(): void {
    this.clearIdle();
    const mins = this.config.idleTimeoutMinutes ?? 0;
    if (this.config.lifecycle !== "on-demand" || mins <= 0) return;
    this.idleTimer = setInterval(() => {
      const idleFor = Date.now() - (this.lastActivityAt ?? this.connectedAt ?? Date.now());
      if (this.pending.size === 0 && idleFor > mins * 60_000) {
        this.deps.logs.add("info", `Idle for ${mins} min; disconnecting`);
        this.stopReason = "idle";
        void this.disconnect().finally(() => {
          this.stopReason = undefined;
        });
      }
    }, 30_000);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  // ---------------------------------------------------------------- sessions

  attach(h: DownstreamHandle): void {
    this.sessions.set(h.id, h);
    this.emit("change");
  }

  detach(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionActivity.delete(sessionId);
    for (const [k, v] of this.progress) if (v.sessionId === sessionId) this.progress.delete(k);
    this.emit("change");
  }

  /** The cached result for a downstream `initialize`. */
  initializeResult(): Msg {
    return {
      protocolVersion: this.protocolVersion ?? LATEST_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      serverInfo: this.serverInfo ?? { name: this.config.name, version: VERSION },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  /** Make sure the upstream is up before answering a downstream initialize. */
  async ensureConnected(trigger?: string): Promise<string | null> {
    if (this.state === "connected") return null;
    if (!this.config.enabled) return this.unavailableMessage();
    try {
      await this.connect(trigger);
    } catch {
      // reported through unavailableMessage
    }
    return this.isConnected() ? null : this.unavailableMessage();
  }

  /** Does this server's definition refer to any credential? */
  usesCredentials(): boolean {
    return this.deps.broker.needsCredentials(credentialTemplates(this.deps.reveal(this.config)));
  }

  /**
   * Read this server's secrets now, without starting it, so its first start doesn't wait for the credential
   * source. Each read is announced and recorded like any other. Failures are left for the real start to report.
   */
  async preloadCredentials(trigger: string): Promise<void> {
    const cfg = this.deps.reveal(this.config);
    for (const t of credentialTemplates(cfg)) {
      if (!t || !this.deps.broker.needsCredentials([t])) continue;
      try {
        await this.deps.broker.resolveTemplate(t, cfg.id, trigger);
      } catch {
        return;
      }
    }
  }

  /** Read through a method so TypeScript doesn't keep a stale narrowing across awaits. */
  private isConnected(): boolean {
    return this.state === "connected";
  }

  // ---------------------------------------------------------------- forwarding

  /**
   * Forward a downstream message. Requests resolve with the (id-restored) response;
   * notifications resolve with undefined.
   */
  async forward(sessionId: string, msg: Msg, onNotify?: (m: Msg) => void): Promise<Msg | undefined> {
    // The MCP handshake is connection overhead, not usage: don't count it or mark the server "in use".
    if (isNotification(msg) && msg.method === "notifications/initialized") return undefined;
    const size = bytes(msg);
    const client = this.sessions.get(sessionId)?.client?.name ?? "";
    // Only requests that are real use count (see countsAsUse); notifications and discovery are connection overhead.
    const use = isRequest(msg) && countsAsUse(msg.method);
    if (use) {
      this.bytesIn += size;
      this.lastActivityAt = Date.now();
      this.settleSoon();
      if (this.sessions.has(sessionId)) this.sessionActivity.set(sessionId, this.lastActivityAt);
      this.deps.metrics.record({ serverId: this.id, client, bytesIn: size });
    }

    if (this.state !== "connected" || !this.transport) {
      if (isRequest(msg) && this.config.enabled) {
        try {
          await this.connect(client ? `${client} sent a request` : undefined);
        } catch {
          // fall through to the error below
        }
      }
      if (this.state !== "connected" || !this.transport) {
        if (!isRequest(msg)) return undefined;
        if (use) {
          this.errors++;
          this.deps.metrics.record({ serverId: this.id, client, requests: 1, errors: 1 });
        }
        return rpcError(msg.id, -32000, this.unavailableMessage());
      }
    }

    if (isNotification(msg)) {
      if (msg.method === "notifications/initialized" || msg.method === "notifications/roots/list_changed") return undefined;
      if (msg.method === "notifications/cancelled" && msg.params?.requestId !== undefined) {
        for (const [uid, p] of this.pending) {
          if (p.sessionId === sessionId && p.origId === msg.params.requestId) {
            // The app gave up on it (this is what its own timeout looks like from here).
            this.deps.logs.add("warn", `${p.client || "The app"} cancelled ${requestLabel(p)} after ${seconds(Date.now() - p.started)}${msg.params.reason ? `: ${String(msg.params.reason).slice(0, 200)}` : ""}`);
            await this.send({ ...msg, params: { ...msg.params, requestId: uid } }).catch(() => {});
            break;
          }
        }
        return undefined;
      }
      await this.send(msg).catch((e) => this.deps.logs.add("warn", `send failed: ${(e as Error).message}`));
      return undefined;
    }

    // A response to a server-initiated request; the hub never forwards those downstream.
    if (!isRequest(msg)) return undefined;

    const uid = `h${++this.seq}`;
    const outbound: Msg = { ...msg, id: uid };
    let progressKey: string | undefined;
    const token = msg.params?._meta?.progressToken;
    if (token !== undefined) {
      progressKey = `p${this.seq}`;
      this.progress.set(progressKey, { sessionId, origToken: token });
      outbound.params = { ...msg.params, _meta: { ...msg.params._meta, progressToken: progressKey } };
    }
    const tool = msg.method === "tools/call" && typeof msg.params?.name === "string" ? (msg.params.name as string) : undefined;

    return new Promise<Msg>((resolve) => {
      // A request that is still running after a while is worth a line in the log, so a hang shows up as it happens.
      const watch = setTimeout(() => {
        const p = this.pending.get(uid);
        if (p) this.deps.logs.add("warn", `${requestLabel(p)} from ${p.client || "an app"} is still running after ${seconds(Date.now() - p.started)}`);
      }, this.slowWarnMs);
      watch.unref();
      this.pending.set(uid, { sessionId, client, origId: msg.id, started: Date.now(), method: msg.method, tool, progressKey, onNotify, resolve, watch });
      this.emit("change");
      this.send(outbound).catch((err) => this.onSendFailure(uid, err));
    });
  }

  private unavailableMessage(): string {
    if (!this.config.enabled) return `"${this.config.name}" is turned off in MCP Hub.`;
    if (this.state === "needs-auth") return `"${this.config.name}" needs sign-in. Open MCP Hub and click Sign in.`;
    if (this.state === "connecting") return `"${this.config.name}" is still starting. Try again in a moment.`;
    return `"${this.config.name}" is unavailable in MCP Hub${this.error ? `: ${this.error}` : ""}`;
  }

  private async send(msg: Msg): Promise<void> {
    if (!this.transport) throw new Error("Not connected");
    await this.transport.send(msg as JSONRPCMessage);
  }

  private onSendFailure(uid: string, err: unknown): void {
    const p = this.pending.get(uid);
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof UnauthorizedError) {
      message = "The server needs you to sign in again. Open MCP Hub.";
      this.setState("needs-auth", message);
    } else if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
      message = `The server rejected the credentials (HTTP ${err.code}): ${serverReason(err.message)}. Check this server's token in MCP Hub.`;
      this.error = message;
      this.emit("change");
    } else if (err instanceof StreamableHTTPError && err.code === 404) {
      // The upstream session expired; reconnecting creates a fresh one.
      void this.restart().catch(() => {});
    }
    this.deps.logs.add("error", `Request failed: ${message}`);
    if (p) this.completePending(uid, rpcError(p.origId, -32000, message));
  }

  private completePending(uid: string, response: Msg): void {
    const p = this.pending.get(uid);
    if (!p) return;
    this.pending.delete(uid);
    clearTimeout(p.watch);
    if (p.progressKey) this.progress.delete(p.progressKey);
    const latency = Date.now() - p.started;
    const out: Msg = { ...response, id: p.origId };
    const size = bytes(out);
    const failed = !!out.error || out.result?.isError === true;
    // Slow or failed requests are logged with how long they took and why, so a timeout can be traced afterwards.
    if (failed || latency >= this.slowLogMs) {
      const why = out.error?.message ?? (out.result?.isError ? String(out.result?.content?.[0]?.text ?? "tool reported an error") : "");
      this.deps.logs.add(failed ? "warn" : "info", `${requestLabel(p)} from ${p.client || "an app"}: ${failed ? `failed${why ? ` (${String(why).slice(0, 300)})` : ""}` : "ok"} in ${seconds(latency)}`);
    }
    const use = countsAsUse(p.method);
    if (use) {
      this.bytesOut += size;
      this.requests++;
      if (failed) this.errors++;
      this.lastActivityAt = Date.now();
      this.settleSoon();
      if (this.sessions.has(p.sessionId)) this.sessionActivity.set(p.sessionId, this.lastActivityAt);
      this.deps.metrics.record({
        serverId: this.id,
        client: p.client,
        bytesOut: size,
        requests: 1,
        errors: failed ? 1 : 0,
        latencyMs: latency,
        tool: p.tool,
        toolError: p.tool ? failed || out.result?.isError === true : undefined,
      });
    }
    this.emit("change");
    p.resolve(out);
  }

  private failAllPending(reason: string): void {
    for (const uid of [...this.pending.keys()]) {
      const p = this.pending.get(uid)!;
      this.completePending(uid, rpcError(p.origId, -32000, reason));
    }
  }

  private onUpstreamMessage(m: Msg): void {
    if (isResponse(m)) {
      if (typeof m.id === "string") {
        const w = this.waiters.get(m.id);
        if (w) {
          this.waiters.delete(m.id);
          w(m);
          return;
        }
        this.completePending(m.id, m);
      }
      return;
    }
    if (isRequest(m)) {
      // The hub declares no client capabilities, so only ping is legitimate.
      const reply = m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : rpcError(m.id, -32601, `Method not supported by MCP Hub: ${m.method}`);
      void this.send(reply).catch(() => {});
      return;
    }
    if (isNotification(m)) {
      const size = bytes(m);
      // Anything the server says while the hub is still connecting is handshake chatter, not usage.
      if (this.state === "connected") {
        this.bytesOut += size;
        this.lastActivityAt = Date.now();
        this.deps.metrics.record({ serverId: this.id, bytesOut: size });
      }
      if (m.method === "notifications/progress" && m.params?.progressToken !== undefined) {
        const key = String(m.params.progressToken);
        const route = this.progress.get(key);
        if (route) {
          const out = { ...m, params: { ...m.params, progressToken: route.origToken } };
          const owner = [...this.pending.values()].find((p) => p.progressKey === key);
          if (owner?.onNotify) owner.onNotify(out);
          else this.sessions.get(route.sessionId)?.push(out);
          return;
        }
      }
      if (m.method === "notifications/tools/list_changed") void this.refreshToolCount();
      for (const s of this.sessions.values()) s.push(m);
    }
  }

  private async refreshToolCount(): Promise<void> {
    if (!this.capabilities.tools || this.state !== "connected") return;
    try {
      const res = await this.rpc("tools/list", {}, 15_000, "hub-tools");
      if (Array.isArray(res.result?.tools)) {
        this.toolCount = res.result.tools.length;
        this.emit("change");
      }
    } catch {
      // Tool count is informational.
    }
  }

  /** Call tools/list on demand for the UI. */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    await this.connect();
    const res = await this.rpc("tools/list", {}, 15_000, "hub-tools");
    if (res.error) throw new Error(res.error.message ?? "tools/list failed");
    return (res.result?.tools ?? []).map((t: Msg) => ({ name: t.name, description: t.description }));
  }

  updateConfig(config: ServerConfig): void {
    this.config = config;
    this.emit("change");
  }

  /** Zero the running totals (the usage history is cleared separately). */
  resetStats(): void {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.requests = 0;
    this.errors = 0;
    this.emit("change");
  }
}
