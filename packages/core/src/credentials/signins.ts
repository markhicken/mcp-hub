import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SecretBox } from "./box.js";

/** What is kept for one server so a restart doesn't need a new browser sign-in. */
export interface SavedSignIn {
  tokens: OAuthTokens;
  /** Registration details from dynamic client registration (a pre-registered client comes from the config instead). */
  client?: OAuthClientInformationMixed;
  /** The server the tokens were issued for; they are ignored if the server's address moves elsewhere. */
  origin?: string;
}

/** The non-secret facts about a saved sign-in, for showing in the app. */
export interface RememberedSignIn {
  serverId: string;
  savedAt: number;
  /** When the access token stops working. Unknown if the server didn't say. */
  accessExpiresAt?: number;
  /** A refresh token is held, so the sign-in renews itself. */
  refreshable: boolean;
}

interface Entry extends Omit<RememberedSignIn, "serverId"> {
  /** The tokens and client registration, sealed. */
  sealed: string;
}

interface SignInsFile {
  version: 1;
  algorithm: string;
  signIns: Record<string, Entry>;
}

const aadFor = (serverId: string): string => `signin:${serverId}`;

/**
 * OAuth sign-ins the user chose to remember, per server. The tokens are sealed with the SecretBox (tied to the server
 * id, so one entry can't be moved to another server) and saved only when the box's key lives in an OS key store;
 * without one nothing is kept, and the sign-in is forgotten when MCP Hub quits.
 */
export class SignInStore {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly box: SecretBox,
    private readonly file?: string,
    /** How long a saved sign-in lasts after it was last signed in or renewed; 0 = until forgotten. */
    private readonly ttlSeconds: () => number = () => 0,
  ) {
    this.reload();
  }

  private isExpired(e: Entry): boolean {
    const ttl = this.ttlSeconds();
    return ttl > 0 && e.savedAt + ttl * 1000 <= Date.now();
  }

  /** Forget the sign-ins that were kept longer than allowed. Returns how many. */
  expire(): number {
    let n = 0;
    for (const [id, e] of [...this.map]) if (this.isExpired(e) && this.map.delete(id)) n++;
    if (n) this.save();
    return n;
  }

  /** Can sign-ins be saved right now? */
  get available(): boolean {
    return !!this.file && this.box.persistent;
  }

  private read(): Record<string, Entry> {
    if (!this.file || !existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<SignInsFile>;
      const out: Record<string, Entry> = {};
      for (const [id, e] of Object.entries(parsed.signIns ?? {})) {
        if (e && typeof e.sealed === "string" && this.box.isSealed(e.sealed) && typeof e.savedAt === "number") out[id] = e;
      }
      return out;
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // nothing more to do: start without them
      }
      return {};
    }
  }

  private save(): void {
    if (!this.available || !this.file) return;
    if (this.map.size === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body: SignInsFile = { version: 1, algorithm: this.box.algorithm, signIns: Object.fromEntries(this.map) };
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** Remember a sign-in. Does nothing when there is nowhere safe to keep it. */
  set(serverId: string, value: SavedSignIn): void {
    if (!this.available) return;
    const plain = JSON.stringify(value);
    const existing = this.map.get(serverId);
    // Saving what is already saved (a settings change, say) must not restart the clock.
    if (existing) {
      try {
        if (this.box.open(existing.sealed, aadFor(serverId)) === plain) return;
      } catch {
        // can't be opened: replace it
      }
    }
    const now = Date.now();
    const expiresIn = value.tokens.expires_in;
    this.map.set(serverId, {
      sealed: this.box.seal(plain, aadFor(serverId)),
      savedAt: now,
      refreshable: !!value.tokens.refresh_token,
      ...(typeof expiresIn === "number" ? { accessExpiresAt: now + expiresIn * 1000 } : {}),
    });
    this.save();
  }

  /** The saved sign-in, or nothing if there is none, it can't be opened, or it ran out and can't renew itself. */
  get(serverId: string): SavedSignIn | undefined {
    this.expire();
    const e = this.map.get(serverId);
    if (!e) return undefined;
    if (!e.refreshable && e.accessExpiresAt !== undefined && e.accessExpiresAt < Date.now()) {
      this.delete(serverId);
      return undefined;
    }
    try {
      return JSON.parse(this.box.open(e.sealed, aadFor(serverId))) as SavedSignIn;
    } catch {
      return undefined;
    }
  }

  delete(serverId: string): boolean {
    const had = this.map.delete(serverId);
    if (had) this.save();
    return had;
  }

  /** Forget the saved sign-ins of every server not in `keep` (servers that were deleted). */
  prune(keep: Iterable<string>): void {
    const ids = new Set(keep);
    let changed = false;
    for (const id of [...this.map.keys()]) if (!ids.has(id)) changed = this.map.delete(id) || changed;
    if (changed) this.save();
  }

  list(): RememberedSignIn[] {
    this.expire();
    return [...this.map.entries()].map(([serverId, e]) => ({ serverId, savedAt: e.savedAt, refreshable: e.refreshable, ...(e.accessExpiresAt !== undefined ? { accessExpiresAt: e.accessExpiresAt } : {}) }));
  }

  /** How many are saved on disk, whether or not this run can read them. */
  savedCount(): number {
    return Object.keys(this.read()).length;
  }

  /** Does this key open at least one saved sign-in? Used to check a recovery key before adopting it. */
  canOpenAny(candidate: SecretBox): boolean {
    return Object.entries(this.read()).some(([id, e]) => candidate.canOpen(e.sealed, aadFor(id)));
  }

  /** Delete every saved sign-in, including the file (start over). */
  wipe(): number {
    const n = Math.max(this.map.size, this.savedCount());
    this.map.clear();
    if (this.file) rmSync(this.file, { force: true });
    return n;
  }

  /** Read what is saved again, after the key changed. */
  reload(): void {
    this.map.clear();
    if (!this.available) return;
    for (const [id, e] of Object.entries(this.read())) this.map.set(id, e);
    this.expire();
  }
}
