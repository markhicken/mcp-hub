import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ExecError, run } from "./exec.js";
import { compareVersions, download, extract, type InstalledCli } from "./op-installer.js";

/** A release known to exist, used if the newest one can't be found or downloaded. */
export const PINNED_VAULT_VERSION = "1.18.3";
const RELEASES = "https://releases.hashicorp.com/vault";
const CHECKPOINT = "https://checkpoint-api.hashicorp.com/v1/check/vault";
const TRUSTED_HOSTS = ["releases.hashicorp.com", "checkpoint-api.hashicorp.com"];
/** Vault's zips are a few hundred MB (they embed the web UI). */
const MAX_ZIP_BYTES = 800 * 1024 * 1024;

export interface VaultInstallDeps {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replace the release and version-check addresses (tests only; disables the host check). */
  releasesUrl?: string;
  checkpointUrl?: string;
  env?: NodeJS.ProcessEnv;
}

/** HashiCorp's zip name for this system, or null if there isn't one. */
export function vaultAsset(version: string, platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : null;
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  return os && a ? `vault_${version}_${os}_${a}.zip` : null;
}

export async function latestVaultVersion(f: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { current_version?: string }).current_version;
    return v && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Downloads HashiCorp's official Vault CLI into MCP Hub's own folder (`toolsDir`). The zip's SHA-256 must match
 * the checksum HashiCorp publishes for that release, and the binary must report the version that was downloaded;
 * otherwise nothing is installed. No administrator password is needed and nothing outside that folder changes.
 */
export async function installVaultCli(toolsDir: string, deps: VaultInstallDeps = {}): Promise<InstalledCli> {
  const f = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const releases = deps.releasesUrl ?? RELEASES;
  const trusted = !deps.releasesUrl;
  if (!vaultAsset(PINNED_VAULT_VERSION, platform, arch)) {
    throw new Error("MCP Hub can't install the Vault CLI by itself on this system. Use your package manager or HashiCorp's install guide.");
  }

  const latest = await latestVaultVersion(f, deps.checkpointUrl ?? CHECKPOINT);
  const candidates = [...new Set([latest, PINNED_VAULT_VERSION].filter((v): v is string => !!v))].sort(compareVersions).reverse();
  const work = mkdtempSync(join(tmpdir(), "mcp-hub-vault-"));
  try {
    const zip = join(work, "vault.zip");
    const sums = join(work, "SHA256SUMS");
    let version = "";
    const errors: string[] = [];
    for (const v of candidates) {
      const asset = vaultAsset(v, platform, arch)!;
      try {
        await download(f, `${releases}/${v}/vault_${v}_SHA256SUMS`, sums, trusted, TRUSTED_HOSTS, 1024 * 1024);
        await download(f, `${releases}/${v}/${asset}`, zip, trusted, TRUSTED_HOSTS, MAX_ZIP_BYTES);
        version = v;
        break;
      } catch (err) {
        errors.push(`${v}: ${(err as Error).message}`);
      }
    }
    if (!version) throw new Error(`Couldn't download the Vault CLI (${errors.join("; ")}). Check your internet connection.`);

    // The checksum list is a plain text file of "<sha256>  <file name>" lines.
    const asset = vaultAsset(version, platform, arch)!;
    const { readFileSync } = await import("node:fs");
    const expected = readFileSync(sums, "utf-8").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
    if (!expected || (await sha256(zip)) !== expected.toLowerCase()) throw new Error("The download doesn't match HashiCorp's published checksum, so it was discarded.");

    const out = join(work, "out");
    mkdirSync(out);
    await extract(zip, out, platform, deps.env);
    const exe = platform === "win32" ? "vault.exe" : "vault";
    const found = readdirSync(out, { recursive: true, encoding: "utf8" }).find((p) => basename(p) === exe && statSync(join(out, p)).isFile());
    if (!found) throw new Error("The download didn't contain the Vault CLI.");
    const file = join(out, found);
    if (platform !== "win32") chmodSync(file, 0o755);

    const reported = (await run(file, ["version"], { timeoutMs: 20_000, env: deps.env })).stdout;
    if (!new RegExp(`\\bv${version.replace(/\./g, "\\.")}\\b`).test(reported)) throw new Error(`The download reports "${reported.trim().slice(0, 40)}", not Vault ${version}.`);

    const dir = join(toolsDir, version);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, exe);
    rmSync(dest, { force: true });
    copyFileSync(file, dest);
    if (platform !== "win32") chmodSync(dest, 0o755);
    if (!existsSync(dest)) throw new Error("Couldn't save the Vault CLI.");
    return { path: dest, version };
  } catch (err) {
    if (err instanceof ExecError) throw new Error(err.stderr || err.message);
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
