import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildRegistry } from "./children.js";
import { Hub } from "./hub.js";
import { childrenPath, configPath, dataDir, historyDbPath, runtimePath, socketPath, usageDbPath } from "./paths.js";
import { loadShellEnv, mergeEnv } from "./system.js";
import { trace } from "./trace.js";
import { VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function existingInstance(dir: string): Promise<{ port: number } | null> {
  try {
    const { readFileSync } = await import("node:fs");
    const rt = JSON.parse(readFileSync(runtimePath(dir), "utf-8")) as { pid: number; port: number };
    if (!pidAlive(rt.pid)) return null;
    const res = await fetch(`http://127.0.0.1:${rt.port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string };
    return body.app === "mcp-hub" ? { port: rt.port } : null;
  } catch {
    return null;
  }
}

function findUiDir(): string | undefined {
  const candidates = [process.env.MCP_HUB_UI_DIR, resolve(here, "../../ui/dist"), resolve(here, "../ui"), resolve(here, "ui")];
  return candidates.find((c): c is string => !!c && existsSync(join(c, "index.html")));
}

function findShim(): { command: string; args: string[] } | undefined {
  if (process.env.MCP_HUB_SHIM) return { command: process.env.MCP_HUB_SHIM, args: [] };
  const dev = resolve(here, "../../shim/src/shim.mjs");
  if (existsSync(dev)) return { command: process.execPath, args: [dev] };
  return undefined;
}

export async function main(): Promise<void> {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  // The local socket lives here; keep other users out of the directory.
  try {
    chmodSync(dir, 0o700);
  } catch {}

  const running = await existingInstance(dir);
  trace("checked for a running hub");
  if (running) {
    process.stderr.write(`MCP Hub is already running on port ${running.port}\n`);
    process.stdout.write(JSON.stringify({ event: "already-running", port: running.port }) + "\n");
    process.exit(3);
  }

  // Stop servers a previous hub left behind if it was killed before it could stop them.
  const swept = await new ChildRegistry(childrenPath(dir)).sweep();
  if (swept) process.stderr.write(`Stopped ${swept} leftover MCP server process${swept === 1 ? "" : "es"} from a previous run\n`);
  trace("swept leftover servers");

  const shellEnv = await loadShellEnv();
  trace("loaded the environment");
  const baseEnv = mergeEnv(process.env, shellEnv);
  for (const k of Object.keys(baseEnv)) if (k.startsWith("MCP_HUB_")) delete baseEnv[k];

  const uiToken = process.env.MCP_HUB_TOKEN || randomBytes(24).toString("base64url");
  trace("opening the hub (key store, config, databases)");
  const hub = new Hub({
    dataDir: dir,
    configPath: configPath(dir),
    metricsPath: usageDbPath(dir),
    historyPath: historyDbPath(dir),
    socketPath: socketPath(dir),
    uiToken,
    uiDir: findUiDir(),
    shim: findShim(),
    baseEnv: () => baseEnv,
    extraOrigins: process.env.MCP_HUB_DEV_ORIGIN ? process.env.MCP_HUB_DEV_ORIGIN.split(",") : [],
  });

  const preferred = Number(process.env.MCP_HUB_PORT) || hub.store.settings.port;
  trace("hub opened, starting to listen");
  const port = await hub.listen(preferred);
  trace("listening");

  const writeRuntime = () =>
    writeFileSync(
      runtimePath(dir),
      JSON.stringify({ pid: process.pid, port, socket: hub.socket, version: VERSION, startedAt: Date.now(), clientToken: hub.store.settings.requireClientToken ? hub.store.settings.clientToken : undefined }),
      { mode: 0o600 },
    );
  writeRuntime();
  hub.manager.on("change", () => {
    // Keep the client token in the runtime file in sync with the setting.
    try {
      writeRuntime();
    } catch {}
  });

  const ready = { event: "ready", port, token: uiToken, url: `${hub.baseUrl}/?token=${uiToken}`, version: VERSION };
  process.stdout.write(JSON.stringify(ready) + "\n");
  process.stderr.write(`MCP Hub ${VERSION} listening on ${hub.baseUrl}\nOpen the UI: ${ready.url}\n`);

  void hub.startServers();

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      await hub.stop();
    } finally {
      rmSync(runtimePath(dir), { force: true });
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
  // Windows: Ctrl+Break and closing the console window.
  process.on("SIGBREAK", () => void shutdown());
  // The desktop shell keeps our stdin open; if it dies, so do we.
  if (process.argv.includes("--exit-on-stdin-close")) {
    process.stdin.resume();
    process.stdin.on("end", () => void shutdown());
    process.stdin.on("close", () => void shutdown());
  }
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaught: ${err.stack ?? err}\n`);
    // Nothing is known about the state now. Stop the servers and exit so the app can offer a clean restart,
    // rather than keep running half-broken. If stopping hangs, don't wait for it.
    setTimeout(() => process.exit(1), 10_000).unref();
    void shutdown(1);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  });
}
