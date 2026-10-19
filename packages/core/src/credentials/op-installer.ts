import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ExecError, run } from "./exec.js";

/** A release known to exist, used if the newest one can't be found or downloaded. */
export const PINNED_OP_VERSION = "2.41.0";
const DOWNLOADS = "https://cache.agilebits.com/dist/1P/op2/pkg";
const RELEASES = "https://app-updates.agilebits.com/product_history/CLI2";
const TRUSTED_HOSTS = ["cache.agilebits.com", "app-updates.agilebits.com"];
const MAX_BYTES = 150 * 1024 * 1024;

export interface InstallDeps {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaces the download and release-page addresses (tests only; disables the host check). */
  downloadsUrl?: string;
  releasesUrl?: string;
  /** Replaces the signature check (tests only). */
  verify?: (file: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface InstalledCli {
  path: string;
  version: string;
}

/** Where 1Password publishes the zip for this system, or null if MCP Hub can't install it there itself. */
export function assetFor(version: string, platform: NodeJS.Platform, arch: string): string | null {
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!a) return null;
  if (platform === "darwin") return `op_darwin_${a}_v${version}.zip`;
  if (platform === "win32") return `op_windows_${a}_v${version}.zip`;
  return null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The newest stable release listed on 1Password's release notes page (betas are skipped). */
export async function latestVersion(f: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const found = [...(await res.text()).matchAll(/\b(2\.\d+\.\d+)(?![\d.-])/g)].map((m) => m[1]!);
    return found.sort(compareVersions).at(-1) ?? null;
  } catch {
    return null;
  }
}

/** The binary must carry 1Password's own code-signing identity. */
async function verifyVendorSignature(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  if (platform === "darwin") {
    await run("codesign", ["--verify", "--strict", file], { timeoutMs: 30_000, env });
    const info = await run("codesign", ["-dv", "--verbose=4", file], { timeoutMs: 30_000, env });
    if (!/Authority=.*AgileBits/i.test(info.stderr + info.stdout)) throw new Error("The download isn't signed by 1Password.");
    return;
  }
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:HUB_FILE; if ($s.Status -ne 'Valid') { exit 3 }; [Console]::Out.Write($s.SignerCertificate.Subject)";
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 60_000, env: { ...env, HUB_FILE: file } });
  if (!/AgileBits/i.test(out.stdout)) throw new Error("The download isn't signed by 1Password.");
}

export async function download(f: typeof fetch, url: string, dest: string, trusted: boolean, hosts: string[] = TRUSTED_HOSTS, maxBytes = MAX_BYTES): Promise<void> {
  const res = await f(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (trusted && !hosts.includes(new URL(res.url || url).hostname)) throw new Error("The download was redirected somewhere unexpected.");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error("The download is larger than expected.");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest, { mode: 0o600 }));
  if (statSync(dest).size > maxBytes) throw new Error("The download is larger than expected.");
}

export async function extract(zip: string, into: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:HUB_ZIP -DestinationPath $env:HUB_OUT -Force"], {
      timeoutMs: 120_000,
      env: { ...env, HUB_ZIP: zip, HUB_OUT: into },
    });
  } else {
    await run("unzip", ["-o", "-q", zip, "-d", into], { timeoutMs: 120_000, env });
  }
}

/**
 * Downloads the official, code-signed 1Password CLI into MCP Hub's own folder (`toolsDir`). Nothing outside that
 * folder is touched and no administrator password is needed. The binary is used only after its signature checks out
 * as 1Password's and it reports the version that was downloaded; otherwise nothing is installed.
 */
export async function installOnePasswordCli(toolsDir: string, deps: InstallDeps = {}): Promise<InstalledCli> {
  const f = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const downloads = deps.downloadsUrl ?? DOWNLOADS;
  const trusted = !deps.downloadsUrl;
  if (!assetFor(PINNED_OP_VERSION, platform, arch)) {
    throw new Error("MCP Hub can't install the 1Password CLI by itself on this system. Use your package manager or 1Password's install guide.");
  }

  const latest = await latestVersion(f, deps.releasesUrl ?? RELEASES);
  const candidates = [...new Set([latest, PINNED_OP_VERSION].filter((v): v is string => !!v))];
  const work = mkdtempSync(join(tmpdir(), "mcp-hub-op-"));
  try {
    let version = "";
    const zip = join(work, "op.zip");
    const errors: string[] = [];
    for (const v of candidates) {
      try {
        await download(f, `${downloads}/v${v}/${assetFor(v, platform, arch)}`, zip, trusted);
        version = v;
        break;
      } catch (err) {
        errors.push(`${v}: ${(err as Error).message}`);
      }
    }
    if (!version) throw new Error(`Couldn't download the 1Password CLI (${errors.join("; ")}). Check your internet connection.`);

    const out = join(work, "out");
    mkdirSync(out);
    await extract(zip, out, platform, deps.env);
    const exe = platform === "win32" ? "op.exe" : "op";
    const found = readdirSync(out, { recursive: true, encoding: "utf8" }).find((p) => basename(p) === exe && statSync(join(out, p)).isFile());
    if (!found) throw new Error("The download didn't contain the 1Password CLI.");
    const file = join(out, found);
    if (platform !== "win32") chmodSync(file, 0o755);

    await (deps.verify ? deps.verify(file) : verifyVendorSignature(file, platform, deps.env));
    const reported = (await run(file, ["--version"], { timeoutMs: 20_000, env: deps.env })).stdout.trim();
    if (reported !== version) throw new Error(`The download reports version ${reported || "unknown"}, not ${version}.`);

    const dir = join(toolsDir, version);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, exe);
    rmSync(dest, { force: true });
    copyFileSync(file, dest);
    if (platform !== "win32") chmodSync(dest, 0o755);
    if (!existsSync(dest)) throw new Error("Couldn't save the 1Password CLI.");
    return { path: dest, version };
  } catch (err) {
    if (err instanceof ExecError) throw new Error(err.stderr || err.message);
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
