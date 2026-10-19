import { SEAL_PREFIX } from "./credentials/box.js";
import { pointsAtHub } from "./hub-entry.js";
import { toServerConfig } from "./import.js";
import { slugify, validateServer } from "./store.js";
import type { ServerConfig, SourceConfig, SourceType } from "./types.js";

/**
 * Export and import of MCP Hub's own configuration: the servers and any extra credential sources. Credential
 * references (`{{op://…}}`) travel as references. Secret values never do: not local secrets, not cached values.
 */

export const EXPORT_FORMAT = "mcp-hub-config";
export const EXPORT_VERSION = 1;

export interface ExportDoc {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  app: string;
  servers: ServerConfig[];
  sources: SourceConfig[];
  /** Names of local secrets the servers refer to. Their values are not in this file. */
  localSecrets: string[];
  /** For the person exporting; ignored on import. */
  warnings: string[];
}

const SOURCE_TYPES: SourceType[] = ["1password", "keychain", "vault", "manual", "env"];
/** Paths to tools installed on one computer mean nothing on another. */
const MACHINE_SPECIFIC = new Set(["opPath", "vaultPath"]);
const SECRETISH = /token|secret|key|passw|auth|cookie|credential/i;

const isReference = (v: string): boolean => /\{\{[\s\S]*?\}\}/.test(v) || /^\s*(?:op|keychain|vault|secret|env):\/\//i.test(v);

function* values(s: ServerConfig): Generator<[string, string]> {
  if (s.command) yield ["command", s.command];
  if (s.url) yield ["url", s.url];
  if (s.cwd) yield ["cwd", s.cwd];
  for (const a of s.args ?? []) yield ["args", a];
  for (const [k, v] of Object.entries(s.env ?? {})) yield [`env ${k}`, v];
  for (const [k, v] of Object.entries(s.headers ?? {})) yield [`header ${k}`, v];
}

/** Names of local secrets that servers refer to as `{{secret://name}}`. */
export function localSecretNames(servers: ServerConfig[]): string[] {
  const names = new Set<string>();
  for (const s of servers) for (const [, v] of values(s)) for (const m of v.matchAll(/secret:\/\/([^\s}'"]+)/g)) names.add(decodeURIComponent(m[1]!));
  return [...names].sort();
}

const sanitizeSource = (s: SourceConfig): SourceConfig => ({
  id: s.id,
  type: s.type,
  name: s.name,
  enabled: s.enabled,
  options: Object.fromEntries(Object.entries(s.options ?? {}).filter(([k, v]) => !MACHINE_SPECIFIC.has(k) && typeof v === "string")),
});

/** `servers` must already be readable (references revealed). */
export function buildExport(servers: ServerConfig[], sources: SourceConfig[], version: string, now = new Date()): ExportDoc {
  const warnings: string[] = [];
  for (const s of servers) {
    for (const [where, v] of values(s)) {
      const key = where.split(" ").slice(1).join(" ");
      if ((where.startsWith("env ") || where.startsWith("header ")) && SECRETISH.test(key) && v.trim() && !isReference(v)) {
        warnings.push(`${s.name}: ${where} is a typed-in value, not a credential reference, so it is saved in this file as written. Anyone who gets the file can read it.`);
      }
    }
  }
  const localSecrets = localSecretNames(servers);
  if (localSecrets.length) warnings.push(`Local secrets are never exported. Add these again after importing: ${localSecrets.join(", ")}.`);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    app: `MCP Hub ${version}`,
    servers: servers.map((s) => ({ ...s })),
    sources: sources.map(sanitizeSource),
    localSecrets,
    warnings,
  };
}

// ------------------------------------------------------------------ importing

const SERVER_KEYS = ["id", "name", "description", "notes", "transport", "command", "args", "env", "cwd", "url", "headers", "auth", "oauth", "enabled", "lifecycle", "idleTimeoutMinutes"] as const;

function cleanServer(raw: Record<string, any>): ServerConfig {
  const out: Record<string, any> = {};
  for (const k of SERVER_KEYS) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  out.name = String(out.name ?? "").trim();
  out.id = slugify(String(out.id ?? out.name));
  out.enabled = out.enabled !== false;
  out.lifecycle = out.lifecycle === "on-demand" ? "on-demand" : "keep-alive";
  return out as ServerConfig;
}

export interface ParsedImport {
  servers: ServerConfig[];
  sources: SourceConfig[];
  /** Entries that could not be used, each with the reason. */
  problems: Array<{ name: string; reason: string }>;
}

const hasSealed = (s: ServerConfig): boolean => [...values(s)].some(([, v]) => v.startsWith(SEAL_PREFIX));

/**
 * Reads an exported file, or a plain `{ "mcpServers": { … } }` file like other apps use.
 * Anything it can't use is reported, never guessed at.
 */
export function parseImport(input: unknown): ParsedImport {
  const out: ParsedImport = { servers: [], sources: [], problems: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    out.problems.push({ name: "File", reason: "That isn't an MCP Hub export or an mcpServers file." });
    return out;
  }
  const doc = input as Record<string, any>;
  const candidates: Array<{ name: string; cfg: ServerConfig | null; why?: string }> = [];

  if (doc.format === EXPORT_FORMAT) {
    if (typeof doc.version !== "number" || doc.version > EXPORT_VERSION) {
      out.problems.push({ name: "File", reason: "This export was made by a newer MCP Hub. Update MCP Hub, then try again." });
      return out;
    }
    for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
      if (!s || typeof s !== "object") continue;
      candidates.push({ name: String(s.name ?? s.id ?? "Server"), cfg: cleanServer(s) });
    }
    for (const s of Array.isArray(doc.sources) ? doc.sources : []) {
      if (s && typeof s.id === "string" && SOURCE_TYPES.includes(s.type) && typeof s.name === "string") out.sources.push(sanitizeSource({ id: s.id, type: s.type, name: s.name, enabled: s.enabled !== false, options: s.options ?? {} }));
    }
  } else {
    const map = doc.mcpServers ?? doc.servers;
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      out.problems.push({ name: "File", reason: "That isn't an MCP Hub export or an mcpServers file." });
      return out;
    }
    for (const [name, raw] of Object.entries<any>(map)) {
      if (raw && typeof raw === "object" && pointsAtHub(raw)) candidates.push({ name, cfg: null, why: "It already goes through MCP Hub." });
      else candidates.push({ name, cfg: toServerConfig(name, raw), why: "It isn't a command or a URL MCP Hub can run." });
    }
  }

  const seen = new Set<string>();
  for (const { name, cfg, why } of candidates) {
    if (!cfg) {
      out.problems.push({ name, reason: why ?? "Not usable." });
      continue;
    }
    if (hasSealed(cfg)) {
      out.problems.push({ name, reason: "It holds encrypted values from another computer, which can't be read here. Export again from the original MCP Hub." });
      continue;
    }
    const err = validateServer(cfg);
    if (err) {
      out.problems.push({ name, reason: err });
      continue;
    }
    if (seen.has(cfg.id)) {
      out.problems.push({ name, reason: "Another server in the file has the same id." });
      continue;
    }
    seen.add(cfg.id);
    out.servers.push(cfg);
  }
  return out;
}

