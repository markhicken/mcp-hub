// The made-up setup shown in the README screenshots. Nothing here comes from a real machine: the servers,
// paths, traffic and app are invented to match what the screenshots have always shown. Edit this file to change
// what the screenshots show, then run `npm run screenshots`.
import type { ServerConfig, ServerStatus, Snapshot, UsageResult } from "../../packages/ui/src/types.ts";

/** The moment the screenshots are taken at (the page's clock is pinned to it, so "last 24h" never drifts). */
export const NOW = Date.UTC(2026, 0, 15, 5, 30);
const MINUTE = 60_000;

interface DemoServer {
  /** Card icon colors come from the id, so ids with a numeric tail are picked to give the colors the screenshots have always had. */
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** stdio: the program and its arguments. http: the URL. */
  command?: string;
  args?: string[];
  url?: string;
  notes?: string;
  labels?: string[];
  tools: number;
  /** Connected with nothing to authenticate (shown as "Idle" instead of "Authenticated"). */
  idle?: boolean;
}

// Labels are an addition for the screenshots (the old ones had none). In card order. The first eight are the cards visible in the existing Servers screenshot (name, transport, shown
// command or URL, status, tool count and notes icon are read from it; the hidden tail of each truncated command is
// a guess). Pipeliner only appears in the Usage legend, so everything about them except the name is a guess.
export const SERVERS: DemoServer[] = [
  { id: "outlook-desktop", labels: ["Work"], name: "Outlook Desktop", transport: "stdio", command: "/Users/me/.local/bin/uv", args: ["--directory", "/Users/me/Work/Repositories/outlook-desktop-mcp", "run", "outlook-desktop-mcp"], tools: 27 },
  { id: "wiki", labels: ["Work"], name: "Wiki", transport: "stdio", command: "node", args: ["/Users/me/Work/Repositories/mcp-wiki/dist/index.js"], tools: 9 },
  { id: "docs-master-15", labels: ["Work"], name: "Docs Master", transport: "http", url: "https://api.docsmaster.null/api/v1/mcp", notes: "Internal docs search. Needs the VPN.", tools: 40, idle: true },
  { id: "github-3", labels: ["Personal"], name: "GitHub", transport: "stdio", command: "/Users/me/Work/Repositories/github-mcp-server/github-mcp-server", args: ["stdio"], tools: 51 },
  { id: "jira", labels: ["Work"], name: "Jira", transport: "stdio", command: "node", args: ["/Users/me/Work/Repositories/mcp-jira/dist/index.js"], tools: 30 },
  { id: "playwright", labels: ["Personal"], name: "Playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"], tools: 25 },
  { id: "chrome-devtools", labels: ["Personal"], name: "Chrome DevTools", transport: "stdio", command: "npx", args: ["chrome-devtools-mcp@latest"], tools: 32 },
  { id: "snuffy-18", labels: ["Personal"], name: "Snuffy", transport: "http", url: "https://snuffy.io.null/mcp", notes: "Sandbox account.", tools: 4 },
  { id: "pipeliner-6", labels: ["Work"], name: "Pipeliner", transport: "stdio", command: "npx", args: ["@pipeliner/mcp@latest"], tools: 18 },
];

const CLIENT = { id: "claude-1", name: "Claude" };

function server(d: DemoServer): ServerStatus {
  const config: ServerConfig = {
    id: d.id,
    name: d.name,
    transport: d.transport,
    ...(d.transport === "http" ? { url: d.url } : { command: d.command, args: d.args }),
    ...(d.notes ? { notes: d.notes } : {}),
    ...(d.labels ? { labels: d.labels } : {}),
    enabled: true,
    lifecycle: "keep-alive",
  };
  return {
    id: d.id,
    config,
    state: "connected",
    authenticated: !d.idle,
    credentials: "none",
    activeSessions: 0,
    inFlight: 0,
    inUse: false,
    clients: [],
    lastActivityAt: null,
    connectedAt: NOW - 20 * MINUTE,
    toolCount: d.tools,
    bytesIn: 0,
    bytesOut: 0,
    requests: 0,
    errors: 0,
    mcpUrl: `http://127.0.0.1:47615/mcp/${d.id}`,
  };
}

