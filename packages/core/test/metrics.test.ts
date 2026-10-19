import { describe, expect, it } from "vitest";
import { Metrics, percentileFromBuckets } from "../src/metrics.js";

describe("metrics", () => {
  it("aggregates samples into minute buckets and totals", () => {
    let now = Date.UTC(2026, 0, 1, 12, 0, 30);
    const m = new Metrics(":memory:", () => now);
    m.record({ serverId: "a", bytesIn: 100, bytesOut: 400, requests: 1, latencyMs: 40, tool: "echo" });
    m.record({ serverId: "a", bytesIn: 50, bytesOut: 50, requests: 1, errors: 1, latencyMs: 900, tool: "echo", toolError: true });
    now += 5 * 60_000;
    m.record({ serverId: "b", bytesIn: 10, bytesOut: 10, requests: 1, latencyMs: 5 });

    const r = m.query("1h");
    const a = r.totals.find((t) => t.serverId === "a")!;
    expect(a).toMatchObject({ bytesIn: 150, bytesOut: 450, requests: 2, errors: 1 });
    expect(a.avgLatencyMs).toBe(470);
    expect(a.p95LatencyMs).toBe(1000);
    expect(r.tools).toEqual([{ serverId: "a", tool: "echo", calls: 2, errors: 1 }]);
    expect(r.points.filter((p) => p.serverId === "a")).toHaveLength(1);
    expect(r.points.some((p) => p.serverId === "b")).toBe(true);

    expect(m.query("1h", "b").totals.map((t) => t.serverId)).toEqual(["b"]);
    m.close();
  });

  it("only returns data inside the requested range and prunes old history", () => {
    let now = Date.UTC(2026, 0, 10, 0, 0, 0);
    const m = new Metrics(":memory:", () => now);
    m.record({ serverId: "a", bytesIn: 1, requests: 1 });
    now += 2 * 86_400_000;
    m.record({ serverId: "a", bytesIn: 2, requests: 1 });
    expect(m.query("24h").totals[0]!.bytesIn).toBe(2);
    expect(m.query("7d").totals[0]!.bytesIn).toBe(3);
    m.prune(1);
    expect(m.query("7d").totals[0]!.bytesIn).toBe(2);
    m.forget("a");
    expect(m.query("7d").totals).toEqual([]);
    m.close();
  });

  it("exports CSV with a header row", () => {
    const m = new Metrics(":memory:");
    m.record({ serverId: "weird,name", bytesIn: 1, bytesOut: 2, requests: 1 });
    const csv = m.toCsv("1h").trim().split("\n");
    expect(csv[0]).toBe("time,server,client,bytes_in,bytes_out,requests,errors");
    expect(csv[1]).toContain('"weird,name",,1,2,1,0');
    m.close();
  });

  it("tracks usage per app and filters by it", () => {
    const m = new Metrics(":memory:");
    m.record({ serverId: "a", client: "Claude Desktop", bytesIn: 10, bytesOut: 20, requests: 1, latencyMs: 10, tool: "echo" });
    m.record({ serverId: "a", client: "Claude Desktop", bytesIn: 10, bytesOut: 20, requests: 1, latencyMs: 10, tool: "echo" });
    m.record({ serverId: "a", client: "copilot", bytesIn: 1, bytesOut: 2, requests: 1, errors: 1, latencyMs: 10, tool: "grep", toolError: true });
    m.record({ serverId: "b", client: "copilot", bytesIn: 5, bytesOut: 5, requests: 1 });

    const all = m.query("1h");
    expect(all.clients.map((c) => [c.client, c.requests])).toEqual([["Claude Desktop", 2], ["copilot", 2]]);

    const only = m.query("1h", undefined, "copilot");
    expect(only.totals.map((t) => [t.serverId, t.requests]).sort()).toEqual([["a", 1], ["b", 1]]);
    expect(only.tools).toEqual([{ serverId: "a", tool: "grep", calls: 1, errors: 1 }]);
    // The app list is not narrowed by the filter, so the picker keeps every app.
    expect(only.clients).toHaveLength(2);

    expect(m.query("1h", "a", "Claude Desktop").totals[0]).toMatchObject({ requests: 2, bytesIn: 20 });
    expect(m.toCsv("1h", undefined, "copilot").trim().split("\n")).toHaveLength(3);
    m.close();
  });

  it("keeps history recorded before apps were tracked", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(mkdtempSync(join(tmpdir(), "mcp-hub-metrics-")), "usage.sqlite");
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE usage_minute (minute INTEGER NOT NULL, server_id TEXT NOT NULL, bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, lat_sum REAL NOT NULL DEFAULT 0, lat_count INTEGER NOT NULL DEFAULT 0,
      b0 INTEGER NOT NULL DEFAULT 0, b1 INTEGER NOT NULL DEFAULT 0, b2 INTEGER NOT NULL DEFAULT 0, b3 INTEGER NOT NULL DEFAULT 0, b4 INTEGER NOT NULL DEFAULT 0, b5 INTEGER NOT NULL DEFAULT 0, b6 INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (minute, server_id));
      CREATE TABLE tool_hour (hour INTEGER NOT NULL, server_id TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour, server_id, tool));
      INSERT INTO usage_minute (minute, server_id, bytes_in, requests) VALUES (${minute}, 'a', 7, 3);
      INSERT INTO tool_hour (hour, server_id, tool, calls) VALUES (${Math.floor(minute / 3_600_000) * 3_600_000}, 'a', 'echo', 3);`);
    old.close();

    const m = new Metrics(file);
    m.record({ serverId: "a", client: "Cursor", bytesIn: 1, requests: 1 });
    const r = m.query("1h");
    expect(r.totals[0]).toMatchObject({ bytesIn: 8, requests: 4 });
    expect(r.clients.map((c) => [c.client, c.requests]).sort()).toEqual([["", 3], ["Cursor", 1]]);
    expect(m.query("1h", undefined, "").totals[0]).toMatchObject({ requests: 3 });
    expect(r.tools[0]).toMatchObject({ tool: "echo", calls: 3 });
    m.close();
  });

  it("computes percentiles from latency buckets", () => {
    expect(percentileFromBuckets([0, 0, 0, 0, 0, 0, 0], 0.95)).toBe(0);
    expect(percentileFromBuckets([95, 5, 0, 0, 0, 0, 0], 0.95)).toBe(50);
    expect(percentileFromBuckets([90, 0, 0, 0, 0, 0, 10], 0.95)).toBe(5000);
  });
});
