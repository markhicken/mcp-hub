import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addServerToConfig, backupFile, bridgeEntry, httpEntry, installServer, installServers, migrateConfigText, previewInstall, previewInstallServers } from "../src/install.js";
import type { ClientConfigFile } from "../src/import.js";
import { startHub } from "./helpers.js";

const BRIDGE = { command: "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-stdio", args: [] as string[] };
const entry = bridgeEntry("Cursor", BRIDGE, "docs");

/** The expected result of inserting `entry` after the last property of a 2-space file. */
const NEW_ENTRY = `    "docs": {
      "command": "${BRIDGE.command}",
      "args": [
        "docs"
      ]
    }`;

describe("editing a config in place", () => {
  it("adds the entry without touching anything else (2 spaces, comments, odd spacing)", () => {
    const before = `{
  // my servers
  "theme":   "dark",
  "mcpServers": {
    "other": { "command": "npx",  "args": ["-y", "pkg"] }, // keep me
    /* and me */
    "second": {"command":"x"}
  },
  "after": [1,2,   3]
}
`;
    const out = addServerToConfig(before, "mcpServers", "docs", entry);
    expect(out.status).toBe("added");
    // The only differences are one comma and the new lines.
    expect(out.text).toBe(before.replace(`"second": {"command":"x"}\n`, `"second": {"command":"x"},\n${NEW_ENTRY}\n`));
  });

  it("puts the comma before a trailing comment and keeps the comment where it was", () => {
    const before = `{\n  "mcpServers": {\n    "a": { "command": "x" } // note\n  }\n}\n`;
    const out = addServerToConfig(before, "mcpServers", "docs", entry).text!;
    expect(out).toBe(before.replace(`"a": { "command": "x" } // note\n`, `"a": { "command": "x" }, // note\n${NEW_ENTRY}\n`));
  });

  it("respects an existing trailing comma", () => {
    const before = `{\n  "mcpServers": {\n    "a": { "command": "x" },\n  },\n}\n`;
    const out = addServerToConfig(before, "mcpServers", "docs", entry).text!;
    expect(out).toBe(before.replace(`"a": { "command": "x" },\n`, `"a": { "command": "x" },\n${NEW_ENTRY},\n`));
  });

  it("handles a compact one-line file", () => {
    const before = `{"mcpServers":{"a":{"command":"x"}}}`;
    const out = addServerToConfig(before, "mcpServers", "docs", entry).text!;
    expect(out.startsWith(`{"mcpServers":{"a":{"command":"x"}, "docs": {`)).toBe(true);
    expect(JSON.parse(out).mcpServers.a).toEqual({ command: "x" });
  });

  it("keeps tabs, CRLF line endings and a BOM", () => {
    const before = '\uFEFF{\r\n\t"mcpServers": {\r\n\t\t"other": { "command": "x" }\r\n\t}\r\n}\r\n';
    const after = addServerToConfig(before, "mcpServers", "docs", entry).text!;
    expect(after.startsWith("\uFEFF{")).toBe(true);
    expect(after).toContain('\t\t"docs": {');
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after).toContain('\t\t"other": { "command": "x" }');
  });

  it("creates the servers object when the file doesn't have one yet", () => {
    const before = `{\n    "numStartups": 12,\n    "projects": {}\n}\n`;
    const after = addServerToConfig(before, "mcpServers", "docs", entry).text!;
    expect(after).toContain(`    "numStartups": 12,`);
    expect(JSON.parse(after)).toEqual({ numStartups: 12, projects: {}, mcpServers: { docs: entry } });
    expect(after).toContain("\n    ");
  });

  it("works on an empty object, an empty servers object and an empty file", () => {
    expect(JSON.parse(addServerToConfig("{}", "mcpServers", "docs", entry).text!)).toEqual({ mcpServers: { docs: entry } });
    expect(JSON.parse(addServerToConfig('{ "mcpServers": {} }', "mcpServers", "docs", entry).text!)).toEqual({ mcpServers: { docs: entry } });
    expect(JSON.parse(addServerToConfig("  \n", "servers", "docs", entry).text!)).toEqual({ servers: { docs: entry } });
  });

  it("does nothing when the hub's version is already there, whatever it is called", () => {
    const withKey = JSON.stringify({ mcpServers: { docs: entry } });
    expect(addServerToConfig(withKey, "mcpServers", "docs", entry)).toMatchObject({ status: "already" });
    const renamed = JSON.stringify({ mcpServers: { "my-docs": { command: BRIDGE.command, args: ["docs"] } } });
    const r = addServerToConfig(renamed, "mcpServers", "docs", entry);
    expect(r.status).toBe("already");
    expect(r.text).toBeUndefined();
    // A bridge entry for a different server doesn't count.
    expect(addServerToConfig(JSON.stringify({ mcpServers: { x: { command: BRIDGE.command, args: ["jira"] } } }), "mcpServers", "docs", entry).status).toBe("added");
  });

  it("won't overwrite a different server that has the same name, and mentions the original", () => {
    const clash = addServerToConfig(JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["pkg"] } } }), "mcpServers", "docs", entry);
    expect(clash.status).toBe("conflict");
    expect(clash.text).toBeUndefined();
    const original = addServerToConfig(JSON.stringify({ mcpServers: { Acme_Wiki: { command: "npx" } } }), "mcpServers", "acme-wiki", bridgeEntry("Cursor", BRIDGE, "acme-wiki"));
    expect(original.status).toBe("added");
    expect(original.message).toContain('"Acme_Wiki" entry is still there');
  });

  it("leaves files it can't safely edit alone", () => {
    expect(addServerToConfig("{ not json", "mcpServers", "docs", entry).status).toBe("error");
    expect(addServerToConfig("[1, 2]", "mcpServers", "docs", entry).status).toBe("error");
    expect(addServerToConfig('{ "mcpServers": [] }', "mcpServers", "docs", entry).status).toBe("error");
  });

  it("uses each app's own entry shape", () => {
    expect(bridgeEntry("Claude Desktop", BRIDGE, "docs")).toEqual({ command: BRIDGE.command, args: ["docs"] });
    expect(bridgeEntry("GitHub Copilot CLI", BRIDGE, "docs")).toMatchObject({ type: "local", tools: ["*"] });
    expect(bridgeEntry("VS Code", BRIDGE, "docs")).toMatchObject({ type: "stdio" });
  });

  it("installs the direct HTTP endpoint instead of the bridge when asked", () => {
    const http = { url: "http://127.0.0.1:47615/mcp/docs", token: "tok" };
    expect(httpEntry("Cursor", http)).toEqual({ url: http.url, headers: { Authorization: "Bearer tok" } });
    expect(httpEntry("VS Code", { url: http.url })).toEqual({ type: "http", url: http.url });
    expect(httpEntry("GitHub Copilot CLI", http)).toMatchObject({ type: "http", url: http.url, tools: ["*"] });
    expect(httpEntry("Claude Desktop", http)).toMatchObject({ command: "npx", args: expect.arrayContaining(["mcp-remote", http.url]), env: { MCP_HUB_AUTH: "Bearer tok" } });
    const out = addServerToConfig("{}", "mcpServers", "docs", httpEntry("Cursor", http));
    expect(JSON.parse(out.text!).mcpServers.docs.url).toBe(http.url);
    // The same server reached either way counts as already installed.
    expect(addServerToConfig(out.text!, "mcpServers", "docs", entry).status).toBe("already");
    const desktop = addServerToConfig("{}", "mcpServers", "docs", httpEntry("Claude Desktop", http));
    expect(addServerToConfig(desktop.text!, "mcpServers", "docs", entry).status).toBe("already");
  });
});