export type ClashChoice = "skip" | "replace" | "copy";

export interface PlannedServer {
  name: string;
  /** The id it will have (for "replace", the existing server's id). */
  id: string;
  action: "add" | "replace" | "copy" | "skip";
  reason?: string;
  config: ServerConfig;
}

export interface ImportPlan {
  servers: PlannedServer[];
  problems: ParsedImport["problems"];
  sources: { add: SourceConfig[]; skip: Array<{ name: string; reason: string }> };
  /** Local secrets the imported servers use that don't exist here yet. */
  missingLocalSecrets: string[];
}

export function planImport(
  parsed: ParsedImport,
  existing: { servers: Array<{ id: string; name: string }>; sources: SourceConfig[]; localSecrets: string[] },
  opts: { onClash: ClashChoice; includeSources: boolean },
): ImportPlan {
  const taken = new Set(existing.servers.map((s) => s.id));
  const planned: PlannedServer[] = [];
  for (const cfg of parsed.servers) {
    const match = existing.servers.find((e) => e.id === cfg.id) ?? existing.servers.find((e) => e.name.toLowerCase() === cfg.name.toLowerCase());
    if (!match) {
      taken.add(cfg.id);
      planned.push({ name: cfg.name, id: cfg.id, action: "add", config: cfg });
    } else if (opts.onClash === "replace") {
      planned.push({ name: cfg.name, id: match.id, action: "replace", config: { ...cfg, id: match.id }, reason: "Replaces the one already in MCP Hub." });
    } else if (opts.onClash === "copy") {
      let n = 2;
      while (taken.has(`${cfg.id}-${n}`)) n++;
      const id = `${cfg.id}-${n}`;
      taken.add(id);
      planned.push({ name: `${cfg.name} (${n})`, id, action: "copy", config: { ...cfg, id, name: `${cfg.name} (${n})` }, reason: "Kept alongside the one already in MCP Hub." });
    } else {
      planned.push({ name: cfg.name, id: match.id, action: "skip", config: cfg, reason: "Already in MCP Hub." });
    }
  }

  const sources: ImportPlan["sources"] = { add: [], skip: [] };
  if (opts.includeSources) {
    for (const s of parsed.sources) {
      const clash = existing.sources.some((e) => e.id === s.id || (e.type === s.type && e.name === s.name));
      if (clash) sources.skip.push({ name: s.name, reason: "Already in MCP Hub." });
      else sources.add.push(s);
    }
  }

  const have = new Set(existing.localSecrets);
  const used = localSecretNames(planned.filter((p) => p.action !== "skip").map((p) => p.config));
  return { servers: planned, problems: parsed.problems, sources, missingLocalSecrets: used.filter((n) => !have.has(n)) };
}
