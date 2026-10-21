import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEAL_PREFIX, SecretBox } from "./credentials/box.js";
import { normalizeSettings, type PersistedConfig, type ServerConfig, type Settings, type SourceConfig } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9-_]{0,62}$/;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return s || "server";
}

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;

/**
 * Tidies a server's labels: trims them, squeezes inner spaces, drops blanks and repeats (ignoring case), and spells
 * each like the same label already used elsewhere (`known`), so "Work" and "work" stay one label. Anything that
 * isn't a list of text is returned as is, for `validateServer` to refuse. No labels at all becomes `undefined`.
 */
export function tidyLabels(labels: unknown, known: Iterable<string> = []): unknown {
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) return labels;
  const spelling = new Map<string, string>();
  for (const l of known) if (!spelling.has(l.toLowerCase())) spelling.set(l.toLowerCase(), l);
  const out = new Map<string, string>();
  for (const raw of labels as string[]) {
    const l = raw.trim().replace(/\s+/g, " ");
    const key = l.toLowerCase();
    if (l && !out.has(key)) out.set(key, spelling.get(key) ?? l);
  }
  return out.size ? [...out.values()] : undefined;
}

export const hasLabel = (s: ServerConfig, label: string): boolean => (s.labels ?? []).some((l) => l.toLowerCase() === label.trim().toLowerCase());

export function validateServer(s: Partial<ServerConfig>): string | null {
  if (!s.id || !ID_RE.test(s.id)) return "id must be 1-63 chars of a-z, 0-9, '-' or '_'";
  if (!s.name?.trim()) return "name is required";
  if (s.notes !== undefined && (typeof s.notes !== "string" || s.notes.length > 10_000)) return "notes must be text of at most 10,000 characters";
  if (s.labels !== undefined && (!Array.isArray(s.labels) || s.labels.length > MAX_LABELS || s.labels.some((l) => typeof l !== "string" || !l.trim() || l.length > MAX_LABEL_LENGTH))) {
    return `labels must be a list of at most ${MAX_LABELS} labels of up to ${MAX_LABEL_LENGTH} characters`;
  }
  if (s.transport === "stdio") {
    if (!s.command?.trim()) return "command is required for stdio servers";
  } else if (s.transport === "http") {
    try {
      const u = new URL(s.url ?? "");
      if (u.protocol !== "http:" && u.protocol !== "https:") return "url must be http(s)";
    } catch {
      return "a valid url is required for http servers";
    }
  } else {
    return "transport must be 'stdio' or 'http'";
  }
  if (s.oauth?.remember !== undefined && typeof s.oauth.remember !== "boolean") return "oauth.remember must be true or false";
  return null;
}

/** A value is a credential reference when it holds {{…}} or is a bare op://, keychain://, vault://, secret:// or env:// reference. */
const REFERENCE = /\{\{[\s\S]*?\}\}|^\s*(?:op|keychain|vault|secret|env):\/\//i;

/**
 * JSON-file backed store for server and source definitions. Credential references inside a server (the
 * `{{op://…}}` in its env, headers, arguments and so on) are sealed with the SecretBox, both in the file and in
 * memory; use `reveal()` to read a server when it is shown or used. Without a persistent key nothing is sealed.
 */
export class ConfigStore {
  private data: PersistedConfig;

  constructor(
    private readonly path: string,
    private readonly box: SecretBox = SecretBox.ephemeral(),
  ) {
    this.data = this.load();
    // Servers saved before references were encrypted are sealed now.
    if (this.needsSave) this.save();
  }

  private needsSave = false;

  /** Does this file already hold sealed values? Then a missing key must not be replaced with a new one. */
  static hasSealed(path: string): boolean {
    try {
      return readFileSync(path, "utf-8").includes(SEAL_PREFIX);
    } catch {
      return false;
    }
  }

