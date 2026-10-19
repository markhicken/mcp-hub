import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../src/credentials/box.js";
import { memoryKeyStore } from "../src/credentials/keystore.js";
import { SignInStore, type SavedSignIn } from "../src/credentials/signins.js";
import { Hub } from "../src/hub.js";
import { HubOAuthProvider, type SignInMemory } from "../src/oauth.js";
import { TOKEN, waitFor } from "./helpers.js";

const persistent = () => new SecretBox(randomBytes(32), true, "Test key store");
const tmp = () => mkdtempSync(join(tmpdir(), "mcp-hub-signin-"));
const sample = (): SavedSignIn => ({ tokens: { access_token: "access-xyz", refresh_token: "refresh-xyz", token_type: "Bearer", expires_in: 3600 }, client: { client_id: "dyn-client" }, origin: "https://x.test" });

describe("saved sign-ins", () => {
  it("are sealed on disk, bound to their server, and survive a restart", () => {
    const dir = tmp();
    const box = persistent();
    const file = join(dir, "signins.json");
    const store = new SignInStore(box, file);
    store.set("alpha", sample());
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("access-xyz");
    expect(text).not.toContain("refresh-xyz");
    expect(store.list()).toMatchObject([{ serverId: "alpha", refreshable: true }]);
    expect(store.list()[0]!.accessExpiresAt).toBeGreaterThan(Date.now());

    expect(new SignInStore(box, file).get("alpha")).toEqual(sample());

    // An entry moved to another server's name doesn't open.
    const moved = JSON.parse(text);
    moved.signIns.beta = moved.signIns.alpha;
    writeFileSync(file, JSON.stringify(moved));
    expect(new SignInStore(box, file).get("beta")).toBeUndefined();
    // Neither does one read with a different key.
    expect(new SignInStore(persistent(), file).get("alpha")).toBeUndefined();
  });

  it("are not saved without a persistent key, and can be forgotten one by one or all at once", () => {
    const dir = tmp();
    const file = join(dir, "signins.json");
    const memoryOnly = new SignInStore(SecretBox.ephemeral("no key store"), file);
    memoryOnly.set("alpha", sample());
    expect(memoryOnly.available).toBe(false);
    expect(memoryOnly.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);

    const store = new SignInStore(persistent(), file);
    store.set("alpha", sample());
    store.set("beta", sample());
    store.prune(["alpha"]);
    expect(store.list().map((e) => e.serverId)).toEqual(["alpha"]);
    expect(store.delete("alpha")).toBe(true);
    expect(existsSync(file)).toBe(false);
    store.set("gamma", sample());
    expect(store.wipe()).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("drop an expired sign-in that can't renew itself", () => {
    const store = new SignInStore(persistent(), join(tmp(), "signins.json"));
    store.set("alpha", { ...sample(), tokens: { access_token: "a", token_type: "Bearer", expires_in: -10 } });
    expect(store.get("alpha")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
  it("expire after the chosen time, and saving the same tokens again doesn't restart the clock", () => {
    vi.useFakeTimers();
    try {
      const file = join(tmp(), "signins.json");
      const box = persistent();
      let ttl = 7 * 86400;
      const store = new SignInStore(box, file, () => ttl);
      store.set("alpha", sample());
      vi.advanceTimersByTime(6 * 86400 * 1000);
      store.set("alpha", sample()); // unchanged: not a renewal
      expect(store.get("alpha")).toEqual(sample());
      vi.advanceTimersByTime(2 * 86400 * 1000);
      expect(store.list()).toEqual([]);
      expect(existsSync(file)).toBe(false);

      // New tokens (a refresh) do restart it, and a longer setting keeps it, 0 means until forgotten.
      store.set("beta", sample());
      vi.advanceTimersByTime(6 * 86400 * 1000);
      store.set("beta", { ...sample(), tokens: { ...sample().tokens, access_token: "renewed" } });
      vi.advanceTimersByTime(6 * 86400 * 1000);
      expect(store.get("beta")?.tokens.access_token).toBe("renewed");
      ttl = 0;
      vi.advanceTimersByTime(400 * 86400 * 1000);
      expect(store.list()).toHaveLength(1);
      expect(new SignInStore(box, file, () => 86400).list()).toEqual([]); // a shorter limit applies when loaded
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OAuth provider memory", () => {
  const setup = (remember: boolean, origin = "https://x.test") => {
    const store = new SignInStore(persistent(), join(tmp(), "signins.json"));
    const memory = (): SignInMemory => ({ remember: () => remember, origin, load: () => store.get("srv"), save: (s) => store.set("srv", s), clear: () => void store.delete("srv") });
    const provider = () => new HubOAuthProvider(() => "http://127.0.0.1/oauth/callback", {}, () => {}, memory());
    return { store, provider };
  };
  const tokens = { access_token: "a1", refresh_token: "r1", token_type: "Bearer" } as const;

  it("saves tokens and registration when remembering, and restores them in a new run", () => {
    const { store, provider } = setup(true);
    const first = provider();
    first.saveClientInformation({ client_id: "dyn" });
    expect(store.list()).toEqual([]); // nothing to remember until signed in
    first.saveTokens(tokens);
    expect(store.get("srv")).toMatchObject({ tokens, client: { client_id: "dyn" }, origin: "https://x.test" });

    const second = provider();
    expect(second.hasTokens).toBe(true);
    expect(second.tokens()).toEqual(tokens);
    expect(second.clientInformation()).toEqual({ client_id: "dyn" });
  });

  it("saves nothing when not remembering", () => {
    const { store, provider } = setup(false);
    provider().saveTokens(tokens);
    expect(store.list()).toEqual([]);
  });

  it("forgets on sign-out and when the server rejects the refresh token", () => {
    const { store, provider } = setup(true);
    const p = provider();
    p.saveTokens(tokens);
    p.invalidateCredentials("tokens");
    expect(store.list()).toEqual([]);
    p.saveTokens(tokens);
    p.signOut();
    expect(store.list()).toEqual([]);
  });

  it("starts or stops saving when the setting changes", () => {
    const store = new SignInStore(persistent(), join(tmp(), "signins.json"));
    let remember = false;
    const p = new HubOAuthProvider(() => "http://127.0.0.1/cb", {}, () => {}, { remember: () => remember, origin: "o", load: () => store.get("srv"), save: (s) => store.set("srv", s), clear: () => void store.delete("srv") });
    p.saveTokens(tokens);
    expect(store.list()).toEqual([]);
    remember = true;
    p.syncRemembered();
    expect(store.list()).toHaveLength(1);
    remember = false;
    p.syncRemembered();
    expect(store.list()).toEqual([]);
  });

  it("ignores a sign-in saved for another address", () => {
    const { store } = setup(true);
    store.set("srv", { ...sample(), origin: "https://elsewhere.test" });
    const p = new HubOAuthProvider(() => "http://127.0.0.1/cb", {}, () => {}, { remember: () => true, origin: "https://x.test", load: () => store.get("srv"), save: () => {}, clear: () => void store.delete("srv") });
    expect(p.hasTokens).toBe(false);
    expect(store.list()).toEqual([]);
  });
});

describe("remembered sign-ins in the hub", () => {
  let upstream: Server;
  let url = "";
  let origin = "";

  beforeAll(async () => {
    // A remote MCP server that only accepts the access token "good-token".
    upstream = createServer(async (req, res) => {
      const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
        return;
      }
      if (String(req.headers.authorization ?? "") !== "Bearer good-token") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const server = new McpServer({ name: "remote-mock", version: "1.0.0" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    url = `${origin}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => {
      upstream.close(() => r());
      upstream.closeAllConnections();
    });
  });

  const make = (dir: string, keyStore = memoryKeyStore()) => ({
    keyStore,
    start: async () => {
      const hub = new Hub({ dataDir: dir, configPath: join(dir, "config.json"), metricsPath: ":memory:", uiToken: TOKEN, quiet: true, keyStore });
      await hub.listen(0);
      const api = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(hub.baseUrl + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };
      return { hub, api };
    },
  });

  it("signs a server in after a restart without the browser, and each server can opt out", async () => {
    const dir = tmp();
    const m = make(dir);
    const first = await m.start();
    for (const [name, oauth] of [["Kept", { remember: true }], ["Declined", { remember: false }], ["Default", {}]] as const) {
      const res = await first.api("POST", "/api/servers", { name, transport: "http", url, auth: "oauth", oauth, enabled: false });
      expect(res.status).toBe(201);
    }
    const signedIn: SavedSignIn = { tokens: { access_token: "good-token", token_type: "Bearer" }, origin };
    for (const id of ["kept", "declined", "default"]) first.hub.signIns.set(id, signedIn);
    await first.hub.stop();

    expect(readFileSync(join(dir, "signins.json"), "utf-8")).not.toContain("good-token");

    const second = await m.start();
    try {
      let state = (await second.api("GET", "/api/state")).body;
      expect(state.credentials.signIns.available).toBe(true);
      expect(state.credentials.signIns.remembered.map((e: any) => e.serverId).sort()).toEqual(["declined", "default", "kept"]);

      // Declined and Default (setting off) lose their saved sign-in as soon as the server is saved or the setting changes.
      expect((await second.api("PUT", "/api/servers/declined", { oauth: { remember: false } })).status).toBe(200);
      expect((await second.api("PUT", "/api/settings", { rememberSignIns: false })).status).toBe(200);
      state = (await second.api("GET", "/api/state")).body;
      expect(state.credentials.signIns.remembered.map((e: any) => e.serverId)).toEqual(["kept"]);

      expect((await second.api("POST", "/api/servers/kept/enable")).status).toBe(200);
      await waitFor(async () => (await second.api("GET", "/api/servers/kept")).body.state === "connected", 10_000, "kept connected");
      expect((await second.api("GET", "/api/servers/kept")).body.authenticated).toBe(true);

      // Signing out forgets it for good.
      expect((await second.api("POST", "/api/servers/kept/signout")).status).toBe(200);
      state = (await second.api("GET", "/api/state")).body;
      expect(state.credentials.signIns.remembered).toEqual([]);
      expect(existsSync(join(dir, "signins.json"))).toBe(false);
    } finally {
      await second.hub.stop();
    }
  });

  it("follows the default setting, drops entries of deleted servers, and rejects a non-boolean", async () => {
    const dir = tmp();
    const m = make(dir);
    const { hub, api } = await m.start();
    try {
      expect((await api("PUT", "/api/settings", { rememberSignIns: "yes" })).status).toBe(400);
      expect((await api("POST", "/api/servers", { name: "Srv", transport: "http", url, auth: "oauth", oauth: { remember: "sure" } })).status).toBe(400);
      await api("POST", "/api/servers", { name: "Srv", transport: "http", url, auth: "oauth", enabled: false });
      const conn = hub.manager.get("srv")!;
      hub.signIns.set("srv", { tokens: { access_token: "good-token", token_type: "Bearer" }, origin });
      expect(hub.signIns.list()).toHaveLength(1);

      expect((await api("PUT", "/api/settings", { rememberSignIns: true })).status).toBe(200);
      expect(hub.signIns.list()).toHaveLength(1); // still wanted
      expect(conn.config.oauth?.remember).toBeUndefined();
      expect((await api("PUT", "/api/settings", { rememberSignIns: false })).status).toBe(200);
      expect(hub.signIns.list()).toEqual([]);

      hub.signIns.set("srv", { tokens: { access_token: "good-token", token_type: "Bearer" }, origin });
      expect((await api("DELETE", "/api/servers/srv")).status).toBe(200);
      expect(hub.signIns.list()).toEqual([]);
    } finally {
      await hub.stop();
    }
  });
});
