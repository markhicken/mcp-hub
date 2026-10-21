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
export const socketPath = (dir = dataDir()) => join(dir, "hub.sock");
export const usageDbPath = (dir = dataDir()) => join(dir, "usage.sqlite");
export const historyDbPath = (dir = dataDir()) => join(dir, "history.sqlite");
export const childrenPath = (dir = dataDir()) => join(dir, "children.json");
