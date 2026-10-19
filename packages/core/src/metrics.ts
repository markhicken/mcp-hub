import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClientUsage, ToolUsage, UsagePoint, UsageTotals } from "./types.js";

export const LATENCY_BOUNDS = [50, 100, 250, 500, 1000, 2500] as const;
const NB = LATENCY_BOUNDS.length + 1;

export interface UsageSample {
  serverId: string;
  /** Name of the app that made the request ("" when it is not known). */
  client?: string;
  bytesIn?: number;
  bytesOut?: number;
  requests?: number;
  errors?: number;
  latencyMs?: number;
  tool?: string;
  toolError?: boolean;
}

interface Agg {
  minute: number;
  serverId: string;
  client: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  errors: number;
  latSum: number;
  latCount: number;
  buckets: number[];
}

export type UsageRange = "1h" | "24h" | "7d" | "30d";
const RANGE_MS: Record<UsageRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const BUCKET_MS: Record<UsageRange, number> = { "1h": 60_000, "24h": 15 * 60_000, "7d": 2 * 3_600_000, "30d": 86_400_000 };

export interface UsageResult {
  range: UsageRange;
  bucketMs: number;
  since: number;
  points: UsagePoint[];
  totals: UsageTotals[];
  tools: ToolUsage[];
  /** Per-app totals for the period (not narrowed by the client filter, so the picker stays complete). */
  clients: ClientUsage[];
}

