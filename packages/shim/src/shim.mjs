#!/usr/bin/env node
// mcp-hub-stdio: lets stdio-only MCP clients (e.g. Claude Desktop) talk to a server proxied by MCP Hub.
//
//   mcp-hub-stdio <server-id> [--url http://127.0.0.1:47615] [--token <client token>]
//
// Environment: MCP_HUB_URL, MCP_HUB_CLIENT_TOKEN, MCP_HUB_HOME (to find runtime.json).
// Zero dependencies on purpose so it starts fast and can be packaged as a tiny executable.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 47615;

const isPipe = (p) => /^\\\\[.?]\\pipe\\/i.test(p);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Is the hub's socket worth trying? A Unix socket is a file. A Windows named pipe is not reliably visible to
 * `existsSync` (probing it can even take a pipe instance), so the pipe is trusted while the hub that made it is alive;
 * a leftover runtime.json from a crashed hub names a dead pid, and the shim then falls back to HTTP.
 */
function socketUsable(rt) {
  if (!rt.socket) return false;
  return isPipe(rt.socket) ? Boolean(rt.pid) && pidAlive(rt.pid) : existsSync(rt.socket);
}

function dataDir() {
  if (process.env.MCP_HUB_HOME) return process.env.MCP_HUB_HOME;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "MCP Hub");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "MCP Hub");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "mcp-hub");
}

function parseArgs(argv) {
  const out = { id: "", url: process.env.MCP_HUB_URL || "", token: process.env.MCP_HUB_CLIENT_TOKEN || "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i] || "";
    else if (a === "--token") out.token = argv[++i] || "";
    else if (!out.id && !a.startsWith("-")) out.id = a;
  }
  return out;
}

/** Find the hub: explicit URL, else the running instance's runtime.json, else the default port. */
export function discover(opts) {
  let base = opts.url;
  let token = opts.token;
  let socket = "";
  if (!base) {
    try {
      const rt = JSON.parse(readFileSync(join(dataDir(), "runtime.json"), "utf-8"));
      base = `http://127.0.0.1:${rt.port}`;
      if (!token && rt.clientToken) token = rt.clientToken;
      // The socket is the normal way in: the hub asks the user to approve this app once.
      if (socketUsable(rt)) socket = rt.socket;
    } catch {
      base = `http://127.0.0.1:${DEFAULT_PORT}`;
    }
  }
  return { base: base.replace(/\/+$/, ""), token, socket };
}

