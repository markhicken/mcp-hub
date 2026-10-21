import { EventEmitter } from "node:events";
import type { SourceConfig, SourceType } from "../types.js";
import { SecretBox, type EncryptionInfo } from "./box.js";
import { createKeychainProvider } from "./keychain.js";
import { LocalSecrets } from "./local-secrets.js";
import { createOnePasswordProvider } from "./onepassword.js";
import { createEnvProvider, createManualProvider } from "./simple.js";
import {
  CredentialError,
  TYPE_FOR_SCHEME,
  schemeOf,
  type CredentialProvider,
  type ProviderFactory,
} from "./types.js";
import { createVaultProvider } from "./vault.js";

const FACTORIES: Record<SourceType, ProviderFactory> = {
  "1password": createOnePasswordProvider,
  keychain: createKeychainProvider,
  vault: createVaultProvider,
  manual: createManualProvider,
  env: createEnvProvider,
};

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface BrokerOptions {
  getSources: () => SourceConfig[];
  getCacheTtlSeconds: () => number;
  getDenialCooldownSeconds: () => number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Encrypts what the broker holds. Defaults to a throwaway in-memory key. */
  box?: SecretBox;
  /** Where typed-in (local) secrets are saved, encrypted. Omit to keep them in memory only. */
  secretsPath?: string;
}

export interface CachedEntry {
  ref: string;
  sourceId: string;
  expiresAt: number | null;
  fetchedAt: number;
}

export interface PromptEvent {
  ref: string;
  requester: string;
  sourceName: string;
  sourceType: SourceType;
  /** Why the secret is wanted, as a short phrase ("Claude connected", "MCP Hub started"). */
  trigger?: string;
}

/** Every use of a secret: read from its source, or handed out from memory. Never carries the value. */
export interface AccessEvent {
  requester: string;
  trigger: string;
  sourceName: string;
  sourceType: SourceType;
  outcome: "read" | "memory" | "denied" | "timeout" | "not-found" | "unavailable";
}

interface CacheItem {
  /** Sealed (AES-256-GCM): the plain value only exists for the moment it is handed to a caller. */
  value: string;
  sourceId: string;
  fetchedAt: number;
  expiresAt: number | null;
}

/**
 * Resolves credential references to secrets, holding results in memory only, encrypted.
 * - deduplicates concurrent requests for the same reference
 * - serializes reads per source so the user sees one prompt at a time
 * - backs off after a denied prompt
 * Events: "prompt" (before a read that may show a system prompt), "access" (every use of a secret, with its outcome),
 * "change" (cache/state changed).
 */