describe("installing into files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-install-"));
  mkdirSync(join(dir, "app"));
  const files: ClientConfigFile[] = [
    { client: "Cursor", path: join(dir, "app", "mcp.json"), shape: "mcpServers", key: "mcpServers" },
    { client: "VS Code", path: join(dir, "app", "vscode.json"), shape: "mcpServers", key: "servers" },
    { client: "Claude Desktop", path: join(dir, "app", "missing.json"), shape: "mcpServers", key: "mcpServers" },
  ];
  const original = '{\n  "mcpServers": {\n    "keep":   { "command": "x" }\n  }\n}\n';
  const siblings = () => readdirSync(join(dir, "app")).filter((f) => f.includes("mcp-hub-backup")).length;

  it("writes only the files that were asked for, and reports each one", () => {
    writeFileSync(files[0]!.path, original, { mode: 0o640 });
    writeFileSync(files[1]!.path, "{}");
    const results = installServer("docs", ["Cursor", "Claude Desktop"], BRIDGE, files);
    expect(results.map((r) => [r.client, r.status])).toEqual([["Cursor", "added"], ["Claude Desktop", "no-file"]]);
    expect(readFileSync(files[0]!.path, "utf-8")).toContain('"keep":   { "command": "x" }');
    expect(JSON.parse(readFileSync(files[0]!.path, "utf-8")).mcpServers.docs).toEqual({ command: BRIDGE.command, args: ["docs"] });
    expect(readFileSync(files[1]!.path, "utf-8")).toBe("{}");
    // The file was backed up next to the original, byte for byte, with the same permissions, before it changed.
    const backup = results[0]!.backup!;
    expect(backup.startsWith(realpathSync(files[0]!.path) + ".mcp-hub-backup-")).toBe(true);
    expect(readFileSync(backup, "utf-8")).toBe(original);
    expect(statSync(backup).mode & 0o777).toBe(statSync(files[0]!.path).mode & 0o777);
    expect(results[1]!.backup).toBeUndefined();
    // Asking again changes nothing and makes no new backup.
    const again = readFileSync(files[0]!.path, "utf-8");
    const before = siblings();
    expect(installServer("docs", ["Cursor"], BRIDGE, files)[0]!.status).toBe("already");
    expect(readFileSync(files[0]!.path, "utf-8")).toBe(again);
    expect(siblings()).toBe(before);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("changes nothing if the backup can't be made", () => {
    const sub = join(dir, "ro");
    mkdirSync(sub);
    const f = join(sub, "mcp.json");
    writeFileSync(f, "{}");
    chmodSync(sub, 0o500); // the file is readable and replaceable only through this folder
    try {
      const r = installServer("docs", ["Cursor"], BRIDGE, [{ ...files[0]!, path: f }]);
      expect(r[0]!.status).toBe("error");
      expect(readFileSync(f, "utf-8")).toBe("{}");
    } finally {
      chmodSync(sub, 0o700);
    }
  });

  it("keeps only the newest few backups per file", () => {
    const f = join(dir, "app", "many.json");
    writeFileSync(f, "{}");
    for (let i = 0; i < 14; i++) backupFile(f);
    expect(readdirSync(join(dir, "app")).filter((n) => n.startsWith("many.json.mcp-hub-backup-")).length).toBe(10);
    // Other files' backups are not touched.
    expect(readdirSync(join(dir, "app")).filter((n) => n.startsWith("mcp.json.mcp-hub-backup-")).length).toBeGreaterThan(0);
  });

  describe("when the app already has the same MCP", () => {
    const sub = join(dir, "clash");
    mkdirSync(sub);
    const json: ClientConfigFile = { client: "Cursor", path: join(sub, "mcp.json"), shape: "mcpServers", key: "mcpServers" };
    const toml: ClientConfigFile = { client: "ChatGPT / Codex", path: join(sub, "config.toml"), shape: "mcpServers", key: "mcp_servers", format: "toml" };
    const missing: ClientConfigFile = { client: "VS Code", path: join(sub, "nope.json"), shape: "mcpServers", key: "servers" };
    const theirs = '{\n  // mine\n  "mcpServers": {\n    "docs": { "url": "https://user:pw@example.com/mcp?token=abc", "headers": { "Authorization": "x" } },\n    "other": { "command": "x" }\n  }\n}\n';
    const theirsToml = '# mine\n[mcp_servers.Docs]\ncommand = "npx"\nargs = ["-y", "pkg", "--key=abc"]\n\n[mcp_servers.other]\ncommand = "x"\n';
    const all = [json, toml, missing];

    it("reports what would be replaced without changing or leaking anything", () => {
      writeFileSync(json.path, theirs);
      writeFileSync(toml.path, theirsToml);
      const before = readdirSync(sub).length;
      const p = previewInstall("docs", ["Cursor", "ChatGPT / Codex", "VS Code"], BRIDGE, all);
      expect(p.map((x) => [x.client, x.status])).toEqual([["Cursor", "replace"], ["ChatGPT / Codex", "replace"], ["VS Code", "no-file"]]);
      expect(p[0]!.existing).toEqual([{ key: "docs", summary: "https://example.com/mcp" }]);
      expect(p[1]!.existing).toEqual([{ key: "Docs", summary: "npx" }]);
      expect(JSON.stringify(p)).not.toMatch(/abc|pw|Authorization/);
      expect(readFileSync(json.path, "utf-8")).toBe(theirs);
      expect(readdirSync(sub).length).toBe(before);
      writeFileSync(join(sub, "fresh.json"), "{}");
      expect(previewInstall("docs", ["Cursor"], BRIDGE, [{ ...json, path: join(sub, "fresh.json") }])[0]).toMatchObject({ status: "add", existing: [] });
    });

    it("refuses to replace unless asked, and then backs up and swaps in the hub's entry under the same name", () => {
      writeFileSync(json.path, theirs);
      writeFileSync(toml.path, theirsToml);
      const plain = installServer("docs", ["Cursor"], BRIDGE, all)[0]!;
      expect(plain.status).toBe("conflict");
      expect(readFileSync(json.path, "utf-8")).toBe(theirs);

      const r = installServer("docs", ["Cursor", "ChatGPT / Codex", "VS Code"], BRIDGE, all, { replace: true });
      expect(r.map((x) => x.status)).toEqual(["replaced", "replaced", "no-file"]);
      const out = readFileSync(json.path, "utf-8");
      expect(out).toContain("// mine");
      expect(JSON.parse(out.replace("// mine", "")).mcpServers).toEqual({ docs: entry, other: { command: "x" } });
      expect(readFileSync(r[0]!.backup!, "utf-8")).toBe(theirs);
      const t = readFileSync(toml.path, "utf-8");
      expect(t).toContain("# mine");
      expect(t).toContain("[mcp_servers.Docs]");
      expect(t).toContain(`"${BRIDGE.command}"`);
      expect(t).not.toContain("--key=abc");
      expect(t).toContain("[mcp_servers.other]");
      expect(readFileSync(r[1]!.backup!, "utf-8")).toBe(theirsToml);
      // Done: asking again changes nothing.
      expect(previewInstall("docs", ["Cursor", "ChatGPT / Codex"], BRIDGE, all).map((x) => x.status)).toEqual(["already", "already"]);
    });
  });

  it("installs several servers into one app with a single backup and a single write", () => {
    const f: ClientConfigFile = { client: "Cursor", path: join(dir, "app", "batch.json"), shape: "mcpServers", key: "mcpServers" };
    const start = '{\n  "mcpServers": {\n    "wiki": { "command": "theirs" },\n    "keep": { "command": "x" }\n  }\n}\n';
    writeFileSync(f.path, start);
    const backups = () => readdirSync(join(dir, "app")).filter((n) => n.startsWith("batch.json.mcp-hub-backup-")).length;

    const p = previewInstallServers(["docs", "wiki", "docs"], "Cursor", BRIDGE, [f]);
    expect(p.servers.map((s) => [s.serverId, s.status])).toEqual([["docs", "add"], ["wiki", "replace"], ["docs", "add"]]);
    expect(readFileSync(f.path, "utf-8")).toBe(start);
    expect(backups()).toBe(0);

    // Without confirmation only the plain additions go through.
    const plain = installServers(["docs", "wiki", "notes"], "Cursor", BRIDGE, [f]);
    expect(plain.servers.map((s) => [s.serverId, s.status])).toEqual([["docs", "added"], ["wiki", "conflict"], ["notes", "added"]]);
    expect(JSON.parse(readFileSync(f.path, "utf-8")).mcpServers).toMatchObject({ wiki: { command: "theirs" }, docs: { args: ["docs"] }, notes: { args: ["notes"] } });
    expect(readFileSync(plain.backup!, "utf-8")).toBe(start);
    expect(backups()).toBe(1);

    const confirmed = installServers(["docs", "wiki"], "Cursor", BRIDGE, [f], { replace: true });
    expect(confirmed.servers.map((s) => [s.serverId, s.status])).toEqual([["docs", "already"], ["wiki", "replaced"]]);
    expect(JSON.parse(readFileSync(f.path, "utf-8")).mcpServers.wiki.args).toEqual(["wiki"]);
    expect(backups()).toBe(2);

    // Nothing to change: no new backup.
    expect(installServers(["docs"], "Cursor", BRIDGE, [f]).backup).toBeUndefined();
    expect(backups()).toBe(2);
    expect(installServers(["docs"], "Cursor", BRIDGE, [{ ...f, path: join(dir, "app", "none.json") }]).servers[0]!.status).toBe("no-file");
  });

  it("shows a known app's config file in the file manager, and only by app name", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    const revealed: string[] = [];
    const t = await startHub({}, { reveal: (p: string) => revealed.push(p) });
    try {
      expect((await t.api("POST", "/api/apps/reveal", { client: "Cursor" })).status).toBe(404); // no file yet
      writeFileSync(join(home, ".cursor", "mcp.json"), "{}");
      expect((await t.api("POST", "/api/apps/reveal", { client: "Cursor" })).status).toBe(200);
      expect(revealed).toEqual([join(home, ".cursor", "mcp.json")]);
      // A backup can be shown only if it is a backup copy sitting next to that app's config file.
      const backup = join(home, ".cursor", "mcp.json.mcp-hub-backup-2026-01-01-0001");
      writeFileSync(backup, "{}");
      writeFileSync(join(home, ".cursor", "other.txt"), "x");
      expect((await t.api("POST", "/api/apps/reveal", { client: "Cursor", backup })).status).toBe(200);
      expect(revealed.at(-1)).toBe(realpathSync(backup));
      for (const bad of [join(home, ".cursor", "other.txt"), "/etc/passwd", join(home, ".cursor", "mcp.json.mcp-hub-backup-missing")]) {
        expect((await t.api("POST", "/api/apps/reveal", { client: "Cursor", backup: bad })).status).toBe(404);
      }
      expect(revealed).toHaveLength(2);
      // A path in the request is never used.
      expect((await t.api("POST", "/api/apps/reveal", { client: "/etc/passwd" })).status).toBe(400);
      expect((await t.api("POST", "/api/apps/reveal", { path: "/etc/passwd" })).status).toBe(400);
      expect((await t.api("POST", "/api/clients/nope/reveal")).status).toBe(404);
      expect(revealed).toHaveLength(2);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });

  it("is exposed over the API and refuses unknown apps", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), original);
    const saved = process.env.HOME;
    process.env.HOME = home;
    const t = await startHub({}, { shim: BRIDGE });
    try {
      await t.api("POST", "/api/servers", { name: "Docs", transport: "http", url: "https://example.com/mcp", enabled: false });
      expect((await t.api("POST", "/api/servers/docs/install", { clients: ["Nope"] })).status).toBe(400);
      expect((await t.api("POST", "/api/servers/zzz/install", { clients: ["Cursor"] })).status).toBe(404);
      expect((await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], replace: "yes" })).status).toBe(400);
      // A different server with the same name: the dry run says so, a plain install refuses, a confirmed one replaces it.
      writeFileSync(join(home, ".cursor", "mcp.json"), '{"mcpServers":{"docs":{"command":"npx","args":["x"]}}}');
      const dry = await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], dryRun: true });
      expect(dry.body.preview[0]).toMatchObject({ client: "Cursor", status: "replace", existing: [{ key: "docs", summary: "npx" }] });
      expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.docs.command).toBe("npx");
      expect((await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"] })).body.results[0].status).toBe("conflict");
      const swapped = await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], replace: true });
      expect(swapped.body.results[0].status).toBe("replaced");
      expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.docs.args).toEqual(["docs"]);
      writeFileSync(join(home, ".cursor", "mcp.json"), original);
      const ok = await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"] });
      expect(ok.body.results[0]).toMatchObject({ client: "Cursor", status: "added" });
      expect(ok.body.results[0].backup.startsWith(realpathSync(join(home, ".cursor", "mcp.json")) + ".mcp-hub-backup-")).toBe(true);
      expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.docs.args).toEqual(["docs"]);

      // Direct HTTP: refused while the hub doesn't allow it, otherwise the entry points at the hub's URL (with the token if one is required).
      writeFileSync(join(home, ".cursor", "mcp.json"), original);
      expect((await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], transport: "ftp" })).status).toBe(400);
      await t.api("PUT", "/api/settings", { allowTcpMcp: false });
      expect((await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], transport: "http" })).status).toBe(400);
      await t.api("PUT", "/api/settings", { allowTcpMcp: true, requireClientToken: true });
      const viaHttp = await t.api("POST", "/api/servers/docs/install", { clients: ["Cursor"], transport: "http" });
      expect(viaHttp.body.results[0].status).toBe("added");
      const entryHttp = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.docs;
      expect(entryHttp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/docs$/);
      expect(entryHttp.headers.Authorization).toMatch(/^Bearer .+/);
      await t.api("PUT", "/api/settings", { requireClientToken: false });

      // Several servers at once: validated, previewed, then installed into the one file.
      await t.api("POST", "/api/servers", { name: "Wiki", transport: "http", url: "https://example.com/wiki", enabled: false });
      writeFileSync(join(home, ".cursor", "mcp.json"), original);
      expect((await t.api("POST", "/api/install", { client: "Nope", servers: ["docs"] })).status).toBe(400);
      expect((await t.api("POST", "/api/install", { client: "Cursor", servers: [] })).status).toBe(400);
      expect((await t.api("POST", "/api/install", { client: "Cursor", servers: ["zzz"] })).status).toBe(400);
      const many = await t.api("POST", "/api/install", { client: "Cursor", servers: ["docs", "wiki"], dryRun: true });
      expect(many.body.preview.servers.map((s: { status: string }) => s.status)).toEqual(["add", "add"]);
      expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).toBe(original);
      const done = await t.api("POST", "/api/install", { client: "Cursor", servers: ["docs", "wiki"] });
      expect(done.body.result.servers.map((s: { status: string }) => s.status)).toEqual(["added", "added"]);
      expect(Object.keys(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers)).toEqual(["keep", "docs", "wiki"]);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });
});

