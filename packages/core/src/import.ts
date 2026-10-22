import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { readCodexServers } from "./codex.js";
import { pointsAtHub } from "./hub-entry.js";
import { slugify } from "./store.js";
import type { ServerConfig } from "./types.js";

export interface ImportCandidate {
  name: string;
  /** Absent for entries that already go through MCP Hub: they are listed but cannot be imported. */
  config?: ServerConfig;
  viaHub?: boolean;
}

export interface ImportSource {
  client: string;
  path: string;
  servers: ImportCandidate[];
}

export interface ClientConfigFile {
  client: string;
  path: string;
  shape: "mcpServers" | "claude-code";
  /** The object in the file that holds the servers. */
  key: "mcpServers" | "servers" | "mcp_servers";
  /** JSON (the default, comments allowed) or TOML (Codex). */
  format?: "json" | "toml";
}

/** Codex's folder: `CODEX_HOME` if set, otherwise `~/.codex`. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * The Microsoft Store (MSIX) build of Claude Desktop keeps its config inside the package's own copy of AppData
 * (`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude`), and reads only that one, not `%APPDATA%`, even before
 * it has made a config file. So when the Store package is installed its path is the answer; otherwise the classic one.
 * `exists`/`list` are parameters so this can be tested without Windows.
 */
export function claudeDesktopWindowsPath(appData: string, localAppData: string, list: (dir: string) => string[] = (d) => readdirSync(d)): string {
  const classic = join(appData, "Claude", "claude_desktop_config.json");
  const packages = join(localAppData, "Packages");
  try {
    const pkg = list(packages).find((dir) => /^Claude_/i.test(dir));
    if (pkg) return join(packages, pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
  } catch {
    // no Packages folder: not Windows, or nothing installed from the Store
  }
  return classic;
}

/** Claude Code keeps its user settings, and the MCP servers added for the user, in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set). */
export function claudeCodeConfigPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? join(dir, ".claude.json") : join(home, ".claude.json");
}

/**
 * The Copilot CLI's MCP config: in `$COPILOT_HOME` when that is set, otherwise `~/.copilot`. Where `XDG_CONFIG_HOME` is
 * set and the config is only found under `$XDG_CONFIG_HOME/copilot`, that one is used; everywhere else the default stands.
 */
export function copilotConfigPath(home: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const name = "mcp-config.json";
  const override = env.COPILOT_HOME?.trim();
  if (override) return join(override, name);
  const usual = join(home, ".copilot", name);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && !exists(usual)) {
    const alt = join(xdg, "copilot", name);
    if (exists(alt)) return alt;
  }
  return usual;
}

