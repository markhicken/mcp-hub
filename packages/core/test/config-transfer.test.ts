import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEAL_PREFIX } from "../src/credentials/box.js";
import { EXPORT_FORMAT, buildExport, parseImport, planImport } from "../src/config-transfer.js";
import type { ServerConfig, SourceConfig } from "../src/types.js";
import { startHub } from "./helpers.js";

const server = (over: Partial<ServerConfig> = {}): ServerConfig => ({ id: "wiki", name: "Wiki", transport: "stdio", command: "npx", args: ["-y", "wiki-mcp"], env: { TOKEN: "{{op://V/Wiki/token}}" }, enabled: true, lifecycle: "keep-alive", ...over });
const vault: SourceConfig = { id: "vault-1", type: "vault", name: "Team Vault", enabled: true, options: { address: "https://vault.example.com", vaultPath: "/Users/me/bin/vault", tokenSource: "file" } };

describe("exporting", () => {
  it("keeps credential references as references, drops machine-specific paths, and lists what to re-enter", () => {
    const doc = buildExport([server({ env: { TOKEN: "{{secret://wiki-token}}" }, notes: "from the vault" })], [vault], "1.2.3", new Date("2026-01-02T03:04:05Z"));
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, version: 1, exportedAt: "2026-01-02T03:04:05.000Z", app: "MCP Hub 1.2.3", localSecrets: ["wiki-token"] });
    expect(doc.servers[0]).toMatchObject({ id: "wiki", notes: "from the vault", env: { TOKEN: "{{secret://wiki-token}}" } });
    expect(doc.sources[0]!.options).toEqual({ address: "https://vault.example.com", tokenSource: "file" });
    expect(doc.warnings.join(" ")).toContain("Local secrets are never exported");
    expect(doc.warnings.join(" ")).toContain("wiki-token");
  });

  it("warns about secrets typed straight into a server instead of a reference", () => {
    const doc = buildExport([server({ env: { API_TOKEN: "sk-live-123", REGION: "eu", REF: "{{env://X}}" }, headers: { Authorization: "Bearer abc" } })], [], "1");
    const text = doc.warnings.join("\n");
    expect(text).toContain("env API_TOKEN is a typed-in value");
    expect(text).toContain("header Authorization is a typed-in value");
    expect(text).not.toContain("REGION");
    expect(text).not.toContain("REF");
  });
});