describe("migrating existing entries", () => {
  const plan = { Acme_Wiki: { command: BRIDGE.command, args: ["acme-wiki"] } };

  it("replaces the entry's value but keeps its key, comments and everything around it", () => {
    const before = `{
  // servers
  "mcpServers": {
    "Acme_Wiki": {
      "command": "/x/inject-1password-secrets.sh",
      "args": ["T=op://V/I/f", "--", "npx", "wiki"]
    }, // wiki
    "other":   { "command": "keep-me" }
  },
  "theme": "dark"
}
`;
    const out = migrateConfigText(before, plan);
    expect(out.migrated).toEqual(["Acme_Wiki"]);
    expect(out.text).toBe(`{
  // servers
  "mcpServers": {
    "Acme_Wiki": {
      "command": "${BRIDGE.command}",
      "args": [
        "acme-wiki"
      ]
    }, // wiki
    "other":   { "command": "keep-me" }
  },
  "theme": "dark"
}
`);
  });

  it("leaves entries that already use MCP Hub and entries it wasn't asked about", () => {
    const text = JSON.stringify({ mcpServers: { Acme_Wiki: { command: BRIDGE.command, args: ["acme-wiki"] }, Jira: { command: "x" } } });
    const out = migrateConfigText(text, { ...plan, Jira: { command: BRIDGE.command, args: ["jira"] } });
    expect(out.migrated).toEqual(["Jira"]);
    expect(JSON.parse(out.text!).mcpServers.Acme_Wiki.args).toEqual(["acme-wiki"]);
    expect(migrateConfigText(JSON.stringify({ mcpServers: { Other: { command: "x" } } }), plan).text).toBeUndefined();
  });

  it("also migrates identical per-project copies (Claude Code) but not different ones", () => {
    const same = { command: "npx", args: ["wiki"] };
    const text = JSON.stringify({
      mcpServers: { Acme_Wiki: same },
      projects: { "/a": { mcpServers: { Acme_Wiki: same } }, "/b": { mcpServers: { Acme_Wiki: { command: "npx", args: ["other"] } } }, "/c": { allowedTools: [] } },
    }, null, 2);
    const out = migrateConfigText(text, plan);
    const json = JSON.parse(out.text!);
    expect(json.mcpServers.Acme_Wiki.args).toEqual(["acme-wiki"]);
    expect(json.projects["/a"].mcpServers.Acme_Wiki.args).toEqual(["acme-wiki"]);
    expect(json.projects["/b"].mcpServers.Acme_Wiki.args).toEqual(["other"]);
    expect(out.skipped).toHaveLength(1);
  });

  it("refuses to touch a file it can't parse", () => {
    expect(migrateConfigText("{ nope", plan).error).toBeTruthy();
  });

  it("brings the servers into the hub, rewrites the app's config under the same names and backs it up", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    const original = `{\n  "mcpServers": {\n    "Acme_Wiki": { "disabled": true, "command": "/x/inject-1password-secrets.sh", "args": ["TOKEN=op://V/Wiki/token", "--", "npx", "-y", "wiki-mcp"] },\n    "Mine": { "command": "npx", "args": ["mine"] }\n  }\n}\n`;
    writeFileSync(file, original);
    const saved = process.env.HOME;
    process.env.HOME = home;
    const t = await startHub({}, { shim: BRIDGE });
    try {
      const bad = await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Nope"], onClash: "keep" });
      expect(bad.status).toBe(404);
      expect((await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Acme_Wiki"], onClash: "maybe" })).status).toBe(400);
      expect(readFileSync(file, "utf-8")).toBe(original);

      const res = await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Acme_Wiki"], onClash: "keep" });
      expect(res.status).toBe(200);
      expect(res.body.servers).toEqual([{ name: "Acme_Wiki", id: "acme-wiki", mode: "added" }]);
      expect(res.body.config).toMatchObject({ status: "added", migrated: ["Acme_Wiki"] });
      expect(readFileSync(res.body.config.backup, "utf-8")).toBe(original);

      // The hub got the real definition, with the secret moved into an env reference.
      const hubServer = (await t.api("GET", "/api/servers/acme-wiki")).body.config;
      expect(hubServer).toMatchObject({ command: "npx", args: ["-y", "wiki-mcp"], env: { TOKEN: "{{op://V/Wiki/token}}" } });

      // The app keeps the key, so its tool names stay the same; "Mine" wasn't selected and is untouched.
      const after = JSON.parse(readFileSync(file, "utf-8"));
      expect(after.mcpServers.Acme_Wiki).toEqual({ command: BRIDGE.command, args: ["acme-wiki"] });
      expect(after.mcpServers.Mine).toEqual({ command: "npx", args: ["mine"] });

      // Migrating again finds nothing left to do for that entry.
      expect((await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Acme_Wiki"], onClash: "keep" })).status).toBe(404);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });

  it("migrates an mcp-remote entry as an HTTP server and keeps its secret headers", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { "remote-stage": { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:9/mcp", "--allow-http", "--header", "Authorization: Bearer ${AUTH_TOKEN}"], env: { AUTH_TOKEN: "abc123" } } } }));
    const saved = process.env.HOME;
    process.env.HOME = home;
    const t = await startHub({}, { shim: BRIDGE });
    try {
      const res = await t.api("POST", "/api/migrate", { client: "Cursor", names: ["remote-stage"], onClash: "keep" });
      expect(res.body.config).toMatchObject({ status: "added", migrated: ["remote-stage"] });
      const cfg = (await t.api("GET", "/api/servers/remote-stage")).body.config;
      expect(cfg).toMatchObject({ transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer abc123" } });
      expect(cfg.command).toBeUndefined();
      // Nothing is listening there, so it is reported, but it wasn't a setup problem so the entry still moved.
      expect(res.body.problems).toMatchObject([{ name: "remote-stage", blocked: false }]);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });

  it("leaves an app's entry alone when the hub can't resolve its references", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    const original = JSON.stringify({ mcpServers: { Broken: { command: "npx", args: ["pkg"], env: { TOKEN: "${HUB_TEST_UNSET_VARIABLE}" } } } });
    writeFileSync(file, original);
    const saved = process.env.HOME;
    process.env.HOME = home;
    const t = await startHub({}, { shim: BRIDGE });
    try {
      const res = await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Broken"], onClash: "keep" });
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({ status: "error", migrated: [] });
      expect(res.body.problems).toMatchObject([{ name: "Broken", blocked: true }]);
      expect(readFileSync(file, "utf-8")).toBe(original);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });

  it("can reuse or replace a server that is already in the hub", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-home-"));
    mkdirSync(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");
    const saved = process.env.HOME;
    process.env.HOME = home;
    const t = await startHub({}, { shim: BRIDGE });
    try {
      await t.api("POST", "/api/servers", { name: "Wiki", transport: "stdio", command: "old", enabled: false });
      writeFileSync(file, JSON.stringify({ mcpServers: { Wiki: { command: "new" } } }));
      const keep = (await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Wiki"], onClash: "keep" })).body;
      expect(keep.servers).toEqual([{ name: "Wiki", id: "wiki", mode: "reused" }]);
      expect((await t.api("GET", "/api/servers/wiki")).body.config.command).toBe("old");

      writeFileSync(file, JSON.stringify({ mcpServers: { Wiki: { command: "new" } } }));
      const rep = (await t.api("POST", "/api/migrate", { client: "Cursor", names: ["Wiki"], onClash: "replace" })).body;
      expect(rep.servers).toEqual([{ name: "Wiki", id: "wiki", mode: "replaced" }]);
      const cfg = (await t.api("GET", "/api/servers/wiki")).body.config;
      expect(cfg).toMatchObject({ command: "new", enabled: false });
      expect((await t.api("GET", "/api/state")).body.servers).toHaveLength(1);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });
});