/** Minute-resolution usage history in SQLite. Payloads are never stored, only sizes and timings. */
export class Metrics {
  private readonly db: DatabaseSync;
  private pending = new Map<string, Agg>();
  private pendingTools = new Map<string, { hour: number; serverId: string; client: string; tool: string; calls: number; errors: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_minute (
        minute INTEGER NOT NULL, server_id TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
        bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        lat_sum REAL NOT NULL DEFAULT 0, lat_count INTEGER NOT NULL DEFAULT 0,
        ${Array.from({ length: NB }, (_, i) => `b${i} INTEGER NOT NULL DEFAULT 0`).join(", ")},
        PRIMARY KEY (minute, server_id, client)
      );
      CREATE TABLE IF NOT EXISTS tool_hour (
        hour INTEGER NOT NULL, server_id TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, server_id, client, tool)
      );
    `);
  }

  /** Databases from before per-app tracking have no client column; their rows keep client = "". */
  private migrate(): void {
    const hasClient = (table: string): boolean | null => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.length ? cols.some((c) => c.name === "client") : null;
    };
    if (hasClient("usage_minute") === false) {
      const cols = ["minute", "server_id", "bytes_in", "bytes_out", "requests", "errors", "lat_sum", "lat_count", ...Array.from({ length: NB }, (_, i) => `b${i}`)];
      this.db.exec("ALTER TABLE usage_minute RENAME TO usage_minute_old");
      this.db.exec(`
        CREATE TABLE usage_minute (
          minute INTEGER NOT NULL, server_id TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
          bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
          lat_sum REAL NOT NULL DEFAULT 0, lat_count INTEGER NOT NULL DEFAULT 0,
          ${Array.from({ length: NB }, (_, i) => `b${i} INTEGER NOT NULL DEFAULT 0`).join(", ")},
          PRIMARY KEY (minute, server_id, client)
        );
        INSERT INTO usage_minute (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM usage_minute_old;
        DROP TABLE usage_minute_old;
      `);
    }
    if (hasClient("tool_hour") === false) {
      this.db.exec(`
        ALTER TABLE tool_hour RENAME TO tool_hour_old;
        CREATE TABLE tool_hour (
          hour INTEGER NOT NULL, server_id TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour, server_id, client, tool)
        );
        INSERT INTO tool_hour (hour, server_id, tool, calls, errors) SELECT hour, server_id, tool, calls, errors FROM tool_hour_old;
        DROP TABLE tool_hour_old;
      `);
    }
  }

  start(flushMs = 5000): void {
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref();
  }

  record(s: UsageSample): void {
    const minute = Math.floor(this.now() / 60_000) * 60_000;
    const client = s.client ?? "";
    const key = `${minute}|${s.serverId}|${client}`;
    let a = this.pending.get(key);
    if (!a) {
      a = { minute, serverId: s.serverId, client, bytesIn: 0, bytesOut: 0, requests: 0, errors: 0, latSum: 0, latCount: 0, buckets: new Array(NB).fill(0) };
      this.pending.set(key, a);
    }
    a.bytesIn += s.bytesIn ?? 0;
    a.bytesOut += s.bytesOut ?? 0;
    a.requests += s.requests ?? 0;
    a.errors += s.errors ?? 0;
    if (s.latencyMs !== undefined) {
      a.latSum += s.latencyMs;
      a.latCount += 1;
      let i = LATENCY_BOUNDS.findIndex((b) => s.latencyMs! <= b);
      if (i < 0) i = NB - 1;
      a.buckets[i]! += 1;
    }
    if (s.tool) {
      const hour = Math.floor(this.now() / 3_600_000) * 3_600_000;
      const tk = `${hour}|${s.serverId}|${client}|${s.tool}`;
      const t = this.pendingTools.get(tk) ?? { hour, serverId: s.serverId, client, tool: s.tool, calls: 0, errors: 0 };
      t.calls += 1;
      if (s.toolError) t.errors += 1;
      this.pendingTools.set(tk, t);
    }
  }

  flush(): void {
    if (!this.pending.size && !this.pendingTools.size) return;
    const bcols = Array.from({ length: NB }, (_, i) => `b${i}`);
    const upsert = this.db.prepare(`
      INSERT INTO usage_minute (minute, server_id, client, bytes_in, bytes_out, requests, errors, lat_sum, lat_count, ${bcols.join(", ")})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${bcols.map(() => "?").join(", ")})
      ON CONFLICT(minute, server_id, client) DO UPDATE SET
        bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out,
        requests = requests + excluded.requests, errors = errors + excluded.errors,
        lat_sum = lat_sum + excluded.lat_sum, lat_count = lat_count + excluded.lat_count,
        ${bcols.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}
    `);
    const upsertTool = this.db.prepare(`
      INSERT INTO tool_hour (hour, server_id, client, tool, calls, errors) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, server_id, client, tool) DO UPDATE SET calls = calls + excluded.calls, errors = errors + excluded.errors
    `);
    const pending = this.pending;
    const pendingTools = this.pendingTools;
    this.pending = new Map();
    this.pendingTools = new Map();
    this.db.exec("BEGIN");
    try {
      for (const a of pending.values()) {
        upsert.run(a.minute, a.serverId, a.client, a.bytesIn, a.bytesOut, a.requests, a.errors, a.latSum, a.latCount, ...a.buckets);
      }
      for (const t of pendingTools.values()) upsertTool.run(t.hour, t.serverId, t.client, t.tool, t.calls, t.errors);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `client` narrows to one app; use "" for traffic that was recorded before apps were tracked. */
  query(range: UsageRange, serverId?: string, client?: string): UsageResult {
    this.flush();
    const bucketMs = BUCKET_MS[range];
    const since = Math.floor((this.now() - RANGE_MS[range]) / bucketMs) * bucketMs;
    const cond = (time: string, withClient: boolean) => {
      const where = [`${time} >= ?`];
      const params: Array<string | number> = [time === "minute" ? since : Math.floor(since / 3_600_000) * 3_600_000];
      if (serverId) {
        where.push("server_id = ?");
        params.push(serverId);
      }
      if (withClient && client !== undefined) {
        where.push("client = ?");
        params.push(client);
      }
      return { where: where.join(" AND "), params };
    };
    const { where, params } = cond("minute", true);

    const pointRows = this.db
      .prepare(
        `SELECT (minute / ${bucketMs}) * ${bucketMs} AS t, server_id AS serverId,
                SUM(bytes_in) AS bytesIn, SUM(bytes_out) AS bytesOut, SUM(requests) AS requests, SUM(errors) AS errors
         FROM usage_minute WHERE ${where} GROUP BY t, server_id ORDER BY t`,
      )
      .all(...params) as unknown as UsagePoint[];

    const totalRows = this.db
      .prepare(
        `SELECT server_id AS serverId, SUM(bytes_in) AS bytesIn, SUM(bytes_out) AS bytesOut, SUM(requests) AS requests,
                SUM(errors) AS errors, SUM(lat_sum) AS latSum, SUM(lat_count) AS latCount,
                ${Array.from({ length: NB }, (_, i) => `SUM(b${i}) AS b${i}`).join(", ")}
         FROM usage_minute WHERE ${where} GROUP BY server_id`,
      )
      .all(...params) as unknown as Array<Record<string, number | string>>;

    const totals: UsageTotals[] = totalRows.map((r) => {
      const buckets = Array.from({ length: NB }, (_, i) => Number(r[`b${i}`] ?? 0));
      const count = Number(r.latCount ?? 0);
      return {
        serverId: String(r.serverId),
        bytesIn: Number(r.bytesIn),
        bytesOut: Number(r.bytesOut),
        requests: Number(r.requests),
        errors: Number(r.errors),
        avgLatencyMs: count ? Number(r.latSum) / count : 0,
        p95LatencyMs: percentileFromBuckets(buckets, 0.95),
      };
    });

    const t = cond("hour", true);
    const tools = this.db
      .prepare(
        `SELECT server_id AS serverId, tool, SUM(calls) AS calls, SUM(errors) AS errors
         FROM tool_hour WHERE ${t.where} GROUP BY server_id, tool ORDER BY calls DESC LIMIT 50`,
      )
      .all(...t.params) as unknown as ToolUsage[];

    const all = cond("minute", false);
    const clients = (
      this.db
        .prepare(
          `SELECT client, SUM(bytes_in) AS bytesIn, SUM(bytes_out) AS bytesOut, SUM(requests) AS requests, SUM(errors) AS errors
           FROM usage_minute WHERE ${all.where} GROUP BY client ORDER BY requests DESC, client`,
        )
        .all(...all.params) as unknown as ClientUsage[]
    ).map((c) => ({ client: String(c.client), bytesIn: Number(c.bytesIn), bytesOut: Number(c.bytesOut), requests: Number(c.requests), errors: Number(c.errors) }));

    return {
      range,
      bucketMs,
      since,
      points: pointRows.map((p) => ({ ...p, t: Number(p.t) })),
      totals,
      tools,
      clients,
    };
  }

  toCsv(range: UsageRange, serverId?: string, client?: string): string {
    this.flush();
    const bucketMs = BUCKET_MS[range];
    const since = Math.floor((this.now() - RANGE_MS[range]) / bucketMs) * bucketMs;
    const where = ["minute >= ?"];
    const params: Array<string | number> = [since];
    if (serverId) {
      where.push("server_id = ?");
      params.push(serverId);
    }
    if (client !== undefined) {
      where.push("client = ?");
      params.push(client);
    }
    const rows = this.db
      .prepare(
        `SELECT (minute / ${bucketMs}) * ${bucketMs} AS t, server_id AS serverId, client, SUM(bytes_in) AS bytesIn, SUM(bytes_out) AS bytesOut,
                SUM(requests) AS requests, SUM(errors) AS errors
         FROM usage_minute WHERE ${where.join(" AND ")} GROUP BY t, server_id, client ORDER BY t`,
      )
      .all(...params) as unknown as Array<UsagePoint & { client: string }>;
    const lines = ["time,server,client,bytes_in,bytes_out,requests,errors"];
    for (const p of rows) lines.push(`${new Date(Number(p.t)).toISOString()},${csv(p.serverId)},${csv(p.client)},${p.bytesIn},${p.bytesOut},${p.requests},${p.errors}`);
    return lines.join("\n") + "\n";
  }

  prune(retentionDays: number): void {
    const cutoff = this.now() - retentionDays * 86_400_000;
    this.db.prepare("DELETE FROM usage_minute WHERE minute < ?").run(cutoff);
    this.db.prepare("DELETE FROM tool_hour WHERE hour < ?").run(cutoff);
  }

  /** Remove history for a deleted server. */
  forget(serverId: string): void {
    this.clear(serverId);
  }

  /** Forget usage history: everything, or one server. */
  clear(serverId?: string): void {
    if (serverId) {
      for (const [k, a] of this.pending) if (a.serverId === serverId) this.pending.delete(k);
      for (const [k, t] of this.pendingTools) if (t.serverId === serverId) this.pendingTools.delete(k);
      this.db.prepare("DELETE FROM usage_minute WHERE server_id = ?").run(serverId);
      this.db.prepare("DELETE FROM tool_hour WHERE server_id = ?").run(serverId);
    } else {
      this.pending.clear();
      this.pendingTools.clear();
      this.db.exec("DELETE FROM usage_minute; DELETE FROM tool_hour;");
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    try {
      this.flush();
    } finally {
      this.db.close();
    }
  }
}

function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function percentileFromBuckets(buckets: number[], p: number): number {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i]!;
    if (acc / total >= p) return i < LATENCY_BOUNDS.length ? LATENCY_BOUNDS[i]! : LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1]! * 2;
  }
  return 0;
}