export function candidatePaths(): ClientConfigFile[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const vscode =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
      : process.platform === "win32"
        ? join(appData, "Code", "User", "mcp.json")
        : join(configHome, "Code", "User", "mcp.json");
  const desktop =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : process.platform === "win32"
        ? claudeDesktopWindowsPath(appData, process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
        : join(configHome, "Claude", "claude_desktop_config.json");
  return [
    { client: "Claude Desktop", path: desktop, shape: "mcpServers", key: "mcpServers" },
    { client: "Claude Code", path: claudeCodeConfigPath(home), shape: "claude-code", key: "mcpServers" },
    // The ChatGPT desktop app, the Codex CLI and the Codex IDE extension all read this one file.
    { client: "ChatGPT / Codex", path: join(codexHome(), "config.toml"), shape: "mcpServers", key: "mcp_servers", format: "toml" },
    { client: "GitHub Copilot CLI", path: copilotConfigPath(home), shape: "mcpServers", key: "mcpServers" },
    { client: "VS Code", path: vscode, shape: "mcpServers", key: "servers" },
    { client: "Cursor", path: join(home, ".cursor", "mcp.json"), shape: "mcpServers", key: "mcpServers" },
    // Auggie, Augment's CLI. Its settings file holds other settings too; only "mcpServers" is touched.
    { client: "Augment", path: join(home, ".augment", "settings.json"), shape: "mcpServers", key: "mcpServers" },
  ];
}

type Raw = Record<string, any>;

const INJECTOR = /(^|[\\/])inject-1password-secrets\.sh$/;

/**
 * Windows apps run `npx` and other `.cmd` programs through the command interpreter, as `cmd /c npx -y server`.
 * The hub starts programs itself (with the same PATH), so the wrapper is dropped and the entry is what it ran.
 * Entries that aren't a `cmd /c …` call come back unchanged.
 */
export function unwrapCmdShell(raw: Raw): Raw {
  if (!raw || typeof raw.command !== "string") return raw;
  if (!/^cmd(\.exe)?$/i.test(raw.command.split(/[\\/]/).pop()!)) return raw;
  const args: string[] = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const flags = new Set(["/d", "/s", "/c", "/q", "/v:off"]);
  let i = 0;
  while (i < args.length && flags.has(args[i]!.toLowerCase())) i++;
  if (!args.slice(0, i).some((a) => a.toLowerCase() === "/c") || i >= args.length) return raw;
  const rest = args.slice(i);
  // `cmd /c "npx -y server"` passes the whole command line as one argument.
  const words = rest.length === 1 && /\s/.test(rest[0]!) ? [...rest[0]!.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "") : rest;
  const [command, ...others] = words;
  if (!command || /[&|<>^%]/.test(words.join(" "))) return raw; // shell syntax: leave it to cmd
  return { ...raw, command, args: others };
}

/** Wrap every op:// reference in {{ }} so the hub's credential broker resolves it (quotes around a reference are dropped). */
function wrapRefs(value: string): string {
  if (value.includes("{{")) return value;
  const trimmed = value.trim();
  if (/^op:\/\//.test(trimmed) && !/['"]/.test(trimmed)) return `{{${trimmed}}}`;
  return value.replace(/'(op:\/\/[^']+)'|"(op:\/\/[^"]+)"|(op:\/\/[^\s'",;}]+)/g, (_m, a?: string, b?: string, c?: string) => `{{${a ?? b ?? c}}}`);
}

/**
 * The 1Password injector wrapper (`inject-1password-secrets.sh "VAR=op://…" -- command args…`, or its
 * `http` mode with URL/HEADERS env) is replaced by what it was doing: the hub resolves references itself.
 * Returns the entry as the hub should run it; entries that are not injector calls come back unchanged.
 */
export function unwrapInjector(raw: Raw): Raw {
  if (!raw || typeof raw.command !== "string" || !INJECTOR.test(raw.command)) return raw;
  const args: string[] = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env: Record<string, string> = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {};

  const http = args[0] === "http" || args[0] === "--http" || (!!env.URL && !args.includes("--"));
  if (http) {
    const { URL: url, HEADERS: headers, ...rest } = env;
    if (!url) return raw;
    let parsed: Record<string, string> | undefined;
    if (headers) {
      try {
        const h = JSON.parse(headers) as Record<string, unknown>;
        parsed = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrapRefs(String(v))]));
      } catch {
        return raw;
      }
    }
    const { command: _c, args: _a, env: _e, ...keep } = raw;
    void _c, _a, _e;
    return { ...keep, url: wrapRefs(url), type: "http", ...(parsed ? { headers: parsed } : {}), ...(Object.keys(rest).length ? { env: rest } : {}) };
  }

  const sep = args.indexOf("--");
  if (sep < 0 || sep === args.length - 1) return raw;
  for (const pair of args.slice(0, sep)) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = wrapRefs(pair.slice(i + 1));
  }
  const [command, ...rest] = args.slice(sep + 1);
  return { ...raw, command, args: rest, env };
}

/** Reads a dotenv file for `unwrapOpRun`; null when it can't be read. */
const readEnvFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

/**
 * KEY=VALUE lines the way `op run` reads them: blank lines and # comments skipped, an optional `export`, values
 * optionally quoted, and no variable expansion. Returns null for anything it can't read faithfully (a quoted
 * value that runs over several lines, or a line that isn't KEY=VALUE).
 */
