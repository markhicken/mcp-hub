import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.MCP_HUB_HOME) return process.env.MCP_HUB_HOME;
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "MCP Hub");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "MCP Hub");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "mcp-hub");
  }
}

export const configPath = (dir = dataDir()) => join(dir, "config.json");
export const runtimePath = (dir = dataDir()) => join(dir, "runtime.json");
/**
 * Where apps reach the hub: a Unix socket in the data directory (mode 0600), or on Windows a named pipe with a random
 * name made for each run. Pipes have no file permissions to lean on, so the unguessable name, kept only in
 * `runtime.json` inside the user's own profile, is what keeps other accounts out.
 */
export const socketPath = (dir = dataDir(), platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? `\\\\.\\pipe\\mcp-hub-${randomBytes(16).toString("hex")}` : join(dir, "hub.sock");
export const isPipePath = (p: string): boolean => /^\\\\[.?]\\pipe\\/i.test(p);
export const usageDbPath = (dir = dataDir()) => join(dir, "usage.sqlite");
export const historyDbPath = (dir = dataDir()) => join(dir, "history.sqlite");
export const childrenPath = (dir = dataDir()) => join(dir, "children.json");
