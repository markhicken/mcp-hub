import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addCodexServer, migrateCodexText, readCodexServers } from "../src/codex.js";
import { knownApps, scanClientConfigs, toServerConfig } from "../src/import.js";
import { installServer, migrateClientConfig } from "../src/install.js";
import { startHub } from "./helpers.js";

const BRIDGE = { command: "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-stdio", args: [] as string[] };
const entry = (id: string) => ({ command: BRIDGE.command, args: [...BRIDGE.args, id] });

const SAMPLE = `# My Codex config
model = "gpt-5"

[mcp_servers.context7]
# docs lookup
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
API_KEY = "abc"
OTHER = "x"

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Team" = "core" }
env_http_headers = { "X-Org" = "ORG_ID" }

[profiles.fast]
model = "gpt-5-mini"
`;

describe("reading Codex config", () => {
  it("turns tables into the same shape other apps use", () => {
    const { servers } = readCodexServers(SAMPLE);
    expect(servers.context7).toEqual({ command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { API_KEY: "abc", OTHER: "x" } });
    expect(servers.remote).toEqual({
      url: "https://example.com/mcp",
      type: "http",
      headers: { "X-Team": "core", "X-Org": "{{env://ORG_ID}}", Authorization: "Bearer {{env://REMOTE_TOKEN}}" },
    });
  });

  it("imports env-based headers as credential references, and keeps disabled servers off", () => {
    const cfg = toServerConfig("remote", readCodexServers(SAMPLE).servers.remote!)!;
    expect(cfg).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer {{env://REMOTE_TOKEN}}" } });
    const off = readCodexServers('[mcp_servers.x]\ncommand = "npx"\nenabled = false\n').servers.x!;
    expect(toServerConfig("x", off)!.enabled).toBe(false);
  });

  it("reports a file that isn't valid TOML, and no servers when there are none", () => {
    expect(readCodexServers("this is = = bad").error).toMatch(/isn't valid TOML/);
    expect(readCodexServers('model = "x"\n')).toEqual({ servers: {} });
  });
});

describe("adding to Codex config", () => {
  it("appends one table and leaves everything else exactly as it was", () => {
    const out = addCodexServer(SAMPLE, "docs", entry("docs"));
    expect(out.status).toBe("added");
    expect(out.text).toBe(`${SAMPLE}\n[mcp_servers.docs]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["docs"]\n`);
  });

  it("starts a file that is empty, adds a separating line when there is no final newline, and keeps CRLF", () => {
    expect(addCodexServer("", "a", entry("a")).text).toBe(`[mcp_servers.a]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["a"]\n`);
    expect(addCodexServer('model = "x"', "a", entry("a")).text).toBe(`model = "x"\n\n[mcp_servers.a]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["a"]\n`);
    const crlf = addCodexServer('model = "x"\r\n', "a", entry("a")).text!;
    expect(crlf.includes("\r\n")).toBe(true);
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("does nothing when the hub is already there, refuses to overwrite a different server, and leaves bad files alone", () => {
    const withHub = addCodexServer(SAMPLE, "docs", entry("docs")).text!;
    expect(addCodexServer(withHub, "docs", entry("docs")).status).toBe("already");
    expect(addCodexServer(SAMPLE, "context7", entry("context7"))).toMatchObject({ status: "conflict" });
    expect(addCodexServer("not = = toml", "a", entry("a"))).toMatchObject({ status: "error" });
    expect(addCodexServer('mcp_servers = { a = { command = "x" } }\n', "b", entry("b"))).toMatchObject({ status: "error" });
  });
});

describe("migrating Codex config", () => {
  it("replaces a server's tables (and its sub-tables) under the same name and keeps the rest", () => {
    const out = migrateCodexText(SAMPLE, { context7: entry("context7") });
    expect(out.error).toBeUndefined();
    expect(out.migrated).toEqual(["context7"]);
    expect(out.text).toBe(`# My Codex config
model = "gpt-5"

[mcp_servers.context7]
command = ${JSON.stringify(BRIDGE.command)}
args = ["context7"]

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Team" = "core" }
env_http_headers = { "X-Org" = "ORG_ID" }

[profiles.fast]
model = "gpt-5-mini"
`);
  });

  it("can replace several servers, skips ones already on the hub, and quotes unusual names", () => {
    const text = `[mcp_servers."my server"]\ncommand = "a"\n\n[mcp_servers.done]\ncommand = "${BRIDGE.command}"\nargs = ["done"]\n`;
    const out = migrateCodexText(text, { "my server": entry("my-server"), done: entry("done") });
    expect(out.migrated).toEqual(["my server"]);
    expect(out.text).toContain(`[mcp_servers."my server"]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["my-server"]\n`);
    expect(out.text).toContain(`[mcp_servers.done]\ncommand = "${BRIDGE.command}"\nargs = ["done"]`);
  });

  it("isn't fooled by multi-line arrays or strings that look like table headers", () => {
    const text = `[mcp_servers.a]\ncommand = "x"\nargs = [\n  "one",\n  ["nested"]\n]\nnote = """\n[mcp_servers.b]\n"""\n\n[other]\nk = 1\n`;
    const out = migrateCodexText(text, { a: entry("a") });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(`[mcp_servers.a]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["a"]\n\n[other]\nk = 1\n`);
  });

  it("leaves a layout it can't edit safely alone, and says so", () => {
    const out = migrateCodexText('mcp_servers.a.command = "x"\nmodel = "y"\n', { a: entry("a") });
    expect(out.text).toBeUndefined();
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.reason).toMatch(/can't edit safely/);
  });

  it("refuses a file that isn't valid TOML", () => {
    expect(migrateCodexText("a = = b", { a: entry("a") }).error).toMatch(/isn't valid TOML/);
  });
});

describe("the ChatGPT / Codex app", () => {
  function withCodexHome<T>(setup: (dir: string) => void, run: (dir: string, file: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hub-codex-"));
    mkdirSync(dir, { recursive: true });
    setup(dir);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    return Promise.resolve(run(dir, join(dir, "config.toml"))).finally(() => {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    });
  }

  it("is listed with the file it reads, which honours CODEX_HOME, right after Claude Code", async () => {
    await withCodexHome(() => {}, (_dir, file) => {
      const apps = knownApps().map((a) => a.client);
      expect(apps.indexOf("ChatGPT / Codex")).toBe(apps.indexOf("Claude Code") + 1);
      expect(knownApps().find((a) => a.client === "ChatGPT / Codex")?.path).toBe(file);
    });
  });

  it("is scanned, installed into and migrated like the other apps, with a backup", async () => {
    await withCodexHome(
      (dir) => writeFileSync(join(dir, "config.toml"), SAMPLE),
      async (_dir, file) => {
        const scan = scanClientConfigs(new Set(), "ChatGPT / Codex")[0]!;
        expect(scan.servers.map((s) => s.name)).toEqual(["context7", "remote"]);

        const files = [{ client: "ChatGPT / Codex", path: file, shape: "mcpServers" as const, key: "mcp_servers" as const, format: "toml" as const }];
        const installed = installServer("docs", ["ChatGPT / Codex"], BRIDGE, files)[0]!;
        expect(installed.status).toBe("added");
        expect(readFileSync(installed.backup!, "utf-8")).toBe(SAMPLE);
        expect(readFileSync(file, "utf-8").startsWith(SAMPLE)).toBe(true);
        expect(installServer("docs", ["ChatGPT / Codex"], BRIDGE, files)[0]!.status).toBe("already");

        const migrated = migrateClientConfig("ChatGPT / Codex", { context7: "context7" }, BRIDGE, files);
        expect(migrated).toMatchObject({ status: "added", migrated: ["context7"] });
        expect(readFileSync(file, "utf-8")).toContain('args = ["context7"]');
        expect(readFileSync(file, "utf-8")).toContain("[profiles.fast]");
        // Scanning again shows it as already using MCP Hub.
        const again = scanClientConfigs(new Set(), "ChatGPT / Codex")[0]!;
        expect(again.servers.find((s) => s.name === "context7")).toMatchObject({ viaHub: true });
      },
    );
  });

  it("works through the hub's API", async () => {
    const config = SAMPLE.replace("https://example.com/mcp", "http://127.0.0.1:9/mcp");
    await withCodexHome(
      (dir) => writeFileSync(join(dir, "config.toml"), config),
      async (_dir, file) => {
        const t = await startHub({ REMOTE_TOKEN: "tok", ORG_ID: "org" }, { shim: BRIDGE });
        try {
          const apps = (await t.api("GET", "/api/import/apps")).body.apps as Array<{ client: string }>;
          expect(apps.map((a) => a.client)).toContain("ChatGPT / Codex");
          const res = await t.api("POST", "/api/migrate", { client: "ChatGPT / Codex", names: ["remote"], onClash: "keep" });
          expect(res.status).toBe(200);
          expect(res.body.servers).toEqual([{ name: "remote", id: "remote", mode: "added" }]);
          expect(res.body.config).toMatchObject({ status: "added", migrated: ["remote"] });
          // The hub got the real definition, including the env-based header as a reference.
          expect((await t.api("GET", "/api/servers/remote")).body.config).toMatchObject({ transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer {{env://REMOTE_TOKEN}}", "X-Org": "{{env://ORG_ID}}" } });
          expect(readFileSync(file, "utf-8")).toContain(`[mcp_servers.remote]\ncommand = ${JSON.stringify(BRIDGE.command)}\nargs = ["remote"]`);
        } finally {
          await t.stop();
        }
      },
    );
  });
});