/** fetch over the hub's local socket (a Unix socket, or a Windows named pipe), returning a standard Response. */
function socketFetch(socketPath, url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { socketPath, path: u.pathname + u.search, method: init.method || "GET", headers: { ...init.headers, host: "mcp-hub" }, signal: init.signal },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const noBody = [204, 205, 304].includes(res.statusCode);
        resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const rpcError = (id, message, code = -32000) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function run(argv = process.argv.slice(2), io = { stdin: process.stdin, write: (s) => process.stdout.write(s) }) {
  const opts = parseArgs(argv);
  if (!opts.id) {
    process.stderr.write("usage: mcp-hub-stdio <server-id> [--url URL] [--token TOKEN]\n");
    process.exit(2);
  }

  let sessionId = "";
  let initMessage = null;
  let streamAbort = null;
  let closed = false;
  let inflight = 0;
  let reinitPromise = null;

  const emit = (m) => io.write(JSON.stringify(m) + "\n");

  const target = () => {
    // Re-discover on every use: the hub may have restarted on a different port.
    const { base, token, socket } = discover(opts);
    return { url: `${base}/mcp/${encodeURIComponent(opts.id)}`, token, socket };
  };

  /** Over the socket when the hub offers one (no token needed), otherwise plain HTTP. */
  const hubFetch = (url, init) => {
    const { socket } = discover(opts);
    return socket ? socketFetch(socket, url, init) : fetch(url, init);
  };

  const headers = (extra = {}) => {
    const { token } = target();
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-MCP-Hub-Pid": String(process.pid),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  };

  async function readSse(body, onData) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) onData(data);
      }
    }
  }

  function deliver(text) {
    try {
      const parsed = JSON.parse(text);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m);
    } catch {
      process.stderr.write("mcp-hub-stdio: dropped non-JSON payload\n");
    }
  }

  /** POST one message. Responses are written to stdout as they arrive; returns the HTTP status. */
  async function post(msg, waitUntil = Date.now() + 5 * 60_000) {
    const res = await hubFetch(target().url, { method: "POST", headers: headers(), body: JSON.stringify(msg) });
    if (res.status === 403) {
      // The hub is asking the user whether this app may connect: keep trying while it waits.
      const text = await res.text();
      let info = null;
      try {
        info = JSON.parse(text)?.error ?? null;
      } catch {
        // not JSON
      }
      if (info?.data?.approval === "pending" && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, 500));
        return post(msg, waitUntil);
      }
      throw Object.assign(new Error(info?.message || "HTTP 403"), { status: 403, hubMessage: info?.message });
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (res.status === 202 || res.status === 204) return res.status;
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("text/event-stream")) {
      await readSse(res.body, deliver);
      return res.status;
    }
    const text = await res.text();
    if (res.ok) {
      deliver(text);
      return res.status;
    }
    // Non-2xx with a JSON-RPC error body is still meaningful for the client.
    try {
      const j = JSON.parse(text);
      if (j && j.error && msg.id !== undefined && res.status !== 404) {
        emit({ ...j, id: msg.id });
        return res.status;
      }
    } catch {
      // not JSON
    }
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  }

  function openStream() {
    if (!sessionId || streamAbort || closed) return;
    const ac = new AbortController();
    streamAbort = ac;
    hubFetch(target().url, { method: "GET", headers: headers({ Accept: "text/event-stream" }), signal: ac.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        await readSse(res.body, deliver);
      })
      .catch(() => {})
      .finally(() => {
        streamAbort = null;
        if (!closed && sessionId) setTimeout(openStream, 3000).unref?.();
      });
  }

  async function reinit() {
    if (!initMessage) throw new Error("no session to re-establish");
    reinitPromise ??= (async () => {
      sessionId = "";
      const res = await hubFetch(target().url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...initMessage, id: `reinit-${Date.now()}` }),
      });
      const sid = res.headers.get("mcp-session-id");
      if (!sid) throw new Error(`could not re-initialize (HTTP ${res.status})`);
      sessionId = sid;
      await res.text();
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      streamAbort?.abort();
    })().finally(() => {
      reinitPromise = null;
    });
    return reinitPromise;
  }

  async function handle(msg) {
    const isRequest = msg && msg.method !== undefined && msg.id !== undefined;
    if (msg && msg.method === "initialize") initMessage = msg;
    try {
      try {
        await post(msg);
      } catch (err) {
        // 404 = the hub dropped our session (restart/idle). Start a fresh one and retry once.
        if (err.status === 404 && msg.method !== "initialize" && initMessage) {
          await reinit();
          await post(msg);
        } else throw err;
      }
      if (msg.method === "initialize") openStream();
    } catch (err) {
      if (!isRequest) return;
      const status = err.status;
      let text;
      if (status === 401) text = "MCP Hub requires a client token. Set MCP_HUB_CLIENT_TOKEN for this connection.";
      else if (status === 403 && err.hubMessage) text = err.hubMessage;
      else if (status) text = `MCP Hub returned HTTP ${status}.`;
      else text = "MCP Hub isn't running. Open the MCP Hub app, then try again.";
      emit(rpcError(msg.id, text));
    }
  }

  const rl = createInterface({ input: io.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      emit(rpcError(null, "Parse error", -32700));
      return;
    }
    inflight++;
    handle(msg).finally(() => inflight--);
  });

  await new Promise((resolve) => rl.on("close", resolve));
  closed = true;
  // Let in-flight requests finish (bounded), then end the hub session politely.
  const deadline = Date.now() + 5000;
  while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  streamAbort?.abort();
  if (sessionId) {
    await hubFetch(target().url, { method: "DELETE", headers: headers() }).catch(() => {});
  }
}

/** Is this file the program being run? Compares real paths (a symlinked install or folder makes `argv[1]` differ from `import.meta.url`); Windows ignores case, and a single executable may be launched by a bare name without `.exe`. */
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const norm = (p) => (process.platform === "win32" ? real(p).toLowerCase().replace(/\.exe$/, "") : real(p));
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  // Windows pipes can still hold unwritten output when the process ends; let it drain before exiting.
  const exit = (code) => process.stdout.write("", () => process.exit(code));
  run().then(
    () => exit(0),
    (err) => {
      process.stderr.write(`mcp-hub-stdio: ${err?.stack || err}\n`);
      exit(1);
    },
  );
}
