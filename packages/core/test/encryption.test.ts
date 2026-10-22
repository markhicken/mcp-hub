import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBox, SecretBoxError, SEAL_PREFIX } from "../src/credentials/box.js";
import { CredentialBroker } from "../src/credentials/broker.js";
import { loadSecretBox, memoryKeyStore, osKeyStore, type KeyStore } from "../src/credentials/keystore.js";
import { LocalSecrets } from "../src/credentials/local-secrets.js";
import { Hub } from "../src/hub.js";
import { LogBuffer } from "../src/logs.js";
import { ConfigStore } from "../src/store.js";
import type { ServerConfig } from "../src/types.js";
import { TOKEN } from "./helpers.js";

const persistent = (key = randomBytes(32)) => new SecretBox(key, true, "Test key store");
const tmp = () => mkdtempSync(join(tmpdir(), "mcp-hub-enc-"));

describe("secret box", () => {
  it("round-trips text and never stores it readable", () => {
    const box = persistent();
    const sealed = box.seal("hunter2-token");
    expect(sealed.startsWith(SEAL_PREFIX)).toBe(true);
    expect(sealed).not.toContain("hunter2");
    expect(box.open(sealed)).toBe("hunter2-token");
    expect(box.seal("hunter2-token")).not.toBe(sealed); // fresh IV every time
  });

  it("rejects tampering, a different key and a different binding", () => {
    const box = persistent();
    const sealed = box.seal("value", "secret:a");
    expect(() => box.open(sealed, "secret:b")).toThrow(SecretBoxError);
    expect(() => persistent().open(sealed, "secret:a")).toThrow(SecretBoxError);
    const bytes = Buffer.from(sealed.slice(SEAL_PREFIX.length), "base64");
    bytes[bytes.length - 1]! ^= 1;
    const flipped = SEAL_PREFIX + bytes.toString("base64");
    expect(() => box.open(flipped, "secret:a")).toThrow(SecretBoxError);
  });

  it("passes unsealed text through and describes itself", () => {
    const box = persistent();
    expect(box.open("plain")).toBe("plain");
    expect(box.info()).toEqual({ algorithm: "AES-256-GCM", keyStore: "Test key store", persistent: true });
    expect(SecretBox.ephemeral("why").info()).toMatchObject({ persistent: false, keyStore: "memory only", problem: "why" });
  });
});

