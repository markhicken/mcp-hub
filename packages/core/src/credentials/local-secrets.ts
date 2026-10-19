import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecretBox, SecretBoxError } from "./box.js";
import { CredentialError } from "./types.js";

interface SecretsFile {
  version: 1;
  algorithm: string;
  secrets: Record<string, string>;
}

/**
 * Secrets the user types into MCP Hub (`{{secret://name}}`). Each value is kept encrypted, in memory and on disk,
 * and is decrypted only at the moment something asks for it. The file is written only when the box's key
 * lives in an OS key store; otherwise the secrets stay in memory and are forgotten on quit.
 */
export class LocalSecrets {
  private readonly map = new Map<string, string>();

  constructor(
    private readonly box: SecretBox,
    private readonly file?: string,
  ) {
    if (this.persisting) this.load();
  }

  private get persisting(): boolean {
    return !!this.file && this.box.persistent;
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<SecretsFile>;
      for (const [name, sealed] of Object.entries(parsed.secrets ?? {})) if (typeof sealed === "string" && this.box.isSealed(sealed)) this.map.set(name, sealed);
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // nothing more to do: start without them
      }
    }
  }

  private save(): void {
    if (!this.persisting || !this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body: SecretsFile = { version: 1, algorithm: this.box.algorithm, secrets: Object.fromEntries(this.map) };
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  set(name: string, value: string): void {
    this.map.set(name, this.box.seal(value, `secret:${name}`));
    this.save();
  }

  /** Decrypts on demand. Throws a CredentialError if the stored value can't be opened. */
  get(name: string): string | undefined {
    const sealed = this.map.get(name);
    if (sealed === undefined) return undefined;
    try {
      return this.box.open(sealed, `secret:${name}`);
    } catch (err) {
      if (err instanceof SecretBoxError) throw new CredentialError(`Secret "${name}" can't be decrypted: ${err.message}`, "unavailable");
      throw err;
    }
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  delete(name: string): boolean {
    const had = this.map.delete(name);
    if (had) this.save();
    return had;
  }

  names(): string[] {
    return [...this.map.keys()].sort();
  }

  /** Saved secrets as they are on disk (ciphertext), whether or not this run can read them. */
  private onDisk(): Array<[string, string]> {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<SecretsFile>;
      return Object.entries(parsed.secrets ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && this.box.isSealed(e[1]));
    } catch {
      return [];
    }
  }

  /** How many saved secrets there are on disk. */
  savedCount(): number {
    return this.onDisk().length;
  }

  /** Does this key open at least one saved secret? Used to check a recovery key before adopting it. */
  canOpenAny(candidate: SecretBox): boolean {
    return this.onDisk().some(([name, sealed]) => candidate.canOpen(sealed, `secret:${name}`));
  }

  /** Delete every local secret, including the saved file (start over). */
  wipe(): number {
    const n = Math.max(this.map.size, this.onDisk().length);
    this.map.clear();
    if (this.file) rmSync(this.file, { force: true });
    return n;
  }

  /** Read saved secrets again, after the key changed. */
  reload(): void {
    this.map.clear();
    if (this.persisting) this.load();
  }

  /** Forget the in-memory copies. Saved secrets are read back from the file the next time they're needed. */
  lock(): void {
    this.reload();
  }
}
