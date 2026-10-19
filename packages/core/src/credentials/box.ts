import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SEAL_PREFIX = "enc:v1:";

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface EncryptionInfo {
  algorithm: string;
  /** Where the key lives, e.g. "macOS Keychain", or "memory only" when no OS key store could be used. */
  keyStore: string;
  /** True when sealed data may be written to disk (the key survives a restart). */
  persistent: boolean;
  /** Why encryption at rest is off, when it is. */
  problem?: string;
}

/**
 * Authenticated encryption (AES-256-GCM) for secrets held in memory or saved to disk.
 * A sealed value is `enc:v1:` + base64(iv ‖ auth tag ‖ ciphertext), with a fresh random IV every time. Optional
 * associated data ties a ciphertext to where it belongs, so it can't be moved to another name and still open.
 */
export class SecretBox {
  readonly algorithm = "AES-256-GCM";
  private key: Buffer;
  persistent: boolean;
  keyStore: string;
  problem?: string;

  constructor(key: Buffer, persistent: boolean, keyStore: string, problem?: string) {
    if (key.length !== 32) throw new SecretBoxError("The encryption key must be 32 bytes");
    this.key = key;
    this.persistent = persistent;
    this.keyStore = keyStore;
    this.problem = problem;
  }

  /** A box with a random key that exists only in this process: fine for memory, useless across restarts. */
  static ephemeral(problem?: string): SecretBox {
    return new SecretBox(randomBytes(32), false, "memory only", problem);
  }

  /** Switch to another key in place (recovery), so everything already holding this box follows. */
  adopt(key: Buffer, meta: { persistent: boolean; keyStore: string; problem?: string }): void {
    if (key.length !== 32) throw new SecretBoxError("The encryption key must be 32 bytes");
    this.key = key;
    this.persistent = meta.persistent;
    this.keyStore = meta.keyStore;
    this.problem = meta.problem;
  }

  /** The key as base64, for the user's recovery copy. Only ever handed out on an explicit request. */
  exportKey(): string {
    return this.key.toString("base64");
  }

  /** Could this box open the value? (No effect on anything.) */
  canOpen(value: string, aad = ""): boolean {
    try {
      this.open(value, aad);
      return true;
    } catch {
      return false;
    }
  }

  info(): EncryptionInfo {
    return { algorithm: this.algorithm, keyStore: this.keyStore, persistent: this.persistent, ...(this.problem ? { problem: this.problem } : {}) };
  }

  isSealed(value: string): boolean {
    return value.startsWith(SEAL_PREFIX);
  }

  seal(plain: string, aad = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }

  /** Decrypts a sealed value. A value that isn't sealed is returned as is. Throws if it was tampered with or the key is wrong. */
  open(value: string, aad = ""): string {
    if (!this.isSealed(value)) return value;
    try {
      const raw = Buffer.from(value.slice(SEAL_PREFIX.length), "base64");
      if (raw.length < 12 + 16) throw new Error("too short");
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretBoxError("Couldn't decrypt a stored secret. The encryption key doesn't match the one it was saved with.");
    }
  }
}
