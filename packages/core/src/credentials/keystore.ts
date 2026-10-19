import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { SecretBox } from "./box.js";

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

/** The key store for this operating system. */
export function osKeyStore(): KeyStore {
  if (process.platform === "darwin") return macKeychain();
  if (process.platform === "linux") return linuxSecretService();
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
