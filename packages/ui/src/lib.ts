import type { ServerConfig } from "./types";

const platformName = typeof navigator === "undefined" ? "" : navigator.platform || "";
export const isMac = /^(mac|darwin)/i.test(platformName);
export const isWindows = /^win/i.test(platformName);
/** What this system calls its file manager, for labels such as "Show in Finder". */
export const fileManager = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

export function formatMs(ms: number): string {
  if (!ms) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function timeAgo(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "in 12m" for a future timestamp. */
export function timeUntil(t: number, now = Date.now()): string {
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#22c55e", "#0ea5e9", "#a855f7", "#ef4444", "#84cc16", "#f97316"];

/** Stable color per server id so cards, charts and tables agree. */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "server"
  );
}

/** Split a command line into args, honoring simple single and double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

type Raw = Record<string, unknown>;

function toConfig(name: string, raw: Raw): Partial<ServerConfig> | null {
  const url = (raw.url ?? raw.serverUrl) as string | undefined;
  if (typeof url === "string") {
    return {
      name,
      transport: "http",
      url,
      headers: raw.headers && typeof raw.headers === "object" ? (raw.headers as Record<string, string>) : undefined,
      auth: "none",
    };
  }
  if (typeof raw.command === "string") {
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
    };
  }
  return null;
}

/**
 * Parse a pasted config: either one `{command,args,env}` / `{url,headers}` object,
 * or the common `{"mcpServers": {name: {...}}}` form.
 */
export function parseServerJson(text: string): Array<Partial<ServerConfig>> {
  let json: Raw;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That isn't valid JSON.");
  }
  const map = (json.mcpServers ?? json.servers) as Record<string, Raw> | undefined;
  if (map && typeof map === "object") {
    const out = Object.entries(map)
      .map(([name, raw]) => toConfig(name, raw))
      .filter((c): c is Partial<ServerConfig> => !!c);
    if (!out.length) throw new Error("No usable servers found in that config.");
    return out;
  }
  const single = toConfig("My server", json);
  if (!single) throw new Error("Expected a `command` (local server) or `url` (remote server).");
  return [single];
}

/** Does a value look like a credential reference template? */
export function isCredentialRef(v: string): boolean {
  return /\{\{\s*(op|keychain|vault|env|secret):\/\//.test(v) || /^(op|keychain|vault|env|secret):\/\//.test(v.trim());
}
