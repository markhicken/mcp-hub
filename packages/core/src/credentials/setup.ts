import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceConfig, SourceType } from "../types.js";
import { ExecError, run } from "./exec.js";
import { PINNED_OP_VERSION, assetFor } from "./op-installer.js";
import { PINNED_VAULT_VERSION, vaultAsset } from "./vault-installer.js";

export interface SetupHelp {
  title: string;
  steps: string[];
  commands: string[];
  links: Array<{ label: string; url: string }>;
}

export interface SetupStatus {
  sourceId: string;
  type: SourceType;
  /** The tool is installed and MCP Hub can run it. */
  ready: boolean;
  detail: string;
  version?: string;
  /** Where the tool was found when it isn't on the PATH the hub sees. */
  path?: string;
  /** Shown when the tool is missing. */
  help?: SetupHelp;
  /** MCP Hub can download and install the tool itself (the 1Password and Vault CLIs). */
  canInstall?: boolean;
  /** The Vault CLI is present and a Sign in button can run `vault login`. */
  canSignIn?: boolean;
  signInMethod?: string;
}

const OP_URL = "https://developer.1password.com/docs/cli/get-started/#install";

/** Where `op` usually lives when it isn't on the PATH a GUI app inherits. */
function opCandidates(): string[] {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    return [join(pf, "1Password CLI", "op.exe"), join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "op.exe")];
  }
  return ["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op", join(homedir(), ".local", "bin", "op"), "/snap/bin/op"];
}

function opHelp(): SetupHelp {
  const commands =
    process.platform === "darwin" ? ["brew install --cask 1password-cli"] : process.platform === "win32" ? ["winget install --id AgileBits.1Password.CLI"] : [];
  return {
    title: "Install the 1Password CLI",
    steps: [
      commands.length ? "Install the 1Password CLI with the command below, or download it from 1Password." : "Download and install the 1Password CLI for your system.",
      "In the 1Password app, open Settings → Developer and turn on “Integrate with 1Password CLI”. MCP Hub then uses your app's unlock instead of asking for a password.",
      "Come back here and press Check again.",
    ],
    commands,
    links: [{ label: "1Password CLI install guide", url: OP_URL }],
  };
}

/** Looks for the 1Password CLI without asking it for anything, so no prompt appears. */
async function detectOnePassword(source: SourceConfig, env: NodeJS.ProcessEnv): Promise<SetupStatus> {
  const base = { sourceId: source.id, type: source.type };
  const configured = source.options.opPath || "op";
  const version = async (exe: string) => (await run(exe, ["--version"], { timeoutMs: 10_000, env })).stdout.trim();
  try {
    const v = await version(configured);
    return { ...base, ready: true, version: v, detail: `1Password CLI ${v} found` };
  } catch (err) {
    if (!(err instanceof ExecError) || err.code !== "ENOENT") {
      return { ...base, ready: true, detail: "1Password CLI found" };
    }
  }
  // Not on the PATH: try the usual install locations, and remember the one that works.
  if (!source.options.opPath) {
    for (const candidate of opCandidates()) {
      if (!existsSync(candidate)) continue;
      try {
        const v = await version(candidate);
        return { ...base, ready: true, version: v, path: candidate, detail: `1Password CLI ${v} found at ${candidate}` };
      } catch {
        // keep looking
      }
    }
  }
  return { ...base, ready: false, detail: "The 1Password CLI (op) isn't installed", canInstall: assetFor(PINNED_OP_VERSION, process.platform, process.arch) !== null, help: opHelp() };
}

async function detectKeychain(source: SourceConfig, env: NodeJS.ProcessEnv): Promise<SetupStatus> {
  const base = { sourceId: source.id, type: source.type };
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/security")
      ? { ...base, ready: true, detail: "macOS Keychain is built in" }
      : { ...base, ready: false, detail: "The macOS `security` tool wasn't found", help: { title: "Keychain tool missing", steps: ["MCP Hub uses /usr/bin/security, which ships with macOS. Reinstall the Xcode command line tools: xcode-select --install"], commands: ["xcode-select --install"], links: [] } };
  }
  if (process.platform === "win32") {
    try {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "1"], { timeoutMs: 15_000, env });
      return { ...base, ready: true, detail: "Windows Credential Manager is available" };
    } catch {
      return { ...base, ready: false, detail: "PowerShell wasn't found", help: { title: "PowerShell is needed", steps: ["MCP Hub reads Credential Manager through Windows PowerShell. Make sure powershell.exe is on your PATH."], commands: [], links: [] } };
    }
  }
  try {
    await run("secret-tool", ["--version"], { timeoutMs: 10_000, env });
    return { ...base, ready: true, detail: "libsecret (secret-tool) found" };
  } catch (err) {
    if (err instanceof ExecError && err.code !== "ENOENT") return { ...base, ready: true, detail: "libsecret (secret-tool) found" };
    return {
      ...base,
      ready: false,
      detail: "libsecret's secret-tool isn't installed",
      help: {
        title: "Install libsecret",
        steps: ["Install the secret-tool command with your package manager, then make sure a keyring (GNOME Keyring or KWallet) is running.", "Come back here and press Check again."],
        commands: ["sudo apt install libsecret-tools", "sudo dnf install libsecret", "sudo pacman -S libsecret"],
        links: [],
      },
    };
  }
}