describe("reading an import file", () => {
  it("accepts its own format and a plain mcpServers file, and skips what already goes through MCP Hub", () => {
    const own = parseImport(JSON.parse(JSON.stringify(buildExport([server()], [vault], "1"))));
    expect(own.servers.map((s) => s.id)).toEqual(["wiki"]);
    expect(own.sources.map((s) => s.id)).toEqual(["vault-1"]);

    const plain = parseImport({ mcpServers: { "My Server": { command: "npx", args: ["x"] }, Done: { command: "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-stdio", args: ["done"] }, Broken: { foo: 1 } } });
    expect(plain.servers.map((s) => [s.id, s.name])).toEqual([["my-server", "My Server"]]);
    expect(plain.problems.map((p) => p.name).sort()).toEqual(["Broken", "Done"]);
  });

  it("refuses files it shouldn't guess at", () => {
    expect(parseImport("nope").problems[0]!.reason).toMatch(/isn't an MCP Hub export/);
    expect(parseImport({ format: EXPORT_FORMAT, version: 99, servers: [] }).problems[0]!.reason).toMatch(/newer MCP Hub/);
    const sealed = parseImport({ format: EXPORT_FORMAT, version: 1, servers: [server({ env: { TOKEN: `${SEAL_PREFIX}abcd` } })] });
    expect(sealed.servers).toEqual([]);
    expect(sealed.problems[0]!.reason).toMatch(/another computer/);
    const bad = parseImport({ format: EXPORT_FORMAT, version: 1, servers: [{ name: "No command", transport: "stdio" }, server(), server({ name: "Wiki again", id: "wiki" })] });
    expect(bad.servers.map((s) => s.id)).toEqual(["wiki"]);
    expect(bad.problems.map((p) => p.name)).toEqual(["No command", "Wiki again"]);
  });
});

describe("planning an import", () => {
  const parsed = () => parseImport(JSON.parse(JSON.stringify(buildExport([server(), server({ id: "mail", name: "Mail", env: { K: "{{secret://mail-key}}" } })], [vault, { id: "env", type: "env", name: "Environment", enabled: true, options: {} }], "1"))));
  const existing = { servers: [{ id: "wiki", name: "Old wiki" }], sources: [{ id: "env", type: "env" as const, name: "Environment", enabled: false, options: {} }], localSecrets: [] as string[] };

  it("skips, replaces or keeps both for a server that is already there", () => {
    expect(planImport(parsed(), existing, { onClash: "skip", includeSources: true }).servers.map((s) => [s.id, s.action])).toEqual([["wiki", "skip"], ["mail", "add"]]);
    const replace = planImport(parsed(), existing, { onClash: "replace", includeSources: true }).servers;
    expect(replace.map((s) => [s.id, s.action])).toEqual([["wiki", "replace"], ["mail", "add"]]);
    const copy = planImport(parsed(), existing, { onClash: "copy", includeSources: true }).servers;
    expect(copy.map((s) => [s.id, s.name, s.action])).toEqual([["wiki-2", "Wiki (2)", "copy"], ["mail", "Mail", "add"]]);
  });

  it("matches an existing server by name too", () => {
    const plan = planImport(parsed(), { ...existing, servers: [{ id: "something", name: "wiki" }] }, { onClash: "replace", includeSources: true });
    expect(plan.servers[0]).toMatchObject({ id: "something", action: "replace" });
  });

  it("adds only sources it doesn't have, never touches existing ones, and can leave them out", () => {
    const plan = planImport(parsed(), existing, { onClash: "skip", includeSources: true });
    expect(plan.sources.add.map((s) => s.id)).toEqual(["vault-1"]);
    expect(plan.sources.skip).toEqual([{ name: "Environment", reason: "Already in MCP Hub." }]);
    expect(planImport(parsed(), existing, { onClash: "skip", includeSources: false }).sources).toEqual({ add: [], skip: [] });
  });

  it("lists local secrets that are used but missing here, ignoring skipped servers", () => {
    expect(planImport(parsed(), existing, { onClash: "skip", includeSources: true }).missingLocalSecrets).toEqual(["mail-key"]);
    expect(planImport(parsed(), { ...existing, localSecrets: ["mail-key"] }, { onClash: "skip", includeSources: true }).missingLocalSecrets).toEqual([]);
  });
});

describe("export and import between hubs", () => {
  it("moves servers, sources and notes from one hub to another, reporting what to re-enter", async () => {
    const a = await startHub();
    const b = await startHub();
    try {
      await a.api("PUT", "/api/secrets/wiki-token", { value: "super-secret-value" });
      await a.api("POST", "/api/servers", { name: "Wiki", transport: "stdio", command: "npx", enabled: false, notes: "Ask Sam", env: { TOKEN: "{{secret://wiki-token}}", OPT: "plain" } });
      await a.api("POST", "/api/sources", { type: "vault", name: "Team Vault", options: { address: "https://vault.example.com" } });

      const exported = await a.api("GET", "/api/config/export");
      expect(exported.status).toBe(200);
      const text = JSON.stringify(exported.body);
      expect(text).toContain("{{secret://wiki-token}}"); // references travel readable
      expect(text).not.toContain("super-secret-value"); // values never do
      expect(text).not.toContain(SEAL_PREFIX);
      expect(exported.body.localSecrets).toEqual(["wiki-token"]);
      expect(exported.body.sources.some((s: SourceConfig) => s.name === "Team Vault")).toBe(true);

      const preview = await b.api("POST", "/api/config/import", { data: exported.body, dryRun: true });
      expect(preview.body).toMatchObject({ dryRun: true, servers: [{ name: "Wiki", action: "add" }], missingLocalSecrets: ["wiki-token"] });
      expect((await b.api("GET", "/api/state")).body.servers).toHaveLength(0); // a preview changes nothing

      const done = await b.api("POST", "/api/config/import", { data: exported.body });
      expect(done.body).toMatchObject({ dryRun: false, added: ["Wiki"], failed: [], sourcesAdded: ["Team Vault"] });
      const cfg = (await b.api("GET", "/api/servers/wiki")).body.config;
      expect(cfg).toMatchObject({ name: "Wiki", notes: "Ask Sam", enabled: false, env: { TOKEN: "{{secret://wiki-token}}", OPT: "plain" } });

      // Importing the same file again skips, and "replace" overwrites in place.
      expect((await b.api("POST", "/api/config/import", { data: exported.body })).body).toMatchObject({ added: [], skipped: ["Wiki"] });
      exported.body.servers[0].env = { TOKEN: "{{secret://other}}" };
      delete exported.body.servers[0].notes;
      const replaced = await b.api("POST", "/api/config/import", { data: exported.body, onClash: "replace" });
      expect(replaced.body.replaced).toEqual(["Wiki"]);
      const after = (await b.api("GET", "/api/servers/wiki")).body.config;
      expect(after.env).toEqual({ TOKEN: "{{secret://other}}" });
      expect(after).not.toHaveProperty("notes");
      expect((await b.api("GET", "/api/state")).body.servers).toHaveLength(1);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("rejects bad requests and unusable files without changing anything", async () => {
    const t = await startHub();
    try {
      expect((await t.api("POST", "/api/config/import", { onClash: "skip" })).status).toBe(400);
      expect((await t.api("POST", "/api/config/import", { data: {}, onClash: "overwrite" })).status).toBe(400);
      const res = await t.api("POST", "/api/config/import", { data: { hello: "world" } });
      expect(res.status).toBe(200);
      expect(res.body.problems[0].reason).toMatch(/isn't an MCP Hub export/);
      expect((await t.api("GET", "/api/state")).body.servers).toHaveLength(0);
    } finally {
      await t.stop();
    }
  });
});

describe("saving an export", () => {
  it("asks where to save, writes the file there privately, and can show it afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hub-export-"));
    const asked: Array<{ name: string; prompt: string }> = [];
    const revealed: string[] = [];
    const t = await startHub({}, { pickSavePath: async (name, prompt) => (asked.push({ name, prompt }), join(dir, "my-backup")), reveal: (p) => revealed.push(p) });
    try {
      expect((await t.api("POST", "/api/config/export/reveal")).status).toBe(404); // nothing saved yet
      await t.api("POST", "/api/servers", { name: "Wiki", transport: "stdio", command: "npx", enabled: false, env: { TOKEN: "{{op://V/Wiki/token}}" } });

      const res = await t.api("POST", "/api/config/export/save");
      expect(res.status).toBe(200);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.name).toMatch(/^mcp-hub-config-\d{4}-\d{2}-\d{2}\.json$/);
      // The extension is added when the person left it off, and the path is the one they picked.
      const path = join(dir, "my-backup.json");
      expect(res.body).toEqual({ path });
      const saved = JSON.parse(readFileSync(path, "utf-8"));
      expect(saved).toMatchObject({ format: "mcp-hub-config", servers: [{ name: "Wiki", env: { TOKEN: "{{op://V/Wiki/token}}" } }] });
      expect(statSync(path).mode & 0o777).toBe(0o600);

      expect((await t.api("POST", "/api/config/export/reveal")).status).toBe(200);
      expect(revealed).toEqual([path]);
    } finally {
      await t.stop();
    }
  });

  it("does nothing when the dialog is cancelled, and tells the app when there is no dialog to show", async () => {
    const cancelled = await startHub({}, { pickSavePath: async () => null });
    const none = await startHub({}, { pickSavePath: async () => undefined });
    try {
      expect((await cancelled.api("POST", "/api/config/export/save")).body).toEqual({ cancelled: true });
      expect((await cancelled.api("POST", "/api/config/export/reveal")).status).toBe(404);
      expect((await none.api("POST", "/api/config/export/save")).body).toEqual({ unsupported: true });
    } finally {
      await cancelled.stop();
      await none.stop();
    }
  });

  it("reports a location it can't write to, and never takes a path from the request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hub-export-"));
    const t = await startHub({}, { pickSavePath: async () => join(dir, "missing-folder", "x.json") });
    try {
      const res = await t.api("POST", "/api/config/export/save", { path: join(dir, "sneaky.json") });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Couldn't save the file/);
      expect(existsSync(join(dir, "sneaky.json"))).toBe(false);
    } finally {
      await t.stop();
    }
  });
});