export function snapshot(version: string): Snapshot {
  return {
    version,
    platform: "darwin",
    port: 47615,
    baseUrl: "http://127.0.0.1:47615",
    shim: null,
    socket: null,
    clients: [
      { id: CLIENT.id, name: CLIENT.name, pid: 4242, path: "/Applications/Claude.app", status: "allowed", since: NOW - 3 * 3_600_000, lastSeen: NOW - 15 * MINUTE, requests: 30, servers: SERVERS.map((s) => s.id), allowed: null, identity: "claude", remembered: true, running: true },
    ],
    servers: SERVERS.map(server),
    sources: [],
    credentials: {
      cached: [],
      reading: [],
      manualSecrets: [],
      signIns: { available: true, remembered: [] },
      encryption: { algorithm: "aes-256-gcm", keyStore: "keychain", persistent: true, locked: false },
    },
    settings: {
      port: 47615,
      rememberSignIns: true,
      signInTtlSeconds: 86_400,
      cacheTtlSeconds: 900,
      denialCooldownSeconds: 60,
      requireClientToken: false,
      allowTcpMcp: false,
      clientToken: "",
      retentionDays: 30,
      notifyOnCredentialPrompt: true,
      preloadSecrets: false,
      onboarded: true,
      recoveryKeySaved: true,
    },
    signing: { adHoc: false },
    environment: { vaultAddress: null },
  };
}

// Requests per 15-minute bucket for each server, in the order the legend lists them.
const BUCKETS = [NOW - 60 * MINUTE, NOW - 45 * MINUTE, NOW - 15 * MINUTE].map((t) => Math.floor(t / (15 * MINUTE)) * 15 * MINUTE);
const REQUESTS: Array<[string, [number, number, number]]> = [
  ["github-3", [2, 0, 2]],
  ["jira", [1, 0, 1]],
  ["wiki", [2, 0, 2]],
  ["chrome-devtools", [1, 0, 1]],
  ["outlook-desktop", [3, 0, 3]],
  ["playwright", [1, 3, 1]],
  ["pipeliner-6", [1, 0, 1]],
  ["docs-master-15", [0, 0, 1]],
  ["snuffy-18", [0, 0, 2]],
];
const BYTES_PER_REQUEST = 17_000;
/** Makes the total come to "506 KB". */
const EXTRA_BYTES = 8_000;
const LATENCY_AVG_MS = 2000;
const LATENCY_P95_MS: Record<string, number> = { "github-3": 5000, "outlook-desktop": 4000, "docs-master-15": 3500 };

export function usage(): UsageResult {
  const points: UsageResult["points"] = [];
  REQUESTS.forEach(([serverId, perBucket]) =>
    perBucket.forEach((requests, i) => {
      if (!requests) return;
      const bytes = requests * BYTES_PER_REQUEST + (serverId === "outlook-desktop" && i === 2 ? EXTRA_BYTES : 0);
      points.push({ t: BUCKETS[i]!, serverId, bytesIn: Math.round(bytes * 0.2), bytesOut: bytes - Math.round(bytes * 0.2), requests, errors: 0 });
    }),
  );
  const totals: UsageResult["totals"] = REQUESTS.map(([serverId]) => {
    const mine = points.filter((p) => p.serverId === serverId);
    const sum = (k: "bytesIn" | "bytesOut" | "requests") => mine.reduce((a, p) => a + p[k], 0);
    return { serverId, bytesIn: sum("bytesIn"), bytesOut: sum("bytesOut"), requests: sum("requests"), errors: 0, avgLatencyMs: LATENCY_AVG_MS, p95LatencyMs: LATENCY_P95_MS[serverId] ?? 3000 };
  });
  const all = (k: "bytesIn" | "bytesOut" | "requests") => totals.reduce((a, t) => a + t[k], 0);
  return {
    range: "24h",
    bucketMs: 15 * MINUTE,
    since: Math.floor((NOW - 24 * 60 * MINUTE) / (15 * MINUTE)) * 15 * MINUTE,
    points,
    totals,
    tools: [
      { serverId: "github-3", tool: "search_code", calls: 3, errors: 0 },
      { serverId: "github-3", tool: "get_file_contents", calls: 1, errors: 0 },
      { serverId: "outlook-desktop", tool: "search_emails", calls: 4, errors: 0 },
      { serverId: "outlook-desktop", tool: "get_calendar", calls: 2, errors: 0 },
      { serverId: "playwright", tool: "browser_navigate", calls: 3, errors: 0 },
      { serverId: "playwright", tool: "browser_snapshot", calls: 2, errors: 0 },
    ],
    clients: [{ client: CLIENT.name, bytesIn: all("bytesIn"), bytesOut: all("bytesOut"), requests: all("requests"), errors: 0 }],
  };
}