/** Checks the sources that depend on a tool or sign-in being in place. Never reads a secret and never triggers an approval prompt. */
export async function detectSetup(sources: SourceConfig[], env: NodeJS.ProcessEnv, opts: { hasSecret?: (name: string) => boolean } = {}): Promise<SetupStatus[]> {
  const out: SetupStatus[] = [];
  for (const s of sources) {
    if (s.type === "1password") out.push(await detectOnePassword(s, env));
    else if (s.type === "keychain") out.push(await detectKeychain(s, env));
    else if (s.type === "vault") out.push(await detectVault(s, env, opts.hasSecret ?? (() => false)));
  }
  return out;
}

const VAULT_URL = "https://developer.hashicorp.com/vault/install";

function vaultCandidates(): string[] {
  if (process.platform === "win32") return ["C:\\HashiCorp\\Vault\\vault.exe", join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "vault.exe")];
  return ["/opt/homebrew/bin/vault", "/usr/local/bin/vault", "/usr/bin/vault", join(homedir(), ".local", "bin", "vault")];
}

function vaultInstallHelp(address: string, method: string): SetupHelp {
  const commands = process.platform === "darwin" ? ["brew tap hashicorp/tap", "brew install hashicorp/tap/vault"] : process.platform === "win32" ? ["winget install HashiCorp.Vault"] : [];
  return {
    title: "Install the Vault CLI",
    steps: [
      commands.length ? "Install the Vault CLI with the commands below, or download it from HashiCorp." : "Download and install the Vault CLI for your system.",
      `Sign in with: vault login -address=${address} -method=${method}`,
      "Come back here and press Check again.",
    ],
    commands,
    links: [{ label: "Vault install guide", url: VAULT_URL }],
  };
}

/**
 * Vault is read through its HTTP API with a token. The CLI is only needed to get that token (`vault login`),
 * so this only reports a problem when there is no usable token, and says which step is missing.
 */
async function detectVault(source: SourceConfig, env: NodeJS.ProcessEnv, hasSecret: (name: string) => boolean): Promise<SetupStatus> {
  const base = { sourceId: source.id, type: source.type };
  const address = (source.options.address || env.VAULT_ADDR || "").replace(/\/+$/, "");
  if (!address) {
    return { ...base, ready: false, detail: "No Vault address is set", help: { title: "Set the Vault address", steps: ["Open this source below and enter your Vault address, or set VAULT_ADDR in your shell profile."], commands: [], links: [] } };
  }
  const tokenSource = source.options.tokenSource || "env";
  const fileToken = join(homedir(), ".vault-token");
  const hasToken =
    tokenSource === "manual" ? hasSecret(`vault-token/${source.id}`) : tokenSource === "file" ? existsSync(fileToken) && statSync(fileToken).size > 0 : !!env.VAULT_TOKEN;
  if (hasToken) return { ...base, ready: true, detail: "A Vault token is available" };

  if (tokenSource === "manual") {
    return { ...base, ready: false, detail: "Vault needs a token", help: { title: "Add your Vault token", steps: ["Type your Vault token into the source below. It is stored encrypted."], commands: [], links: [] } };
  }
  if (tokenSource === "env") {
    return { ...base, ready: false, detail: "VAULT_TOKEN isn't set", help: { title: "Provide a Vault token", steps: ["Set VAULT_TOKEN in your shell profile, or change this source to read ~/.vault-token and sign in with the Vault CLI."], commands: [], links: [] } };
  }

  // Token comes from `vault login`: that needs the CLI.
  const method = source.options.loginMethod || "oidc";
  const version = async (exe: string) => /Vault v(\d+\.\d+\.\d+)/.exec((await run(exe, ["version"], { timeoutMs: 10_000, env })).stdout)?.[1] ?? "";
  let found: { path?: string; version: string } | null = null;
  const configured = source.options.vaultPath || "vault";
  try {
    found = { version: await version(configured), path: source.options.vaultPath || undefined };
  } catch (err) {
    if (!(err instanceof ExecError) || err.code !== "ENOENT") found = { version: "" };
  }
  if (!found && !source.options.vaultPath) {
    for (const candidate of vaultCandidates()) {
      if (!existsSync(candidate)) continue;
      try {
        found = { version: await version(candidate), path: candidate };
        break;
      } catch {
        // keep looking
      }
    }
  }
  if (!found) {
    return { ...base, ready: false, detail: "Sign in to Vault: the Vault CLI isn't installed", canInstall: vaultAsset(PINNED_VAULT_VERSION, process.platform, process.arch) !== null, help: vaultInstallHelp(address, method) };
  }
  return {
    ...base,
    ready: false,
    detail: `Sign in to Vault${found.version ? ` (CLI ${found.version} found)` : ""}`,
    ...(found.path ? { path: found.path } : {}),
    canSignIn: true,
    signInMethod: method,
    help: { title: "Sign in to Vault", steps: [`Press Sign in, or run this in a terminal.`], commands: [`vault login -address=${address} -method=${method}`], links: [] },
  };
}
