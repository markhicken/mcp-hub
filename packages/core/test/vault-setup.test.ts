import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSetup } from "../src/credentials/setup.js";
import { PINNED_VAULT_VERSION, installVaultCli, latestVaultVersion, vaultAsset } from "../src/credentials/vault-installer.js";
import type { SourceConfig } from "../src/types.js";
import { startHub } from "./helpers.js";

const FAKE_VAULT = join(import.meta.dirname, "fixtures", "fake-vault.mjs");
chmodSync(FAKE_VAULT, 0o755);

function zipOf(reported: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-fakevault-"));
  writeFileSync(join(dir, "vault"), `#!/bin/sh\necho "Vault v${reported} (abc)"\n`);
  chmodSync(join(dir, "vault"), 0o755);
  execFileSync("zip", ["-q", "vault.zip", "vault"], { cwd: dir });
  return readFileSync(join(dir, "vault.zip"));
}

const sumsFor = (version: string, zip: Buffer, hash = createHash("sha256").update(zip).digest("hex")) =>
  `deadbeef  vault_${version}_other.zip\n${hash}  ${vaultAsset(version, "darwin", "arm64")}\n`;

let server: Server;
let base = "";
let served: Record<string, Buffer | string> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = served[req.url ?? ""];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const deps = (extra = {}) => ({ releasesUrl: `${base}/rel`, checkpointUrl: `${base}/check`, platform: "darwin" as const, arch: "arm64", ...extra });
const serve = (version: string, zip: Buffer, sums = sumsFor(version, zip)) => ({
  [`/rel/${version}/vault_${version}_SHA256SUMS`]: sums,
  [`/rel/${version}/${vaultAsset(version, "darwin", "arm64")}`]: zip,
});

