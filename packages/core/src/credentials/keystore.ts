import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { explainPowerShellFailure, powerShellArgs } from "../powershell.js";
import { SecretBox } from "./box.js";
import { DPAPI_PROTECT_SCRIPT, DPAPI_UNPROTECT_SCRIPT, NOT_FOUND, READ_SECRET_SCRIPT, WRITE_SECRET_SCRIPT } from "./wincred.js";

const SERVICE = "MCP Hub";
const ACCOUNT = "master-key";

/** Somewhere outside MCP Hub's own files that can keep the 32-byte master key. */
export interface KeyStore {
  readonly name: string;
  /** The key, or null when none has been saved yet. Throws when the store itself can't be used. */
  read(): Buffer | null;
  write(key: Buffer): void;
}

export class KeyStoreError extends Error {}

function decode(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new KeyStoreError("The saved key is not 32 bytes");
  return key;
}

const run = (file: string, args: string[], input?: string): string =>
  execFileSync(file, args, { encoding: "utf8", timeout: 15_000, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  return (e.stderr || e.message || "failed").toString().trim().slice(0, 200);
}

/** macOS login keychain, through the system `security` tool. */
function macKeychain(): KeyStore {
  return {
    name: "macOS Keychain",
    read() {
      try {
        return decode(run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]));
      } catch (err) {
        if ((err as { status?: number }).status === 44 || /could not be found/i.test(describe(err))) return null;
        throw new KeyStoreError(describe(err));
      }
    },
    write(key) {
      try {
        run("security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-l", "MCP Hub master key", "-w", key.toString("base64"), "-U"]);
      } catch (err) {
        throw new KeyStoreError(describe(err));
      }
    },
  };
}

/** Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool`; the key goes in on stdin, never on a command line. */
function linuxSecretService(): KeyStore {
  return {
    name: "Linux Secret Service",
    read() {
      try {
        const out = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
        return out.trim() ? decode(out) : null;
      } catch (err) {
        if ((err as { status?: number }).status === 1 && !describe(err)) return null;
        throw new KeyStoreError((err as NodeJS.ErrnoException).code === "ENOENT" ? "secret-tool isn't installed" : describe(err));
      }
    },
    write(key) {
      try {
        run("secret-tool", ["store", "--label", "MCP Hub master key", "service", SERVICE, "account", ACCOUNT], key.toString("base64"));
      } catch (err) {
        throw new KeyStoreError((err as NodeJS.ErrnoException).code === "ENOENT" ? "secret-tool isn't installed" : describe(err));
      }
    },
  };
}

function unsupported(): KeyStore {
  const fail = (): never => {
    throw new KeyStoreError("There is no supported OS key store on this system yet");
  };
  return { name: "OS key store", read: fail, write: fail };
}

const WIN_TARGET = "MCP Hub master key";