  private mapValues(s: ServerConfig, fn: (v: string) => string): ServerConfig {
    const rec = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fn(v)])) : r);
    const out: ServerConfig = { ...s };
    if (s.command !== undefined) out.command = fn(s.command);
    if (s.cwd !== undefined) out.cwd = fn(s.cwd);
    if (s.url !== undefined) out.url = fn(s.url);
    if (s.args) out.args = s.args.map(fn);
    if (s.env) out.env = rec(s.env);
    if (s.headers) out.headers = rec(s.headers);
    if (s.oauth?.clientSecret !== undefined) out.oauth = { ...s.oauth, clientSecret: fn(s.oauth.clientSecret) };
    return out;
  }

  /** Seal every credential reference in a server definition (no-op without a persistent key). */
  private seal(s: ServerConfig): ServerConfig {
    if (!this.box.persistent) return s;
    return this.mapValues(s, (v) => (!this.box.isSealed(v) && REFERENCE.test(v) ? this.box.seal(v) : v));
  }

  /** A copy of a stored server with its credential references readable, for showing or using. */
  reveal(s: ServerConfig): ServerConfig {
    return this.mapValues(s, (v) => {
      try {
        return this.box.open(v);
      } catch {
        return v; // wrong or missing key: leave it sealed rather than lose it
      }
    });
  }

  private sealedValues(): string[] {
    const found: string[] = [];
    for (const s of this.data.servers) this.mapValues(s, (v) => (this.box.isSealed(v) && found.push(v), v));
    return found;
  }

  /** Is anything sealed here? */
  hasSealedValues(): boolean {
    return this.sealedValues().length > 0;
  }

  /** Does this key open at least one sealed value? Used to check a recovery key before adopting it. */
  canOpenAny(candidate: SecretBox): boolean {
    return this.sealedValues().some((v) => candidate.canOpen(v));
  }

  /** Seal anything that was saved readable while no key was available (after a recovery). */
  resealAll(): void {
    const next = this.data.servers.map((s) => this.seal(s));
    if (next.some((s, i) => JSON.stringify(s) !== JSON.stringify(this.data.servers[i]))) {
      this.data.servers = next;
      this.save();
    }
  }

  /**
   * Start over after the key was lost: sealed values that can no longer be opened are emptied, and the servers
   * that held them are switched off so they don't keep failing. Returns those servers so the user can fix them.
   */
  blankUnreadable(): Array<{ id: string; name: string }> {
    const affected: Array<{ id: string; name: string }> = [];
    this.data.servers = this.data.servers.map((s) => {
      let hit = false;
      const next = this.mapValues(s, (v) => {
        if (this.box.isSealed(v) && !this.box.canOpen(v)) {
          hit = true;
          return "";
        }
        return v;
      });
      if (!hit) return s;
      affected.push({ id: s.id, name: s.name });
      return { ...next, enabled: false };
    });
    if (affected.length) this.save();
    return affected;
  }

  private load(): PersistedConfig {
    let parsed: Partial<PersistedConfig> = {};
    if (existsSync(this.path)) {
      try {
        parsed = JSON.parse(readFileSync(this.path, "utf-8"));
      } catch {
        // A corrupt file must not brick the app; keep a copy and start fresh.
        try {
          renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        } catch {}
      }
    }
    const settings: Settings = normalizeSettings(parsed.settings);
    // 1 hour was the old default and caused repeat prompts; secrets now stay until locked unless changed again.
    if (settings.cacheTtlSeconds === 3600 && !parsed.settings?.cacheTtlMigrated) {
      settings.cacheTtlSeconds = 0;
    }
    settings.cacheTtlMigrated = true;
    if (!settings.clientToken) settings.clientToken = randomBytes(24).toString("base64url");
    const sources = parsed.sources ?? [];
    // The environment source exposes every variable the hub can see (including your shell profile) to any
    // server definition, so it starts out off. Local secrets are encrypted, so they are safe to leave on.
    for (const [type, name, enabled] of [
      ["env", "Environment variables", false],
      ["manual", "Local secrets", true],
    ] as const) {
      if (!sources.some((x) => x.type === type)) {
        sources.push({ id: type, type, name, enabled, options: {} });
      }
    }
    for (const s of sources) if (s.type === "manual" && s.name === "Manual secrets (memory only)") s.name = "Local secrets";
    const stored = parsed.servers ?? [];
    const servers = stored.map((s) => this.seal(s));
    this.needsSave = servers.some((s, i) => JSON.stringify(s) !== JSON.stringify(stored[i]));
    const cfg: PersistedConfig = { version: 1, servers, sources, settings };
    // 1Password and the OS keychain are set up once on first run (or the first run after this was added), so
    // references like {{op://…}} and {{keychain://…}} work with no setup. Removing one later keeps it removed.
    if (!settings.sourcesAutoConfigured) {
      for (const [type, name] of [
        ["1password", "1Password"],
        ["keychain", "OS keychain"],
      ] as const) {
        if (!sources.some((x) => x.type === type)) sources.push({ id: type, type, name, enabled: true, options: {} });
      }
      settings.sourcesAutoConfigured = true;
    }
    return cfg;
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get servers(): ServerConfig[] {
    return this.data.servers;
  }
  get sources(): SourceConfig[] {
    return this.data.sources;
  }
  get settings(): Settings {
    return this.data.settings;
  }

  getServer(id: string): ServerConfig | undefined {
    return this.data.servers.find((s) => s.id === id);
  }

  upsertServer(s: ServerConfig): void {
    const sealed = this.seal(s);
    const i = this.data.servers.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data.servers[i] = sealed;
    else this.data.servers.push(sealed);
    this.save();
  }

  /**
   * Put the servers in the given order. Ids that aren't servers are ignored, and servers that aren't listed (added
   * since the caller last looked) keep their relative order after the listed ones.
   */
  reorderServers(ids: string[]): void {
    const byId = new Map(this.data.servers.map((s) => [s.id, s]));
    const first = [...new Set(ids)].filter((id) => byId.has(id));
    const listed = new Set(first);
    this.data.servers = [...first.map((id) => byId.get(id)!), ...this.data.servers.filter((s) => !listed.has(s.id))];
    this.save();
  }

  removeServer(id: string): boolean {
    const n = this.data.servers.length;
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.save();
    return this.data.servers.length !== n;
  }

  upsertSource(s: SourceConfig): void {
    const i = this.data.sources.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data.sources[i] = s;
    else this.data.sources.push(s);
    this.save();
  }

  removeSource(id: string): boolean {
    const n = this.data.sources.length;
    this.data.sources = this.data.sources.filter((s) => s.id !== id);
    this.save();
    return this.data.sources.length !== n;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
}
