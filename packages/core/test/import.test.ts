import { describe, expect, it } from "vitest";
import { knownApps, parseEnvFile, pointsAtHub, toServerConfig, unwrapOpRun } from "../src/import.js";
import { MOCK, startHub, waitFor } from "./helpers.js";

describe("import", () => {
  it("lists the apps it can import from without reading anything", () => {
    const apps = knownApps();
    expect(apps.map((a) => a.client)).toContain("Claude Desktop");
    expect(apps.every((a) => a.path.length > 0)).toBe(true);
  });

  it("skips entries that already go through MCP Hub", () => {
    expect(pointsAtHub({ command: "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-stdio", args: ["docs"] })).toBe(true);
    expect(pointsAtHub({ command: "node", args: ["/Users/me/mcp-hub/packages/shim/src/shim.mjs", "docs"] })).toBe(true);
    expect(pointsAtHub({ url: "http://127.0.0.1:47615/mcp/docs" })).toBe(true);
    expect(pointsAtHub({ command: "npx", args: ["-y", "@acme/server"] })).toBe(false);
    expect(pointsAtHub({ url: "https://example.com/mcp" })).toBe(false);
  });

  it("moves op:// secrets out of the 1Password injector's arguments into env references", () => {
    const cfg = toServerConfig("Acme_Wiki", {
      command: "/x/inject-1password-secrets.sh",
      args: ["ACME_WIKI_ACCESS_TOKEN=op://Private/Acme Wiki/token", "PLAIN=yes", "--", "npx", "-y", "@acme/wiki-mcp", "--flag"],
      env: { KEEP: "1" },
    })!;
    expect(cfg).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@acme/wiki-mcp", "--flag"] });
    expect(cfg.env).toEqual({ KEEP: "1", ACME_WIKI_ACCESS_TOKEN: "{{op://Private/Acme Wiki/token}}", PLAIN: "yes" });
  });

  it("turns `op run --env-file` into the program plus the file's variables as references", () => {
    const files: Record<string, string> = {
      "/work/.env-dev": '# dev\nAPI_KEY=op://Private/Firewalla/key\nexport MODE="dev mode"\nPLAIN=yes # note\nMSG=\'op://V/I/f\'\n',
      "/work/more.env": "MODE=prod\n",
    };
    const read = (p: string) => files[p] ?? null;
    const entry = {
      command: "op",
      args: ["run", "--no-masking", "--env-file=/work/.env-dev", "--env-file", "/work/more.env", "--", "/usr/bin/node", "/x/npm-cli.js", "run", "dev"],
      env: { KEEP: "1", PLAIN: "from-app" },
    };
    const out = unwrapOpRun(entry, read);
    expect(out).toMatchObject({ command: "/usr/bin/node", args: ["/x/npm-cli.js", "run", "dev"] });
    // Later files and the file win over the entry's own env, and references become hub references.
    expect(out.env).toEqual({ KEEP: "1", PLAIN: "yes", API_KEY: "{{op://Private/Firewalla/key}}", MODE: "prod", MSG: "{{op://V/I/f}}" });
    expect(toServerConfig("Firewalla", out)).toMatchObject({ transport: "stdio", command: "/usr/bin/node" });
    // Relative files resolve against the entry's cwd; without one the entry is left alone.
    expect(unwrapOpRun({ command: "op", args: ["run", "--env-file=.env-dev", "--", "node", "a.js"], cwd: "/work" }, read).command).toBe("node");
    expect(unwrapOpRun({ command: "op", args: ["run", "--env-file=.env-dev", "--", "node", "a.js"] }, read).command).toBe("op");
  });

  it("leaves `op run` entries it can't reproduce exactly as they were", () => {
    const read = (p: string) => (p === "/ok.env" ? "A=1\n" : p === "/multi.env" ? 'A="one\ntwo"\n' : null);
    for (const args of [
      ["run", "--env-file=/missing.env", "--", "node"],
      ["run", "--env-file=/multi.env", "--", "node"],
      ["run", "--environment", "abc", "--", "node"],
      ["run", "--env-file=/ok.env"],
      ["run", "--", "node"],
      ["read", "op://a/b/c"],
    ]) {
      const entry = { command: "op", args };
      expect(unwrapOpRun(entry, read)).toBe(entry);
    }
    expect(parseEnvFile("not a pair")).toBeNull();
  });

  it("turns the injector's http mode into a remote server with header references", () => {
    const cfg = toServerConfig("Remote", {
      command: "inject-1password-secrets.sh",
      args: ["http"],
      env: { URL: "https://example.com/mcp", HEADERS: JSON.stringify({ Authorization: "Bearer 'op://V/Item/token'", "X-Plain": "a" }) },
    })!;
    expect(cfg).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer {{op://V/Item/token}}", "X-Plain": "a" } });
    expect(cfg.command).toBeUndefined();
  });

  it("leaves ordinary entries alone", () => {
    expect(toServerConfig("x", { command: "npx", args: ["-y", "pkg"], env: { A: "op://V/I/f" } })).toMatchObject({ command: "npx", env: { A: "op://V/I/f" } });
  });

  it("turns ${VAR} and ${env:VAR} into references the hub can resolve, and leaves other placeholders", () => {
    const cfg = toServerConfig("x", { command: "npx", args: ["--token", "${API_TOKEN}", "--dir", "${workspaceFolder}"], env: { A: "${env:HOME}/x", B: "${input:secret}" } })!;
    expect(cfg.args).toEqual(["--token", "{{env://API_TOKEN}}", "--dir", "${workspaceFolder}"]);
    expect(cfg.env).toEqual({ A: "{{env://HOME}}/x", B: "${input:secret}" });
    const http = toServerConfig("h", { url: "https://x/${TENANT}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } })!;
    expect(http).toMatchObject({ url: "https://x/{{env://TENANT}}/mcp", headers: { Authorization: "Bearer {{env://TOKEN}}" } });
  });

  it("imports an mcp-remote bridge as the HTTP server it really is, with its headers and secrets", () => {
    const cfg = toServerConfig("Remote API", {
      command: "npx",
      args: ["-y", "mcp-remote@latest", "https://remote.example.com/mcp", "--header", "Authorization: Bearer ${AUTH_TOKEN}", "--header", "X-Sandbox:${SANDBOX}", "--allow-http", "--transport", "http-only", "9696"],
      env: { AUTH_TOKEN: "op://Vault/Remote/token", SANDBOX: "stage" },
    })!;
    expect(cfg).toMatchObject({ transport: "http", url: "https://remote.example.com/mcp", headers: { Authorization: "Bearer {{op://Vault/Remote/token}}", "X-Sandbox": "stage" } });
    expect(cfg.command).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });

  it("expands a ${VAR} that is not in the entry's env from the hub's environment source", () => {
    const cfg = toServerConfig("r", { command: "mcp-remote", args: ["https://x/mcp", "--header=Authorization: Bearer ${GLOBAL_TOKEN}"] })!;
    expect(cfg).toMatchObject({ transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer {{env://GLOBAL_TOKEN}}" } });
  });

  it("unwraps mcp-remote that is itself run through the 1Password injector", () => {
    const cfg = toServerConfig("r", {
      command: "/Users/me/bin/inject-1password-secrets.sh",
      args: ["TOKEN=op://V/I/f", "--", "npx", "-y", "mcp-remote", "https://x/mcp", "--header", "Authorization:Bearer ${TOKEN}"],
    })!;
    expect(cfg).toMatchObject({ transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer {{op://V/I/f}}" } });
  });

  it("keeps an mcp-remote entry as a command when it uses options the hub can't reproduce", () => {
    const cfg = toServerConfig("r", { command: "npx", args: ["mcp-remote", "https://x/mcp", "--static-oauth-client-info", "{}"] })!;
    expect(cfg).toMatchObject({ transport: "stdio", command: "npx" });
  });

  it("leaves ${VAR} alone in a command when the entry's own env defines it (the program expands it)", () => {
    const cfg = toServerConfig("x", { command: "npx", args: ["pkg", "--auth", "${MY_AUTH}", "--other", "${FROM_SHELL}"], env: { MY_AUTH: "Bearer abc" } })!;
    expect(cfg.args).toEqual(["pkg", "--auth", "${MY_AUTH}", "--other", "{{env://FROM_SHELL}}"]);
    expect(cfg.env).toEqual({ MY_AUTH: "Bearer abc" });
  });

  it("imports servers that are switched off in the other app as off", () => {
    expect(toServerConfig("a", { command: "npx", disabled: true })!.enabled).toBe(false);
    expect(toServerConfig("b", { url: "https://x/mcp", enabled: false })!.enabled).toBe(false);
    expect(toServerConfig("c", { command: "npx" })!.enabled).toBe(true);
  });
  it("reads configs that contain comments and trailing commas", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scanClientConfigs } = await import("../src/import.js");
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-scan-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), '{\n  // mine\n  "mcpServers": {\n    "a": { "command": "npx", }, /* c */\n  },\n}\n');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(scanClientConfigs(new Set(), "Cursor")[0]!.servers.map((s) => s.name)).toEqual(["a"]);
    } finally {
      process.env.HOME = saved;
    }
  });
  it("reads and installs into Augment's settings file without touching its other settings", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scanClientConfigs } = await import("../src/import.js");
    const { installServer } = await import("../src/install.js");
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-scan-"));
    mkdirSync(join(home, ".augment"));
    const file = join(home, ".augment", "settings.json");
    writeFileSync(file, '{\n  "model": "sonnet4.5",\n  "mcpServers": {\n    "web": { "type": "http", "url": "https://example.com/mcp", "headers": { "X-Key": "k" } }\n  }\n}\n');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const [augment] = scanClientConfigs(new Set(), "Augment");
      expect(augment!.servers.map((s) => s.name)).toEqual(["web"]);
      const r = installServer("docs", ["Augment"], { command: "/hub/mcp-hub-stdio", args: [] });
      expect(r[0]!.status).toBe("added");
      const after = JSON.parse(readFileSync(file, "utf-8"));
      expect(after.model).toBe("sonnet4.5");
      expect(Object.keys(after.mcpServers)).toEqual(["web", "docs"]);
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe("scan", () => {
  it("lists entries that already use MCP Hub but marks them as not importable", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scanClientConfigs } = await import("../src/import.js");
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-scan-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-stdio", args: ["docs"] }, other: { command: "npx", args: ["-y", "pkg"] } } }));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const [cursor] = scanClientConfigs(new Set(), "Cursor");
      expect(cursor!.servers.find((s) => s.name === "docs")).toEqual({ name: "docs", viaHub: true });
      expect(cursor!.servers.find((s) => s.name === "other")?.config?.command).toBe("npx");
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe("import API", () => {
  it("replaces a same-named server in place, or adds a copy", async () => {
    const t = await startHub();
    try {
      await t.api("POST", "/api/servers", { name: "Wiki", transport: "stdio", command: process.execPath, args: [MOCK], env: { OLD: "1" }, enabled: false });
      const incoming = { id: "wiki-2", name: "Wiki", transport: "stdio", command: process.execPath, args: [MOCK, "--new"], env: { TOKEN: "{{op://V/I/f}}" } };

      const copy = await t.api("POST", "/api/import", { servers: [incoming] });
      expect(copy.body.added.map((s: { id: string }) => s.id)).toEqual(["wiki-2"]);
      await t.api("DELETE", "/api/servers/wiki-2");

      const res = await t.api("POST", "/api/import", { servers: [{ ...incoming, replaceId: "wiki" }] });
      expect(res.status).toBe(201);
      expect(res.body.replaced).toEqual(["wiki"]);
      const servers = (await t.api("GET", "/api/state")).body.servers;
      expect(servers.map((s: { id: string }) => s.id)).toEqual(["wiki"]);
      expect(servers[0].config).toMatchObject({ id: "wiki", args: [MOCK, "--new"], env: { TOKEN: "{{op://V/I/f}}" }, enabled: false });

      expect((await t.api("POST", "/api/import", { servers: [{ ...incoming, replaceId: "nope" }] })).status).toBe(404);
      await waitFor(() => true);
    } finally {
      await t.stop();
    }
  });
});
