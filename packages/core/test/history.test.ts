import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { History } from "../src/history.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/types.js";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

describe("History store", () => {
  it("merges a burst of identical secret reads into one counted entry", () => {
    const h = new History(":memory:");
    for (let i = 0; i < 3; i++) h.record({ kind: "secret", action: "read", outcome: "read", serverId: "a", serverName: "Alpha", source: "1Password", trigger: "Claude connected" });
    h.record({ kind: "secret", action: "memory", outcome: "memory", serverId: "a", serverName: "Alpha", source: "1Password", trigger: "Claude connected" });
    const { events } = h.query();
    expect(events.map((e) => [e.title, e.count])).toEqual([
      ["Used 1 saved secret for Alpha", 1],
      ["Read 3 secrets from 1Password for Alpha", 3],
    ]);
    h.close();
  });

  it("does not merge events from different triggers or servers", () => {
    const h = new History(":memory:");
    h.record({ kind: "secret", action: "read", outcome: "read", serverId: "a", serverName: "Alpha", source: "1Password", trigger: "Claude connected" });
    h.record({ kind: "secret", action: "read", outcome: "read", serverId: "a", serverName: "Alpha", source: "1Password", trigger: "MCP Hub started" });
    h.record({ kind: "secret", action: "read", outcome: "read", serverId: "b", serverName: "Beta", source: "1Password", trigger: "MCP Hub started" });
    expect(h.query().events).toHaveLength(3);
    h.close();
  });

  it("searches every word across the visible text, and filters by kind", () => {
    const h = new History(":memory:");
    h.record({ kind: "secret", action: "read", outcome: "read", serverId: "gh", serverName: "GitHub", source: "1Password", trigger: "Claude connected" });
    h.record({ kind: "app", action: "allowed", app: "Cursor", detail: "every server" });
    h.record({ kind: "server", action: "started", serverId: "gh", serverName: "GitHub", trigger: "Cursor connected" });
    expect(h.query({ q: "github claude" }).events).toHaveLength(1);
    expect(h.query({ q: "CURSOR" }).events).toHaveLength(2);
    expect(h.query({ q: "100%" }).events).toHaveLength(0);
    expect(h.query({ kinds: ["app"] }).events.map((e) => e.title)).toEqual(["You allowed Cursor to use every server"]);
    expect(h.query({ kinds: ["app", "server"] }).events).toHaveLength(2);
    h.close();
  });

  it("pages with `before` and reports whether more remain", () => {
    const h = new History(":memory:");
    for (let i = 0; i < 5; i++) h.record({ kind: "config", action: "added", serverId: `s${i}`, serverName: `S${i}` });
    const first = h.query({ limit: 2 });
    expect(first.events.map((e) => e.serverName)).toEqual(["S4", "S3"]);
    expect(first.more).toBe(true);
    const last = h.query({ limit: 10, before: first.events.at(-1)!.id });
    expect(last.events.map((e) => e.serverName)).toEqual(["S2", "S1", "S0"]);
    expect(last.more).toBe(false);
    h.close();
  });

  it("prunes to the retention period", () => {
    let now = Date.UTC(2026, 0, 1);
    const h = new History(":memory:", () => now);
    h.record({ kind: "config", action: "added", serverName: "Old" });
    now += 10 * 86_400_000;
    h.record({ kind: "config", action: "added", serverName: "New" });
    expect(h.prune(7)).toBe(1);
    expect(h.query().events.map((e) => e.serverName)).toEqual(["New"]);
    h.close();
  });

  it("ignores writes after it is closed", () => {
    const h = new History(":memory:");
    h.close();
    expect(() => h.record({ kind: "config", action: "added" })).not.toThrow();
  });
});

