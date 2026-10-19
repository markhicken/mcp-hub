import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/store.js";

function storeWith(settings: Record<string, unknown>) {
  const path = join(mkdtempSync(join(tmpdir(), "mcp-hub-store-")), "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers: [], sources: [], settings }));
  return new ConfigStore(path);
}

describe("config store sources", () => {
  it("starts with the environment source off and typed-in secrets on", () => {
    const s = storeWith({});
    expect(s.sources.find((x) => x.type === "env")?.enabled).toBe(false);
    expect(s.sources.find((x) => x.type === "manual")?.enabled).toBe(true);
  });

  it("keeps an environment source the user already enabled", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mcp-hub-store-")), "config.json");
    writeFileSync(path, JSON.stringify({ version: 1, servers: [], sources: [{ id: "env", type: "env", name: "Environment variables", enabled: true, options: {} }], settings: {} }));
    expect(new ConfigStore(path).sources.find((x) => x.type === "env")?.enabled).toBe(true);
  });
});

describe("config store settings", () => {
  it("defaults to keeping secrets until locked", () => {
    expect(storeWith({}).settings.cacheTtlSeconds).toBe(0);
  });

  it("migrates the old 1-hour default once", () => {
    const s = storeWith({ cacheTtlSeconds: 3600 });
    expect(s.settings.cacheTtlSeconds).toBe(0);
    s.updateSettings({ cacheTtlSeconds: 3600 });
    expect(s.settings.cacheTtlSeconds).toBe(3600);
  });

  it("keeps a deliberate choice after migration", () => {
    expect(storeWith({ cacheTtlSeconds: 3600, cacheTtlMigrated: true }).settings.cacheTtlSeconds).toBe(3600);
    expect(storeWith({ cacheTtlSeconds: 300 }).settings.cacheTtlSeconds).toBe(300);
  });
});