export function parseEnvFile(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(t);
    if (!m) return null;
    let value = m[2]!;
    const q = value[0];
    if (q === '"' || q === "'") {
      const end = value.indexOf(q, 1);
      if (end < 0) return null;
      value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/** op run options that change nothing about which environment the program gets. */
const OP_RUN_HARMLESS = new Set(["--no-masking", "--account"]);

/**
 * `op run --env-file=app.env -- command args…` starts a program with the env file's variables set, `op://`
 * references resolved by 1Password. The hub does that itself, so this is replaced by what it was doing: the
 * program, and the file's variables as the server's env, with each `op://` reference turned into a hub reference
 * (plain values are kept as written, as they were). Several --env-file options are applied in order, later files
 * winning, and the file's values win over the entry's own env, as with `op run`.
 *
 * The env file is read here, only because the app's entry names it. If it can't be read or understood, or `op run`
 * is used some way the hub can't reproduce (--environment, a relative file with no cwd to resolve it against),
 * the entry comes back unchanged and still works as it did.
 */
export function unwrapOpRun(raw: Raw, read: (path: string) => string | null = readEnvFile): Raw {
  if (!raw || typeof raw.command !== "string" || raw.command.split(/[\\/]/).pop() !== "op") return raw;
  const args: string[] = Array.isArray(raw.args) ? raw.args.map(String) : [];
  if (args[0] !== "run") return raw;
  const sep = args.indexOf("--");
  if (sep < 0 || sep === args.length - 1) return raw;

  const files: string[] = [];
  const opts = args.slice(1, sep);
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!;
    if (a === "--env-file" || a.startsWith("--env-file=")) {
      const f = a === "--env-file" ? opts[++i] : a.slice("--env-file=".length);
      if (!f) return raw;
      files.push(f);
    } else if (a === "--account") {
      i++; // which 1Password account: the hub's own 1Password source decides that
    } else if (!OP_RUN_HARMLESS.has(a)) {
      return raw; // --environment, --no-masking variants…: not something the hub can reproduce
    }
  }
  if (!files.length) return raw;

  const env: Record<string, string> = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {};
  for (const file of files) {
    const path = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
    const absolute = isAbsolute(path) ? path : typeof raw.cwd === "string" && isAbsolute(raw.cwd) ? join(raw.cwd, path) : null;
    if (!absolute) return raw;
    const text = read(absolute);
    const vars = text === null ? null : parseEnvFile(text);
    if (!vars) return raw;
    for (const [k, v] of Object.entries(vars)) env[k] = wrapRefs(v);
  }
  const [command, ...rest] = args.slice(sep + 1);
  return { ...raw, command, args: rest, env };
}

/**
 * Apps expand ${VAR} and ${env:VAR} themselves; the hub doesn't, so turn them into references the credential broker
 * resolves (they need the Environment source, which says so if it is off). ${input:…} and ${workspaceFolder} are left.
 * Names in `keep` are left alone: the program being run expands those itself from the entry's own env.
 */
export function refVars(value: string, keep?: ReadonlySet<string>): string {
  return value.replace(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, env: string | undefined, name: string) =>
    !env && keep?.has(name) ? all : env || /^[A-Z_][A-Z0-9_]*$/.test(name) ? `{{env://${name}}}` : all,
  );
}

const REMOTE_BRIDGE = /^mcp-remote(@[^/\s]+)?$/;
/** mcp-remote options that change nothing the hub does itself (it picks the transport and handles sign-in). */
const REMOTE_HARMLESS = new Set(["--allow-http", "--debug", "--silent"]);

/**
 * `mcp-remote` makes an HTTP server look like a stdio one for apps that only run commands (Claude Desktop):
 * `npx mcp-remote https://host/mcp --header "Authorization: Bearer ${TOKEN}"`, with TOKEN set in the entry's env.
 * The hub talks HTTP itself, so this is turned back into the HTTP server it really is: the URL, the headers, and
 * the values of any ${VAR} that mcp-remote would have expanded from the entry's env (references such as op://
 * stay references). Entries using options the hub can't reproduce come back unchanged.
 */
export function unwrapRemoteBridge(raw: Raw): Raw {
  if (!raw || typeof raw.command !== "string") return raw;
  const args: string[] = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const all = [raw.command.split(/[\\/]/).pop()!, ...args];
  const at = all.findIndex((a) => REMOTE_BRIDGE.test(a));
  if (at < 0) return raw;

  const env: Record<string, string> = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {};
  const expand = (s: string) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => (name in env ? wrapRefs(env[name]!) : m));

  let url: string | undefined;
  const headers: Record<string, string> = {};
  const rest = all.slice(at + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--header" || a.startsWith("--header=")) {
      const v = a === "--header" ? rest[++i] : a.slice("--header=".length);
      const colon = v?.indexOf(":") ?? -1;
      if (!v || colon <= 0) return raw;
      headers[v.slice(0, colon).trim()] = expand(v.slice(colon + 1).trim());
    } else if (a === "--transport") {
      i++; // the hub chooses the transport itself
    } else if (REMOTE_HARMLESS.has(a) || /^\d+$/.test(a)) {
      // an option with no effect here, or the local sign-in callback port
    } else if (a.startsWith("-")) {
      return raw; // --host, --resource, --static-oauth-client-info…: not something the hub can reproduce
    } else if (!url && /^(https?:\/\/|\$\{)/.test(a)) {
      url = expand(a);
    } else return raw;
  }
  if (!url) return raw;
  const { command: _c, args: _a, env: _e, ...keep } = raw;
  void _c, _a, _e;
  return { ...keep, url, type: "http", ...(Object.keys(headers).length ? { headers } : {}) };
}