describe("settings always have sane values", () => {
  it("falls back to the default for anything missing, mistyped or out of range", () => {
    const s = normalizeSettings({ port: 80, retentionDays: -3, cacheTtlSeconds: "soon", denialCooldownSeconds: Number.NaN, preloadSecrets: "yes", notifyOnCredentialPrompt: null } as never);
    expect(s).toMatchObject({
      port: DEFAULT_SETTINGS.port,
      retentionDays: DEFAULT_SETTINGS.retentionDays,
      cacheTtlSeconds: DEFAULT_SETTINGS.cacheTtlSeconds,
      denialCooldownSeconds: DEFAULT_SETTINGS.denialCooldownSeconds,
      preloadSecrets: false,
      notifyOnCredentialPrompt: true,
    });
  });

  it("keeps valid values and a fresh install has everything defined", () => {
    expect(normalizeSettings({ retentionDays: 90, preloadSecrets: true })).toMatchObject({ retentionDays: 90, preloadSecrets: true });
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("the hub records what it does", () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startHub({ HIST_SECRET: "hist-value" });
  });
  afterAll(async () => {
    await t.stop();
  });

  it("attributes a secret read to the app that caused the connection, and a later use to memory", async () => {
    await t.api("POST", "/api/servers", {
      name: "Hist Mock",
      transport: "stdio",
      command: process.execPath,
      args: [MOCK],
      env: { A: "{{env://HIST_SECRET}}" },
      lifecycle: "on-demand",
      idleTimeoutMinutes: 15,
    });
    const client = new Client({ name: "Test App", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/hist-mock`)));
    await client.close();

    const { body } = await t.api("GET", "/api/history");
    const titles = body.events.map((e: { title: string }) => e.title);
    expect(titles).toContain("Read 1 secret from Environment variables for Hist Mock");
    expect(titles).toContain("Hist Mock started");
    const read = body.events.find((e: { outcome: string }) => e.outcome === "read");
    expect(read.trigger).toMatch(/connected$/);
    // The value itself must never be stored.
    expect(JSON.stringify(body)).not.toContain("hist-value");

    // Stop and start it again: the secret now comes from memory, not the source.
    await t.api("POST", "/api/servers/hist-mock/restart");
    await waitFor(async () => (await t.api("GET", "/api/history?q=saved")).body.events.length > 0, 10000, "memory use recorded");
  });

  it("searches, filters and validates", async () => {
    expect((await t.api("GET", "/api/history?q=hist%20mock&kind=server,config")).body.events.length).toBeGreaterThan(0);
    expect((await t.api("GET", "/api/history?kind=nonsense")).status).toBe(400);
    expect((await t.api("GET", "/api/history?q=zzz-no-such")).body.events).toEqual([]);
  });

  it("clears on request", async () => {
    expect((await t.api("DELETE", "/api/history")).status).toBe(200);
    expect((await t.api("GET", "/api/history")).body.events).toEqual([]);
  });

  it("shortening 'keep history for' applies straight away and rejects nonsense", async () => {
    expect((await t.api("PUT", "/api/settings", { retentionDays: 0 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { preloadSecrets: "yes" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { retentionDays: 7, preloadSecrets: true })).status).toBe(200);
  });
});

describe("preloading secrets", () => {
  it("announces first, reads for start-when-needed servers only, and records every read", async () => {
    const t = await startHub({ PRE_SECRET: "pre-value", PRE_OTHER: "other-value" });
    try {
      await t.api("POST", "/api/servers", { name: "Lazy", transport: "stdio", command: process.execPath, args: [MOCK], env: { A: "{{env://PRE_SECRET}}" }, lifecycle: "on-demand" });
      await t.api("POST", "/api/servers", { name: "Eager", transport: "stdio", command: process.execPath, args: [MOCK], env: { A: "{{env://PRE_OTHER}}" }, lifecycle: "keep-alive" });
      await waitFor(async () => (await t.api("GET", "/api/servers/eager")).body.state === "connected", 15000, "eager connected");
      t.hub.history.clear();

      const announced: string[][] = [];
      const n = await t.hub.manager.preloadSecrets("MCP Hub started (loading secrets ahead of time)", (names) => announced.push(names));
      expect(n).toBe(1);
      expect(announced).toEqual([["Lazy"]]);
      const titles = t.hub.history.query().events.map((e) => e.title);
      expect(titles).toEqual(["Read 1 secret from Environment variables for Lazy"]);
      expect(t.hub.history.query().events[0]!.trigger).toBe("MCP Hub started (loading secrets ahead of time)");
      // Nothing was started by the preload.
      expect(t.hub.manager.get("lazy")!.state).toBe("disconnected");
    } finally {
      await t.stop();
    }
  });
});
