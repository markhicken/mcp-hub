import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubManager } from "./manager.js";
import type { Metrics } from "./metrics.js";
import type { ClientRef } from "./types.js";
import type { UpstreamConnection } from "./upstream.js";

type Msg = Record<string, any>;

const MAX_BODY = 32 * 1024 * 1024;
const SESSION_IDLE_MS = 30 * 60_000;
const HEARTBEAT_MS = 25_000;

/** Used for connections that did not come through the approved local socket. */
export const DIRECT_CLIENT: ClientRef = { id: "direct", name: "Direct HTTP" };

interface Session {
  id: string;
  serverId: string;
  client: ClientRef;
  streams: Set<ServerResponse>;
  lastSeen: number;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpStatusError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpStatusError(400, "Invalid JSON");
  }
}

const rpcErr = (id: string | number | null, code: number, message: string): Msg => ({ jsonrpc: "2.0", id, error: { code, message } });

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sse(res: ServerResponse, msg: Msg): void {
  if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
}

/**
 * The per-server Streamable HTTP endpoint (`/mcp/<id>`). Each downstream client gets a session;
 * all sessions of a server share one upstream connection.
 */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly manager: HubManager,
    private readonly metrics: Metrics,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.streams.size === 0 && now - s.lastSeen > SESSION_IDLE_MS) this.drop(s.id);
    }
  }

  private drop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    for (const r of s.streams) r.end();
    this.manager.get(s.serverId)?.detach(sessionId);
  }

  /** Called when a server is removed or its connection is reset. */
  dropServerSessions(serverId: string): void {
    for (const s of [...this.sessions.values()]) if (s.serverId === serverId) this.drop(s.id);
  }

  /** Called when an app quits: it can't send a DELETE, so its sessions would otherwise linger until idle. */
  dropClientSessions(clientId: string): void {
    for (const s of [...this.sessions.values()]) if (s.client.id === clientId) this.drop(s.id);
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }

  async handle(req: IncomingMessage, res: ServerResponse, serverId: string, client: ClientRef = DIRECT_CLIENT): Promise<void> {
    const conn = this.manager.get(serverId);
    if (!conn) return sendJson(res, 404, rpcErr(null, -32001, `No MCP server named "${serverId}" in MCP Hub`));
    switch (req.method) {
      case "POST":
        return this.post(req, res, conn, client);
      case "GET":
        return this.get(req, res, conn);
      case "DELETE":
        return this.del(req, res, conn);
      default:
        res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
    }
  }

  private session(req: IncomingMessage, conn: UpstreamConnection): Session | "missing" | "unknown" {
    const id = req.headers["mcp-session-id"];
    if (typeof id !== "string" || !id) return "missing";
    const s = this.sessions.get(id);
    if (!s || s.serverId !== conn.id) return "unknown";
    s.lastSeen = Date.now();
    return s;
  }

  private newSession(conn: UpstreamConnection, client: ClientRef): Session {
    const s: Session = { id: randomUUID(), serverId: conn.id, client, streams: new Set(), lastSeen: Date.now() };
    this.sessions.set(s.id, s);
    conn.attach({
      id: s.id,
      client,
      push: (m) => {
        for (const r of s.streams) sse(r, m);
      },
    });
    return s;
  }

  private async post(req: IncomingMessage, res: ServerResponse, conn: UpstreamConnection, client: ClientRef): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const e = err as HttpStatusError;
      return sendJson(res, e.status ?? 400, rpcErr(null, -32700, e.message));
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as Msg[];
    if (!messages.length || messages.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
      return sendJson(res, 400, rpcErr(null, -32600, "Invalid JSON-RPC message"));
    }

    const init = messages.find((m) => m.method === "initialize" && m.id !== undefined);
    if (init) {
      const unavailable = await conn.ensureConnected(`${client.name || "An app"} connected`);
      // Connecting is not usage, so none of this is counted in the usage history.
      if (unavailable) {
        conn.logs.add("warn", `${client.name} couldn't connect: ${unavailable}`);
        return sendJson(res, 200, rpcErr(init.id, -32000, unavailable));
      }
      const s = this.newSession(conn, client);
      const out = { jsonrpc: "2.0", id: init.id, result: conn.initializeResult() };
      return sendJson(res, 200, out, { "Mcp-Session-Id": s.id });
    }

    const found = this.session(req, conn);
    if (found === "missing") return sendJson(res, 400, rpcErr(null, -32600, "Missing Mcp-Session-Id header. Send initialize first."));
    if (found === "unknown") return sendJson(res, 404, rpcErr(null, -32001, "Unknown or expired session. Initialize again."));
    const session = found;

    const requests = messages.filter((m) => typeof m.method === "string" && m.id !== undefined);
    const others = messages.filter((m) => !(typeof m.method === "string" && m.id !== undefined));

    for (const m of others) void conn.forward(session.id, m).catch(() => {});
    if (!requests.length) {
      res.writeHead(202).end();
      return;
    }

    const wantsSse = String(req.headers.accept ?? "").includes("text/event-stream");
    let closed = false;
    let answered = false;
    const waitingFor = requests.filter((m) => m.method !== "ping").map((m) => (m.method === "tools/call" && typeof m.params?.name === "string" ? `${m.method} ${m.params.name}` : m.method));
    const startedAt = Date.now();
    res.on("close", () => {
      closed = true;
      // The app dropped the connection before the server answered: usually its own timeout.
      if (!answered && waitingFor.length) conn.logs.add("warn", `${client.name} disconnected after ${((Date.now() - startedAt) / 1000).toFixed(1)}s while waiting for ${waitingFor.join(", ")}`);
    });
    if (wantsSse) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    }

    const responses = await Promise.all(
      requests.map(async (m) => {
        if (m.method === "ping") {
          const pong = { jsonrpc: "2.0", id: m.id, result: {} } as Msg;
          if (wantsSse && !closed) sse(res, pong);
          return pong;
        }
        const r = await conn.forward(session.id, m, (n) => {
          if (wantsSse && !closed) sse(res, n);
        });
        if (wantsSse && r && !closed) sse(res, r);
        return r ?? rpcErr(m.id, -32603, "No response from server");
      }),
    );

    answered = true;
    if (closed) return;
    if (wantsSse) {
      res.end();
      return;
    }
    sendJson(res, 200, batch ? responses : responses[0]);
  }

  private get(req: IncomingMessage, res: ServerResponse, conn: UpstreamConnection): void {
    const found = this.session(req, conn);
    if (found === "missing") return sendJson(res, 400, rpcErr(null, -32600, "Missing Mcp-Session-Id header"));
    if (found === "unknown") return sendJson(res, 404, rpcErr(null, -32001, "Unknown or expired session"));
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      return sendJson(res, 406, rpcErr(null, -32600, "Accept must include text/event-stream"));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(": connected\n\n");
    found.streams.add(res);
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);
    res.on("close", () => {
      clearInterval(beat);
      found.streams.delete(res);
    });
  }

  private del(req: IncomingMessage, res: ServerResponse, conn: UpstreamConnection): void {
    const found = this.session(req, conn);
    if (found === "missing") return sendJson(res, 400, rpcErr(null, -32600, "Missing Mcp-Session-Id header"));
    if (found === "unknown") return sendJson(res, 404, rpcErr(null, -32001, "Unknown or expired session"));
    this.drop(found.id);
    res.writeHead(200).end();
  }
}