describe("Vault CLI installer", () => {
  it("names HashiCorp's zips and declines unsupported systems", () => {
    expect(vaultAsset("1.18.3", "darwin", "arm64")).toBe("vault_1.18.3_darwin_arm64.zip");
    expect(vaultAsset("1.18.3", "linux", "x64")).toBe("vault_1.18.3_linux_amd64.zip");
    expect(vaultAsset("1.18.3", "win32", "x64")).toBe("vault_1.18.3_windows_amd64.zip");
    expect(vaultAsset("1.18.3", "freebsd" as NodeJS.Platform, "x64")).toBeNull();
    expect(vaultAsset("1.18.3", "darwin", "ia32")).toBeNull();
  });

  it("reads the newest version from HashiCorp's version check", async () => {
    served = { "/check": JSON.stringify({ current_version: "1.99.0" }) };
    expect(await latestVaultVersion(fetch, `${base}/check`)).toBe("1.99.0");
    served = { "/check": "not json" };
    expect(await latestVaultVersion(fetch, `${base}/check`)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("installs after checking the checksum and the reported version", async () => {
    const zip = zipOf("1.99.0");
    served = { "/check": JSON.stringify({ current_version: "1.99.0" }), ...serve("1.99.0", zip) };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    const r = await installVaultCli(tools, deps());
    expect(r).toEqual({ path: join(tools, "1.99.0", "vault"), version: "1.99.0" });
    expect(execFileSync(r.path, ["version"]).toString()).toContain("v1.99.0");
  });

  it.skipIf(process.platform === "win32")("falls back to the pinned version when the newest can't be downloaded", async () => {
    served = { "/check": JSON.stringify({ current_version: "1.99.0" }), ...serve(PINNED_VAULT_VERSION, zipOf(PINNED_VAULT_VERSION)) };
    expect((await installVaultCli(mkdtempSync(join(tmpdir(), "mcp-hub-tools-")), deps())).version).toBe(PINNED_VAULT_VERSION);
  });

  it.skipIf(process.platform === "win32")("discards a download whose checksum doesn't match", async () => {
    const zip = zipOf("1.99.0");
    served = { "/check": JSON.stringify({ current_version: "1.99.0" }), ...serve("1.99.0", zip, sumsFor("1.99.0", zip, "0".repeat(64))) };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    await expect(installVaultCli(tools, deps())).rejects.toThrow(/checksum/);
    expect(existsSync(join(tools, "1.99.0"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("installs nothing if the binary reports another version", async () => {
    served = { "/check": JSON.stringify({ current_version: "1.99.0" }), ...serve("1.99.0", zipOf("0.1.0")) };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    await expect(installVaultCli(tools, deps())).rejects.toThrow(/not Vault 1\.99\.0/);
    expect(existsSync(join(tools, "1.99.0"))).toBe(false);
  });

  it("explains itself on unsupported systems and when nothing can be downloaded", async () => {
    await expect(installVaultCli(tmpdir(), deps({ platform: "freebsd" }))).rejects.toThrow(/package manager/);
    served = {};
    await expect(installVaultCli(mkdtempSync(join(tmpdir(), "mcp-hub-tools-")), deps())).rejects.toThrow(/Couldn't download/);
  });
});

const vault = (options: Record<string, string> = {}): SourceConfig => ({ id: "vault", type: "vault", name: "Vault", enabled: true, options });

describe("Vault setup status", () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-hub-vhome-"));
  const saved = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = home;
  });
  afterAll(() => {
    process.env.HOME = saved;
  });

  it("only complains when there is no usable token, and says what to do", async () => {
    const [noAddr] = await detectSetup([vault()], {});
    expect(noAddr).toMatchObject({ ready: false, detail: "No Vault address is set" });

    const [manual] = await detectSetup([vault({ address: "https://v", tokenSource: "manual" })], {}, { hasSecret: () => true });
    expect(manual!.ready).toBe(true);
    const [noManual] = await detectSetup([vault({ address: "https://v", tokenSource: "manual" })], {});
    expect(noManual).toMatchObject({ ready: false, detail: "Vault needs a token" });

    expect((await detectSetup([vault({ address: "https://v" })], { VAULT_TOKEN: "t" }))[0]!.ready).toBe(true);
    expect((await detectSetup([vault({ address: "https://v" })], {}))[0]).toMatchObject({ ready: false, detail: "VAULT_TOKEN isn't set" });
    // Address can come from the environment.
    expect((await detectSetup([vault({ tokenSource: "env" })], { VAULT_ADDR: "https://v", VAULT_TOKEN: "t" }))[0]!.ready).toBe(true);
  });

  it("offers to install the CLI, or to sign in when it is there", async () => {
    const src = vault({ address: "https://vault.example.com", tokenSource: "file" });
    const [missing] = await detectSetup([{ ...src, options: { ...src.options, vaultPath: join(tmpdir(), "no-such-vault") } }], { PATH: "" });
    expect(missing).toMatchObject({ ready: false, canInstall: true });
    expect(missing!.help!.steps.join(" ")).toContain("vault login -address=https://vault.example.com -method=oidc");

    const [present] = await detectSetup([{ ...src, options: { ...src.options, vaultPath: FAKE_VAULT, loginMethod: "okta" } }], {});
    expect(present).toMatchObject({ ready: false, canSignIn: true, signInMethod: "okta" });
    expect(present!.help!.commands[0]).toBe("vault login -address=https://vault.example.com -method=okta");

    writeFileSync(join(home, ".vault-token"), "s.abc");
    expect((await detectSetup([src], {}))[0]).toMatchObject({ ready: true });
  });
});

describe("Vault in the app", () => {
  it("adds a Vault source automatically only for people who have VAULT_ADDR", async () => {
    const withAddr = await startHub({ VAULT_ADDR: "https://vault.example.com" });
    try {
      const s = (await withAddr.api("GET", "/api/state")).body.sources.find((x: { type: string }) => x.type === "vault");
      expect(s).toMatchObject({ enabled: true, options: { tokenSource: "file" } });
      expect(s.options.address).toBeUndefined();
    } finally {
      await withAddr.stop();
    }
    const saved = process.env.VAULT_ADDR;
    delete process.env.VAULT_ADDR;
    const without = await startHub();
    try {
      expect((await without.api("GET", "/api/state")).body.sources.some((x: { type: string }) => x.type === "vault")).toBe(false);
    } finally {
      if (saved) process.env.VAULT_ADDR = saved;
      await without.stop();
    }
  });

  it("signs in with the CLI, installs the CLI on request, and rejects bad input", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-vhome-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    let installs = 0;
    const t = await startHub({}, { installVaultCli: async () => { installs++; return { path: FAKE_VAULT, version: "1.18.3" }; } });
    try {
      const created = await t.api("POST", "/api/sources", { type: "vault", name: "Vault", options: { address: "https://vault.example.com", tokenSource: "file", mount: "secret", kvVersion: "2" } });
      expect(created.status).toBe(201);
      const id = created.body.id;

      // CLI missing: the app can install it, and then sign in.
      await t.api("PUT", `/api/sources/${id}`, { options: { address: "https://vault.example.com", tokenSource: "file", vaultPath: join(tmpdir(), "missing-vault") } });
      let st = (await t.api("GET", "/api/credentials/setup")).body.statuses.find((s: { sourceId: string }) => s.sourceId === id);
      expect(st).toMatchObject({ ready: false, canInstall: true });
      expect((await t.api("POST", `/api/credentials/setup/${id}/install`)).status).toBe(200);
      expect(installs).toBe(1);

      st = (await t.api("GET", "/api/credentials/setup")).body.statuses.find((s: { sourceId: string }) => s.sourceId === id);
      expect(st).toMatchObject({ ready: false, canSignIn: true });
      const res = await t.api("POST", `/api/credentials/setup/${id}/sign-in`);
      expect(res.status).toBe(200);
      expect(readFileSync(join(home, "vault-args.txt"), "utf-8").trim()).toBe("login -no-print -address=https://vault.example.com -method=oidc");
      st = (await t.api("GET", "/api/credentials/setup")).body.statuses.find((s: { sourceId: string }) => s.sourceId === id);
      expect(st).toMatchObject({ ready: true });

      // Bad requests.
      await t.api("PUT", `/api/sources/${id}`, { options: { address: "https://vault.example.com", tokenSource: "file", vaultPath: FAKE_VAULT, loginMethod: "oidc; rm -rf /" } });
      expect((await t.api("POST", `/api/credentials/setup/${id}/sign-in`)).status).toBe(400);
      expect((await t.api("POST", "/api/credentials/setup/env/install")).status).toBe(404);
      expect((await t.api("POST", "/api/credentials/setup/env/sign-in")).status).toBe(404);
    } finally {
      process.env.HOME = saved;
      await t.stop();
    }
  });
});