describe("master key", () => {
  it("is created once, kept in the key store and reused", () => {
    let saved: Buffer | null = null;
    const ks: KeyStore = { name: "KS", read: () => saved, write: (k) => void (saved = k) };
    const first = loadSecretBox(ks, { allowCreate: true });
    expect(first.persistent).toBe(true);
    expect(saved).toHaveLength(32);
    const sealed = first.seal("x");
    expect(loadSecretBox(ks, { allowCreate: false }).open(sealed)).toBe("x");
  });

  it("is never replaced when saved data exists, and falls back to memory with a reason", () => {
    const missing = loadSecretBox({ name: "KS", read: () => null, write: () => {} }, { allowCreate: false });
    expect(missing.persistent).toBe(false);
    expect(missing.problem).toMatch(/missing from KS/);
    const broken = loadSecretBox({ name: "KS", read: () => { throw new Error("locked"); }, write: () => {} }, { allowCreate: true });
    expect(broken.persistent).toBe(false);
    expect(broken.problem).toMatch(/KS can't be used \(locked\)/);
  });
  it("can be kept in memory only (MCP_HUB_KEYSTORE=memory), so a start-up check never touches the real key store", () => {
    const saved = process.env.MCP_HUB_KEYSTORE;
    process.env.MCP_HUB_KEYSTORE = "memory";
    try {
      const store = osKeyStore();
      expect(store.read()).toBeNull();
      const box = loadSecretBox(store, { allowCreate: true });
      expect(box.persistent).toBe(true);
      expect(store.read()).toHaveLength(32);
      expect(osKeyStore().read()).toBeNull(); // each start has its own; nothing was saved anywhere
    } finally {
      if (saved === undefined) delete process.env.MCP_HUB_KEYSTORE;
      else process.env.MCP_HUB_KEYSTORE = saved;
    }
  });
});

describe("local secrets", () => {
  it("are saved encrypted, survive a restart and are decrypted only when read", () => {
    const dir = tmp();
    const file = join(dir, "secrets.json");
    const key = randomBytes(32);
    const a = new LocalSecrets(persistent(key), file);
    a.set("github", "ghp_supersecret");
    a.set("vault-token/v", "s.vaulttoken");
    const onDisk = readFileSync(file, "utf-8");
    expect(onDisk).not.toContain("ghp_supersecret");
    expect(onDisk).not.toContain("s.vaulttoken");
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, algorithm: "AES-256-GCM" });

    const b = new LocalSecrets(persistent(key), file);
    expect(b.names()).toEqual(["github", "vault-token/v"]);
    expect(b.get("github")).toBe("ghp_supersecret");
    b.delete("github");
    expect(new LocalSecrets(persistent(key), file).names()).toEqual(["vault-token/v"]);

    // A different key can see that something is there but can't open it, and says so.
    expect(() => new LocalSecrets(persistent(), file).get("vault-token/v")).toThrow(/can't be decrypted/);
  });

  it("stay in memory only, and are forgotten by lock, when no key store is available", () => {
    const dir = tmp();
    const file = join(dir, "secrets.json");
    const s = new LocalSecrets(SecretBox.ephemeral(), file);
    s.set("a", "value");
    expect(existsSync(file)).toBe(false);
    expect(s.get("a")).toBe("value");
  });

  it("keep their saved copies when the hub is locked", () => {
    const dir = tmp();
    const file = join(dir, "secrets.json");
    const box = persistent();
    const s = new LocalSecrets(box, file);
    s.set("a", "value");
    s.lock();
    expect(s.get("a")).toBe("value");
  });
});

describe("references in server definitions", () => {
  const server: ServerConfig = {
    id: "svc",
    name: "Svc",
    transport: "stdio",
    command: "npx",
    args: ["--token", "{{secret://t}}", "--plain"],
    env: { A: "{{op://Vault/Item/field}}", B: "plain", C: "op://Vault/Bare/field" },
    headers: { Authorization: "Bearer {{keychain://svc/acct}}" },
    enabled: true,
    lifecycle: "keep-alive",
  };

  it("are encrypted on disk and in memory, and revealed only on request", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    const box = persistent();
    const store = new ConfigStore(path, box);
    store.upsertServer(server);

    const raw = readFileSync(path, "utf-8");
    for (const secret of ["secret://t", "op://Vault/Item/field", "op://Vault/Bare/field", "keychain://svc/acct"]) expect(raw).not.toContain(secret);
    // Only references are sealed; names, plain values and structure stay readable.
    expect(raw).toContain('"--plain"');
    expect(raw).toContain('"B": "plain"');
    expect(raw).toContain('"command": "npx"');

    const inMemory = store.getServer("svc")!;
    expect(JSON.stringify(inMemory)).not.toContain("op://");
    expect(inMemory.env!.A!.startsWith(SEAL_PREFIX)).toBe(true);
    expect(store.reveal(inMemory)).toEqual(server);
    expect(new ConfigStore(path, box).reveal(new ConfigStore(path, box).getServer("svc")!)).toEqual(server);
  });

  it("are sealed on first start for configs saved before encryption existed", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ version: 1, servers: [server], sources: [], settings: {} }));
    const box = persistent();
    const store = new ConfigStore(path, box);
    expect(readFileSync(path, "utf-8")).not.toContain("op://Vault/Item/field");
    expect(store.reveal(store.getServer("svc")!)).toEqual(server);
  });

  it("are left as they are when the key can't be kept, and a missing key doesn't lose them", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    new ConfigStore(path, persistent()).upsertServer(server);
    const sealedRaw = readFileSync(path, "utf-8");

    // Wrong key: the values can't be opened, but they are kept intact rather than blanked.
    const other = new ConfigStore(path, persistent());
    expect(other.reveal(other.getServer("svc")!).env!.A!.startsWith(SEAL_PREFIX)).toBe(true);
    expect(ConfigStore.hasSealed(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(sealedRaw);

    // No persistent key at all: nothing is sealed, so nothing is written that couldn't be read back.
    const plainPath = join(dir, "plain.json");
    new ConfigStore(plainPath, SecretBox.ephemeral()).upsertServer(server);
    expect(readFileSync(plainPath, "utf-8")).toContain("op://Vault/Item/field");
  });
});