export class CredentialBroker extends EventEmitter {
  readonly memory: LocalSecrets;
  readonly box: SecretBox;
  private readonly cache = new Map<string, CacheItem>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly reading = new Map<number, PromptEvent & { startedAt: number }>();
  private readSeq = 0;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly opts: BrokerOptions) {
    super();
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.box = opts.box ?? SecretBox.ephemeral();
    this.memory = new LocalSecrets(this.box, opts.secretsPath);
    // Forget expired secrets when they expire, not just the next time something asks for them.
    this.sweeper = setInterval(() => this.purgeExpired(), 15_000);
    this.sweeper.unref();
  }

  encryption(): EncryptionInfo {
    return this.box.info();
  }

  /** Stops the background sweep (the hub is shutting down). */
  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private purgeExpired(): void {
    const t = this.now();
    let changed = false;
    for (const [k, v] of this.cache) {
      if (v.expiresAt !== null && v.expiresAt <= t) {
        this.cache.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit("change");
  }

  /** The "forget after" setting changed: apply it to what is already held, then drop anything now expired. */
  applyTtl(): void {
    const ttl = this.opts.getCacheTtlSeconds();
    for (const v of this.cache.values()) v.expiresAt = ttl > 0 ? v.fetchedAt + ttl * 1000 : null;
    this.purgeExpired();
    this.emit("change");
  }

  private providerFor(source: SourceConfig): CredentialProvider {
    return FACTORIES[source.type](source, { memory: this.memory, env: this.env });
  }

  findSource(ref: string): SourceConfig {
    const scheme = schemeOf(ref);
    const type = scheme ? TYPE_FOR_SCHEME[scheme] : undefined;
    if (!type) throw new CredentialError(`Unknown credential reference "${redactRef(ref)}"`, "invalid");
    const src = this.opts.getSources().find((s) => s.type === type && s.enabled);
    if (!src) {
      const hint = type === "env" ? "Turn on Environment variables in Credentials." : "Add one in Credentials.";
      throw new CredentialError(`No enabled credential source for ${scheme}:// references. ${hint}`, "unavailable");
    }
    return src;
  }

  isReference(value: string): boolean {
    const s = schemeOf(value);
    return !!s && s in TYPE_FOR_SCHEME;
  }

  /** Replaces every {{ref}} in a template. A bare "op://..." value is treated as a reference too. */
  async resolveTemplate(template: string, requester: string, trigger = ""): Promise<string> {
    const trimmed = template.trim();
    if (!trimmed.includes("{{") && this.isReference(trimmed)) return this.resolve(trimmed, requester, trigger);

    const refs = new Set<string>();
    for (const m of template.matchAll(TEMPLATE_RE)) refs.add(m[1]!);
    if (!refs.size) return template;
    const values = new Map<string, string>();
    for (const ref of refs) values.set(ref, await this.resolve(ref, requester, trigger));
    return template.replace(TEMPLATE_RE, (_all, ref: string) => values.get(ref) ?? "");
  }

  async resolveRecord(rec: Record<string, string> | undefined, requester: string, trigger = ""): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec ?? {})) out[k] = await this.resolveTemplate(v, requester, trigger);
    return out;
  }

  /** Does this value contain anything that needs a credential lookup? */
  needsCredentials(values: Array<string | undefined>): boolean {
    return values.some((v) => !!v && (v.includes("{{") || this.isReference(v.trim())));
  }

  async resolve(ref: string, requester: string, trigger = ""): Promise<string> {
    const source = this.findSource(ref);
    const key = `${source.id}\u0000${ref}`;
    const report = (outcome: AccessEvent["outcome"]) => this.emit("access", { requester, trigger, sourceName: source.name, sourceType: source.type, outcome } satisfies AccessEvent);
    const fail = (err: unknown): never => {
      if (err instanceof CredentialError) {
        report(err.kind === "denied" ? "denied" : err.kind === "not-found" ? "not-found" : /timed out/i.test(err.message) ? "timeout" : "unavailable");
      } else {
        report("unavailable");
      }
      throw err;
    };

    const hit = this.cache.get(key);
    if (hit && (hit.expiresAt === null || hit.expiresAt > this.now())) {
      const value = this.box.open(hit.value, key);
      report("memory");
      return value;
    }
    if (hit) this.cache.delete(key);

    const cooldown = this.cooldownUntil.get(source.id) ?? 0;
    if (cooldown > this.now()) {
      const s = Math.ceil((cooldown - this.now()) / 1000);
      return fail(new CredentialError(`Credential access was denied recently. Try again in ${s}s.`, "denied"));
    }

    const pending = this.inflight.get(key);
    // Another caller is already reading this secret: it gets the same value, from memory, once that read finishes.
    if (pending) return pending.then((v) => (report("memory"), v));

    const provider = this.providerFor(source);
    const promise = this.enqueue(source.id, async () => {
      // A queued read ahead of us may already have filled the cache.
      const again = this.cache.get(key);
      if (again && (again.expiresAt === null || again.expiresAt > this.now())) {
        const value = this.box.open(again.value, key);
        report("memory");
        return value;
      }
      const prompt: PromptEvent = { ref, requester, sourceName: source.name, sourceType: source.type, trigger };
      const readId = ++this.readSeq;
      this.reading.set(readId, { ...prompt, startedAt: this.now() });
      this.emit("prompt", prompt);
      this.emit("change");
      try {
        const value = await provider.resolve(ref);
        const ttl = this.opts.getCacheTtlSeconds();
        const fetchedAt = this.now();
        this.cache.set(key, { value: this.box.seal(value, key), sourceId: source.id, fetchedAt, expiresAt: ttl > 0 ? fetchedAt + ttl * 1000 : null });
        report("read");
        this.emit("change");
        return value;
      } catch (err) {
        if (err instanceof CredentialError && err.kind === "denied") {
          this.cooldownUntil.set(source.id, this.now() + this.opts.getDenialCooldownSeconds() * 1000);
        }
        return fail(err);
      } finally {
        this.reading.delete(readId);
        this.emit("change");
      }
    }).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private enqueue<T>(queueId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(queueId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      queueId,
      next.catch(() => undefined),
    );
    return next;
  }

  async testSource(source: SourceConfig): Promise<{ ok: boolean; message: string; hint?: "sign-in" }> {
    try {
      return await this.providerFor(source).test();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  cached(): CachedEntry[] {
    const t = this.now();
    return [...this.cache.entries()]
      .filter(([, v]) => v.expiresAt === null || v.expiresAt > t)
      .map(([k, v]) => ({ ref: redactRef(k.split("\u0000")[1]!), sourceId: v.sourceId, expiresAt: v.expiresAt, fetchedAt: v.fetchedAt }));
  }

  /** Reads currently waiting on a credential source (possibly showing a system prompt). */
  activeReads(): Array<PromptEvent & { startedAt: number }> {
    return [...this.reading.values()];
  }

  /**
   * Forget every secret fetched from a credential source. Local secrets are saved encrypted, so they stay
   * (their in-memory copies are dropped and re-read when needed); without a place to save them they are forgotten too.
   */
  lock(): void {
    this.cache.clear();
    this.cooldownUntil.clear();
    if (this.box.persistent) this.memory.lock();
    else for (const n of this.memory.names()) this.memory.delete(n);
    this.emit("change");
  }

  /** Drop every cached secret and cooldown (the key changed). */
  invalidateAll(): void {
    this.cache.clear();
    this.cooldownUntil.clear();
    this.emit("change");
  }

  /** Forget one fetched secret so the next use reads it again (e.g. after it was rotated). Returns whether it was cached. */
  forget(sourceId: string, ref: string): boolean {
    let found = false;
    for (const [k, v] of this.cache) {
      if (v.sourceId !== sourceId) continue;
      const r = k.slice(sourceId.length + 1);
      if (r === ref || redactRef(r) === ref) {
        this.cache.delete(k);
        found = true;
      }
    }
    if (found) {
      this.cooldownUntil.delete(sourceId);
      this.emit("change");
    }
    return found;
  }

  /** Drop cached secrets for one source (e.g. after its settings change). */
  invalidateSource(sourceId: string): void {
    for (const [k, v] of this.cache) if (v.sourceId === sourceId) this.cache.delete(k);
    this.cooldownUntil.delete(sourceId);
    this.emit("change");
  }
}

/** References identify a secret but never contain it; still, avoid leaking query-ish parts. */
export function redactRef(ref: string): string {
  return ref.length > 200 ? `${ref.slice(0, 200)}…` : ref;
}