const mapValues = (o: unknown): Record<string, string> | undefined =>
  o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Raw).map(([k, v]) => [k, refVars(String(v))])) : undefined;

/** Convert one client-config entry into a hub server definition. Returns null if unusable. */
export function toServerConfig(name: string, input: Raw): ServerConfig | null {
  if (!input || typeof input !== "object") return null;
  const raw = unwrapRemoteBridge(unwrapInjector(unwrapCmdShell(input)));
  // Cline and Cursor mark a server off with `disabled: true`; keep it off rather than starting it.
  const enabled = raw.disabled !== true && raw.enabled !== false;
  const base = { id: slugify(name), name, enabled, lifecycle: "keep-alive" as const };
  const url = raw.url ?? raw.serverUrl;
  const isHttp = typeof url === "string" && (raw.type === "http" || raw.type === "sse" || raw.type === "streamable-http" || !raw.command);
  if (isHttp) {
    return { ...base, transport: "http", url: refVars(url), headers: mapValues(raw.headers), auth: "none" };
  }
  if (typeof raw.command === "string") {
    // ${VAR} naming a variable this entry sets in its own env is expanded by the program itself, so keep it as is.
    const own = new Set(raw.env && typeof raw.env === "object" ? Object.keys(raw.env) : []);
    return {
      ...base,
      transport: "stdio",
      command: refVars(raw.command, own),
      args: Array.isArray(raw.args) ? raw.args.map((a: unknown) => refVars(String(a), own)) : [],
      env: mapValues(raw.env),
      cwd: typeof raw.cwd === "string" ? refVars(raw.cwd, own) : undefined,
    };
  }
  return null;
}

export interface KnownApp {
  client: string;
  path: string;
}

/** The apps MCP Hub knows how to import from. Pure data: no files are touched. */
export function knownApps(): KnownApp[] {
  return candidatePaths().map(({ client, path }) => ({ client, path }));
}

export { pointsAtHub } from "./hub-entry.js";

/** Reads other apps' config files. Pass `only` to read a single app. */
export function scanClientConfigs(existingIds: Set<string>, only?: string): ImportSource[] {
  const results: ImportSource[] = [];
  for (const c of candidatePaths()) {
    if (only && c.client !== only) continue;
    if (!existsSync(c.path)) continue;
    let json: Raw;
    try {
      const content = readFileSync(c.path, "utf-8").replace(/^\uFEFF/, "");
      if (c.format === "toml") {
        const read = readCodexServers(content);
        if (read.error) continue;
        json = { mcpServers: read.servers };
      } else {
        // Apps like VS Code and Cursor allow comments and trailing commas in these files.
        const errors: ParseError[] = [];
        const parsed = parse(content, errors, { allowTrailingComma: true });
        if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        json = parsed;
      }
    } catch {
      continue;
    }
    const maps: Raw[] = [];
    if (json.mcpServers) maps.push(json.mcpServers);
    if (json.servers) maps.push(json.servers);
    if (c.shape === "claude-code") for (const p of Object.values<Raw>(json.projects ?? {})) if (p?.mcpServers) maps.push(p.mcpServers);

    const seen = new Set<string>();
    const servers: ImportCandidate[] = [];
    for (const map of maps) {
      for (const [name, raw] of Object.entries<Raw>(map)) {
        if (seen.has(name)) continue;
        // Shown so it is clear they are already migrated, but never offered for import.
        if (pointsAtHub(raw)) {
          seen.add(name);
          servers.push({ name, viaHub: true });
          continue;
        }
        const cfg = toServerConfig(name, unwrapOpRun(raw));
        if (!cfg) continue;
        seen.add(name);
        // Avoid colliding with servers already in the hub.
        let id = cfg.id;
        for (let i = 2; existingIds.has(id); i++) id = `${cfg.id}-${i}`;
        servers.push({ name, config: { ...cfg, id } });
      }
    }
    if (servers.length) results.push({ client: c.client, path: c.path, servers });
  }
  return results;
}