/** Runs a PowerShell script synchronously; the key travels on stdin. Failures become KeyStoreErrors with the reason. */
function powerShellSync(script: string, input?: string, env?: Record<string, string>): string {
  try {
    return execFileSync("powershell.exe", powerShellArgs(script), {
      encoding: "utf8",
      timeout: 30_000,
      input: input ?? "",
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: string };
    if (e.status === NOT_FOUND) throw Object.assign(new KeyStoreError("not found"), { notFound: true });
    throw new KeyStoreError(e.code === "ENOENT" ? "PowerShell isn't available" : explainPowerShellFailure(String(e.stderr || e.message)));
  }
}

const isNotFound = (err: unknown): boolean => (err as { notFound?: boolean }).notFound === true;

/** Windows Credential Manager (a generic credential kept for this user on this machine). */
export function windowsCredentialManager(run: typeof powerShellSync = powerShellSync): KeyStore {
  const env = { HUB_TARGET: WIN_TARGET, HUB_USER: ACCOUNT };
  return {
    name: "Windows Credential Manager",
    read() {
      try {
        return decode(run(READ_SECRET_SCRIPT, undefined, env));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    write(key) {
      run(WRITE_SECRET_SCRIPT, key.toString("base64"), env);
    },
  };
}

/** A file in the data directory sealed with DPAPI: only this Windows user can open it, and it needs no Credential Manager. */
export function windowsDpapi(dir: string, run: typeof powerShellSync = powerShellSync): KeyStore {
  const file = join(dir, "master-key.dpapi");
  return {
    name: "Windows DPAPI",
    read() {
      if (!existsSync(file)) return null;
      return decode(run(DPAPI_UNPROTECT_SCRIPT, readFileSync(file, "utf8")));
    },
    write(key) {
      mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(file, run(DPAPI_PROTECT_SCRIPT, key.toString("base64")).trim(), { mode: 0o600 });
    },
  };
}

/**
 * Windows: Credential Manager, with a DPAPI file as the fallback where it can't be used (a locked-down PowerShell, a
 * profile without a credential vault). The key is read from whichever holds it; it is written to the first that works.
 */
export function windowsKeyStore(dir?: string, stores: { credman?: KeyStore; dpapi?: KeyStore } = {}): KeyStore {
  const credman = stores.credman ?? windowsCredentialManager();
  const dpapi = stores.dpapi ?? (dir ? windowsDpapi(dir) : undefined);
  let current: KeyStore = credman;
  return {
    get name() {
      return current.name;
    },
    read() {
      let failure: unknown;
      try {
        const key = credman.read();
        if (key) {
          current = credman;
          return key;
        }
      } catch (err) {
        failure = err;
      }
      if (dpapi) {
        try {
          const key = dpapi.read();
          if (key) {
            current = dpapi;
            return key;
          }
        } catch (err) {
          failure ??= err;
        }
      }
      // Nothing saved anywhere that could be reached: that is only "no key yet" if every store answered.
      if (failure && !dpapi) throw failure;
      return null;
    },
    write(key) {
      try {
        credman.write(key);
        current = credman;
      } catch (err) {
        if (!dpapi) throw err;
        dpapi.write(key);
        current = dpapi;
      }
    },
  };
}

/** The key store for this operating system. `dir` is MCP Hub's data directory (Windows keeps its DPAPI fallback file there). */
export function osKeyStore(dir?: string): KeyStore {
  if (process.platform === "darwin") return macKeychain();
  if (process.platform === "linux") return linuxSecretService();
  if (process.platform === "win32") return windowsKeyStore(dir);
  return unsupported();
}

/** A key store that keeps the key in this process. For tests, where the real keychain must not be touched. */
export function memoryKeyStore(key: Buffer = randomBytes(32)): KeyStore {
  let saved: Buffer | null = key;
  return { name: "Test key store", read: () => saved, write: (k) => void (saved = k) };
}

/**
 * Opens the master key from the key store, creating and saving one on the very first run.
 * Never invents a new key when saved data already exists (that would lock the user out of it), and never throws:
 * when the key can't be had it falls back to a memory-only box and says why, so the app still works.
 */
export function loadSecretBox(store: KeyStore, opts: { allowCreate: boolean }): SecretBox {
  try {
    const existing = store.read();
    if (existing) return new SecretBox(existing, true, store.name);
    if (!opts.allowCreate) {
      return SecretBox.ephemeral(`The encryption key is missing from ${store.name}, so stored secrets can't be decrypted. Restore the "${SERVICE}" key there, or re-enter the secrets.`);
    }
    const key = randomBytes(32);
    store.write(key);
    const back = store.read();
    if (!back || !back.equals(key)) throw new KeyStoreError("The key could not be read back after saving it");
    return new SecretBox(key, true, store.name);
  } catch (err) {
    return SecretBox.ephemeral(`${store.name} can't be used (${(err as Error).message}), so secrets are not saved to disk.`);
  }
}
