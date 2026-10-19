import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultProvider } from "../src/credentials/vault.js";
import { SecretBox } from "../src/credentials/box.js";
import { LocalSecrets } from "../src/credentials/local-secrets.js";
import type { SourceConfig } from "../src/types.js";

let server: Server;
let address = "";
let status = 403;

beforeAll(async () => {
  server = createServer((req, res) => {
    const good = req.headers["x-vault-token"] === "good";
    if (good && req.url?.includes("lookup-self")) return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    if (good) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { data: { pw: "hunter2" } } }));
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ errors: ["permission denied"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const provider = (options: Record<string, string>, env: NodeJS.ProcessEnv = {}) => {
  const source: SourceConfig = { id: "vault", type: "vault", name: "Vault", enabled: true, options: { address, ...options } };
  return createVaultProvider(source, { memory: new LocalSecrets(SecretBox.ephemeral()), env });
};

describe("Vault errors", () => {
  it("explains a refused token, with Vault's own reason and what to do", async () => {
    const r = await provider({ tokenSource: "env" }, { VAULT_TOKEN: "stale" }).test();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("HTTP 403: permission denied");
    expect(r.message).toContain("VAULT_TOKEN");
    expect(r.hint).toBeUndefined();
  });

  it("suggests signing in again when the token comes from ~/.vault-token", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-vhome-"));
    writeFileSync(join(home, ".vault-token"), "stale");
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await provider({ tokenSource: "file" }).test();
      expect(r).toMatchObject({ ok: false, hint: "sign-in" });
      expect(r.message).toMatch(/expired. Sign in again/);
    } finally {
      process.env.HOME = saved;
    }
  });

  it("names the path and the likely cause when a read is refused", async () => {
    await expect(provider({ tokenSource: "env" }, { VAULT_TOKEN: "stale" }).resolve("vault://apps/wiki#pw")).rejects.toMatchObject({
      kind: "denied",
      message: expect.stringMatching(/refused access to apps\/wiki \(HTTP 403: permission denied\).*lacks|may lack a policy/),
    });
  });

  it("works with a good token and says so when there is none", async () => {
    expect(await provider({ tokenSource: "env" }, { VAULT_TOKEN: "good" }).test()).toEqual({ ok: true, message: "Authenticated to Vault" });
    expect(await provider({ tokenSource: "env" }, { VAULT_TOKEN: "good" }).resolve("vault://apps/wiki#pw")).toBe("hunter2");
    const none = await provider({ tokenSource: "env" }).test();
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/No Vault token available/);
    expect((await provider({ address: "" , tokenSource: "env" }).test()).message).toContain("Edit this source");
    status = 403;
  });
});
