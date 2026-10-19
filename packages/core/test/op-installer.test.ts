import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PINNED_OP_VERSION, assetFor, installOnePasswordCli, latestVersion } from "../src/credentials/op-installer.js";
import { startHub } from "./helpers.js";

/** A zip holding a stand-in `op` that reports `version`, like 1Password's release zips. */
function fakeZip(version: string, reportedVersion = version): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-fakeop-"));
  writeFileSync(join(dir, "op"), `#!/bin/sh\necho ${reportedVersion}\n`);
  chmodSync(join(dir, "op"), 0o755);
  execFileSync("zip", ["-q", "op.zip", "op"], { cwd: dir });
  return readFileSync(join(dir, "op.zip"));
}

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

const deps = (extra = {}) => ({ downloadsUrl: `${base}/dl`, releasesUrl: `${base}/releases`, platform: "darwin" as const, arch: "arm64", verify: async () => {}, ...extra });

describe("1Password CLI installer", () => {
  it("names the right download for each system, and declines where it can't install", () => {
    expect(assetFor("2.41.0", "darwin", "arm64")).toBe("op_darwin_arm64_v2.41.0.zip");
    expect(assetFor("2.41.0", "darwin", "x64")).toBe("op_darwin_amd64_v2.41.0.zip");
    expect(assetFor("2.41.0", "win32", "x64")).toBe("op_windows_amd64_v2.41.0.zip");
    expect(assetFor("2.41.0", "linux", "x64")).toBeNull();
    expect(assetFor("2.41.0", "darwin", "ia32")).toBeNull();
  });

  it("picks the newest stable release from the release notes and ignores betas", async () => {
    served["/releases"] = "<h3>2.42.0-beta.01</h3> <h3>2.41.0 (build 1)</h3> <h3>2.40.0</h3> Go 1.26.8";
    expect(await latestVersion(fetch, `${base}/releases`)).toBe("2.41.0");
    expect(await latestVersion(fetch, `${base}/missing`)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("downloads, checks and installs the newest version into the tools folder", async () => {
    served = { "/releases": "2.99.0 (build 1)", "/dl/v2.99.0/op_darwin_arm64_v2.99.0.zip": fakeZip("2.99.0") };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    const r = await installOnePasswordCli(tools, deps());
    expect(r.version).toBe("2.99.0");
    expect(r.path).toBe(join(tools, "2.99.0", "op"));
    expect(statSync(r.path).mode & 0o111).toBeGreaterThan(0);
    expect(execFileSync(r.path, ["--version"]).toString().trim()).toBe("2.99.0");
  });

  it.skipIf(process.platform === "win32")("falls back to the pinned version if the newest can't be downloaded", async () => {
    served = { "/releases": "2.99.0 (build 1)", [`/dl/v${PINNED_OP_VERSION}/op_darwin_arm64_v${PINNED_OP_VERSION}.zip`]: fakeZip(PINNED_OP_VERSION) };
    const r = await installOnePasswordCli(mkdtempSync(join(tmpdir(), "mcp-hub-tools-")), deps());
    expect(r.version).toBe(PINNED_OP_VERSION);
  });

  it.skipIf(process.platform === "win32")("installs nothing if the signature check fails", async () => {
    served = { "/releases": "2.99.0", "/dl/v2.99.0/op_darwin_arm64_v2.99.0.zip": fakeZip("2.99.0") };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    await expect(installOnePasswordCli(tools, deps({ verify: async () => { throw new Error("The download isn't signed by 1Password."); } }))).rejects.toThrow(/isn't signed/);
    expect(existsSync(join(tools, "2.99.0"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("installs nothing if the binary reports another version", async () => {
    served = { "/releases": "2.99.0", "/dl/v2.99.0/op_darwin_arm64_v2.99.0.zip": fakeZip("2.99.0", "1.0.0") };
    const tools = mkdtempSync(join(tmpdir(), "mcp-hub-tools-"));
    await expect(installOnePasswordCli(tools, deps())).rejects.toThrow(/reports version 1\.0\.0/);
    expect(existsSync(join(tools, "2.99.0"))).toBe(false);
  });

  it("explains itself on systems it can't install on, and when the download fails", async () => {
    await expect(installOnePasswordCli(tmpdir(), deps({ platform: "linux" }))).rejects.toThrow(/package manager/);
    served = {};
    await expect(installOnePasswordCli(mkdtempSync(join(tmpdir(), "mcp-hub-tools-")), deps())).rejects.toThrow(/Couldn't download/);
  });
});

describe("installing the CLI from the app", () => {
  it("installs, points the 1Password source at it, and shares one download between simultaneous requests", async () => {
    let calls = 0;
    const fake = join(import.meta.dirname, "fixtures", "fake-op.mjs");
    chmodSync(fake, 0o755);
    const t = await startHub({}, {
      installOnePasswordCli: async (dir) => {
        calls++;
        expect(dir.endsWith(join("tools", "op"))).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
        return { path: fake, version: "2.30.0" };
      },
    });
    try {
      const [a, b] = await Promise.all([t.api("POST", "/api/credentials/setup/1password/install"), t.api("POST", "/api/credentials/setup/1password/install")]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(calls).toBe(1);
      const src = (await t.api("GET", "/api/state")).body.sources.find((s: { type: string }) => s.type === "1password");
      expect(src.options.opPath).toBe(fake);
      const status = (await t.api("GET", "/api/credentials/setup")).body.statuses.find((s: { type: string }) => s.type === "1password");
      expect(status).toMatchObject({ ready: true, version: "2.30.0" });
    } finally {
      await t.stop();
    }
  });

  it("reports a failed install as an error and changes nothing", async () => {
    const t = await startHub({}, { installOnePasswordCli: async () => { throw new Error("Couldn't download the 1Password CLI"); } });
    try {
      const res = await t.api("POST", "/api/credentials/setup/1password/install");
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Couldn't download/);
      const src = (await t.api("GET", "/api/state")).body.sources.find((s: { type: string }) => s.type === "1password");
      expect(src.options.opPath).toBeUndefined();
    } finally {
      await t.stop();
    }
  });
});