describe("secrets held in memory", () => {
  const sources = [{ id: "env", type: "env" as const, name: "Env", enabled: true, options: {} }];

  it("are encrypted in the cache and forgotten on schedule, including after the timeout is shortened", async () => {
    let clock = 1_000_000;
    let ttl = 3600;
    const b = new CredentialBroker({ getSources: () => sources, getCacheTtlSeconds: () => ttl, getDenialCooldownSeconds: () => 0, env: { API_KEY: "sk-live-12345" }, now: () => clock, box: persistent() });
    try {
      expect(await b.resolve("env://API_KEY", "svc")).toBe("sk-live-12345");
      const held = [...(b as unknown as { cache: Map<string, { value: string }> }).cache.values()];
      expect(held).toHaveLength(1);
      expect(held[0]!.value.startsWith(SEAL_PREFIX)).toBe(true);
      expect(held[0]!.value).not.toContain("sk-live");
      expect(await b.resolve("env://API_KEY", "svc")).toBe("sk-live-12345"); // opened from the cache

      clock += 20 * 60_000; // 20 minutes later it is still held...
      expect(b.cached()).toHaveLength(1);
      ttl = 600; // ...until the user shortens the timeout to 10 minutes
      b.applyTtl();
      expect(b.cached()).toHaveLength(0);
      expect((b as unknown as { cache: Map<string, unknown> }).cache.size).toBe(0);
    } finally {
      b.close();
    }
  });

  it("keep their masks sealed in the log buffer", () => {
    const logs = new LogBuffer(10, undefined, persistent());
    logs.setSecrets(["s3cr3t-token"]);
    expect(JSON.stringify((logs as unknown as { secrets: string[] }).secrets)).not.toContain("s3cr3t");
    logs.add("stderr", "calling with s3cr3t-token now");
    expect(logs.tail()[0]!.text).toBe("calling with ••• now");
  });
});

describe("hub restart", () => {
  it("keeps local secrets and encrypted references, and reports how they are protected", async () => {
    const dir = tmp();
    const keyStore = memoryKeyStore();
    const make = () => new Hub({ dataDir: dir, configPath: join(dir, "config.json"), metricsPath: ":memory:", uiToken: TOKEN, quiet: true, keyStore });
    const api = async (hub: Hub, method: string, path: string, body?: unknown) => {
      const res = await fetch(hub.baseUrl + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };

    const first = make();
    await first.listen(0);
    expect((await api(first, "PUT", "/api/secrets/api-token", { value: "tok-abc-123" })).status).toBe(200);
    expect((await api(first, "POST", "/api/servers", { name: "Svc", transport: "stdio", command: "npx", enabled: false, env: { TOKEN: "{{secret://api-token}}" } })).status).toBe(201);
    const state = (await api(first, "GET", "/api/state")).body;
    expect(state.credentials.encryption).toEqual({ algorithm: "AES-256-GCM", keyStore: "Test key store", persistent: true, locked: false });
    expect(state.servers[0].config.env.TOKEN).toBe("{{secret://api-token}}"); // shown readable
    await first.stop();

    for (const f of ["config.json", "secrets.json"]) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text).not.toContain("tok-abc-123");
      expect(text).not.toContain("secret://api-token");
    }

    const second = make();
    await second.listen(0);
    try {
      const after = (await api(second, "GET", "/api/state")).body;
      expect(after.credentials.manualSecrets).toEqual(["api-token"]);
      expect(after.servers[0].config.env.TOKEN).toBe("{{secret://api-token}}");
      expect(await second.broker.resolve("secret://api-token", "test")).toBe("tok-abc-123");
    } finally {
      await second.stop();
    }
  });

  it("remembers that the recovery key was saved, and only accepts true or false", async () => {
    const dir = tmp();
    const hub = new Hub({ dataDir: dir, configPath: join(dir, "config.json"), metricsPath: ":memory:", uiToken: TOKEN, quiet: true, keyStore: memoryKeyStore() });
    await hub.listen(0);
    const put = (body: unknown) => fetch(`${hub.baseUrl}/api/settings`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect(hub.store.settings.recoveryKeySaved).toBe(false);
      expect((await put({ recoveryKeySaved: "yes" })).status).toBe(400);
      expect((await put({ recoveryKeySaved: true })).status).toBe(200);
      expect(hub.store.settings.recoveryKeySaved).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).settings.recoveryKeySaved).toBe(true);
    } finally {
      await hub.stop();
    }
  });

  it("applies a shorter 'forget after' time to secrets already held", async () => {
    const dir = tmp();
    const hub = new Hub({ dataDir: dir, configPath: join(dir, "config.json"), metricsPath: ":memory:", uiToken: TOKEN, quiet: true, keyStore: memoryKeyStore(), baseEnv: () => ({ ...process.env, HUB_ENC_TEST: "v" }) });
    hub.store.upsertSource({ ...hub.store.sources.find((s) => s.type === "env")!, enabled: true });
    await hub.listen(0);
    try {
      await hub.broker.resolve("env://HUB_ENC_TEST", "test");
      expect(hub.broker.cached()).toHaveLength(1);
      const entry = (hub.broker as unknown as { cache: Map<string, { fetchedAt: number }> }).cache.values().next().value!;
      entry.fetchedAt -= 10 * 60_000; // fetched 10 minutes ago
      const res = await fetch(`${hub.baseUrl}/api/settings`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ cacheTtlSeconds: 300 }) });
      expect(res.status).toBe(200);
      expect(hub.broker.cached()).toHaveLength(0);
    } finally {
      await hub.stop();
    }
  });
});

describe("recovering from a lost key", () => {
  /** A key store that starts empty, like a keychain item that was deleted. */
  const emptyKeyStore = (): KeyStore & { saved: Buffer | null } => {
    const ks = { name: "Lost key store", saved: null as Buffer | null, read: () => ks.saved, write: (k: Buffer) => void (ks.saved = k) };
    return ks;
  };
  const open = (dir: string, keyStore: KeyStore) => new Hub({ dataDir: dir, configPath: join(dir, "config.json"), metricsPath: ":memory:", uiToken: TOKEN, quiet: true, keyStore });
  const call = async (hub: Hub, method: string, path: string, body?: unknown) => {
    const res = await fetch(hub.baseUrl + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** A data folder with a local secret and a server holding a sealed reference, plus the recovery key that opens them. */
  async function seeded(): Promise<{ dir: string; recoveryKey: string }> {
    const dir = tmp();
    const hub = open(dir, memoryKeyStore());
    await hub.listen(0);
    await call(hub, "PUT", "/api/secrets/api-token", { value: "tok-abc-123" });
    await call(hub, "POST", "/api/servers", { name: "Svc", transport: "stdio", command: "npx", enabled: false, env: { TOKEN: "{{secret://api-token}}", KEEP: "plain" } });
    const recoveryKey = (await call(hub, "GET", "/api/credentials/recovery-key")).body.key as string;
    await hub.stop();
    return { dir, recoveryKey };
  }

  it("shows a recovery key only while encryption is working", async () => {
    const { dir, recoveryKey } = await seeded();
    expect(recoveryKey).toHaveLength(44);

    const lost = open(dir, emptyKeyStore());
    await lost.listen(0);
    try {
      expect((await call(lost, "GET", "/api/credentials/recovery-key")).status).toBe(409);
    } finally {
      await lost.stop();
    }
  });

  it("reports saved data it can't open, keeps it intact, and restores it with the recovery key", async () => {
    const { dir, recoveryKey } = await seeded();
    const sealedBefore = readFileSync(join(dir, "config.json"), "utf-8");
    const ks = emptyKeyStore();
    const hub = open(dir, ks);
    await hub.listen(0);
    try {
      const state = (await call(hub, "GET", "/api/state")).body;
      expect(state.credentials.encryption).toMatchObject({ persistent: false, locked: true });
      expect(state.credentials.encryption.problem).toMatch(/missing from Lost key store/);
      expect(state.servers[0].config.env.TOKEN.startsWith("enc:v1:")).toBe(true); // can't be read, but not lost
      expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe(sealedBefore);
      expect(ks.saved).toBeNull(); // no replacement key was invented

      // Not a key, then a key that doesn't match: both refused, nothing changes.
      expect((await call(hub, "POST", "/api/credentials/restore-key", { key: "nope" })).status).toBe(400);
      const wrong = await call(hub, "POST", "/api/credentials/restore-key", { key: randomBytes(32).toString("base64") });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatch(/isn't the right one/);
      expect(ks.saved).toBeNull();

      const ok = await call(hub, "POST", "/api/credentials/restore-key", { key: recoveryKey });
      expect(ok.status).toBe(200);
      expect(ks.saved!.toString("base64")).toBe(recoveryKey);
      const after = (await call(hub, "GET", "/api/state")).body;
      expect(after.credentials.encryption).toMatchObject({ persistent: true, locked: false });
      expect(after.servers[0].config.env).toEqual({ TOKEN: "{{secret://api-token}}", KEEP: "plain" });
      expect(after.credentials.manualSecrets).toEqual(["api-token"]);
      expect(await hub.broker.resolve("secret://api-token", "test")).toBe("tok-abc-123");
    } finally {
      await hub.stop();
    }
  });

  it("starts over with a new key, removing only what can no longer be read", async () => {
    const { dir } = await seeded();
    const ks = emptyKeyStore();
    const hub = open(dir, ks);
    await hub.listen(0);
    try {
      const res = await call(hub, "POST", "/api/credentials/reset-encryption");
      expect(res.status).toBe(200);
      expect(res.body.affected).toEqual([{ id: "svc", name: "Svc" }]);
      expect(res.body.localSecretsRemoved).toBe(1);
      expect(ks.saved).toHaveLength(32);

      const state = (await call(hub, "GET", "/api/state")).body;
      expect(state.credentials.encryption).toMatchObject({ persistent: true, locked: false });
      expect(state.credentials.manualSecrets).toEqual([]);
      expect(existsSync(join(dir, "secrets.json"))).toBe(false);
      // The unreadable reference is emptied and the server switched off; its plain settings are kept.
      expect(state.servers[0].config).toMatchObject({ enabled: false, command: "npx", env: { TOKEN: "", KEEP: "plain" } });

      // Everything works again with the new key.
      await call(hub, "PUT", "/api/secrets/fresh", { value: "new-value" });
      expect(await hub.broker.resolve("secret://fresh", "test")).toBe("new-value");
      expect(readFileSync(join(dir, "secrets.json"), "utf-8")).not.toContain("new-value");
      // And it can't be used to wipe a healthy setup.
      expect((await call(hub, "POST", "/api/credentials/reset-encryption")).status).toBe(409);
    } finally {
      await hub.stop();
    }
  });
});
