import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { renameWithRetry } from "./atomic-write.js";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, getNodeValue, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser";
import { addCodexServer, migrateCodexText, readCodexServers } from "./codex.js";
import { candidatePaths, pointsAtHub, type ClientConfigFile } from "./import.js";
import { slugify } from "./store.js";

export type InstallStatus = "added" | "replaced" | "already" | "conflict" | "no-file" | "error";

export interface InstallResult {
  client: string;
  path: string;
  status: InstallStatus;
  message: string;
  /** Copy of the file as it was before it was changed. */
  backup?: string;
  /** The config file didn't exist and was created for this install. */
  created?: boolean;
}

/** An entry already in an app's config that is the same MCP as the one being installed. */
export interface ExistingEntry {
  key: string;
  /** What it does, without arguments, headers or anything else that could hold a secret. */
  summary: string;
}

/** What installing would do to one app's config file, worked out without changing anything. */
export interface InstallPreview {
  client: string;
  path: string;
  status: "add" | "replace" | "already" | "conflict" | "no-file" | "error";
  message: string;
  /** The entries that would be replaced (status "replace"). */
  existing: ExistingEntry[];
}

type Raw = Record<string, any>;

/** The entry that makes an app launch the MCP Hub bridge for one server. */
export function bridgeEntry(client: string, bridge: { command: string; args: string[] }, serverId: string): Raw {
  const base = { command: bridge.command, args: [...bridge.args, serverId] };
  if (client === "GitHub Copilot CLI") return { type: "local", ...base, tools: ["*"] };
  if (client === "VS Code") return { type: "stdio", ...base };
  return base;
}

/** Where an app reaches the hub's HTTP endpoint directly (no bridge, no approval); `token` is set when the hub requires one. */
export interface HttpTarget {
  url: string;
  token?: string;
}

/** The entry that makes an app talk to one server over the hub's HTTP endpoint instead of the bridge. */
export function httpEntry(client: string, http: HttpTarget): Raw {
  const headers = http.token ? { Authorization: `Bearer ${http.token}` } : undefined;
  switch (client) {
    // Claude Desktop only launches local programs; mcp-remote turns the URL into one.
    case "Claude Desktop":
      return {
        command: "npx",
        args: ["-y", "mcp-remote", http.url, "--allow-http", ...(headers ? ["--header", "Authorization:${MCP_HUB_AUTH}"] : [])],
        ...(headers ? { env: { MCP_HUB_AUTH: headers.Authorization } } : {}),
      };
    case "ChatGPT / Codex":
      return { url: http.url, ...(headers ? { http_headers: headers } : {}) };
    case "Cursor":
      return { url: http.url, ...(headers ? { headers } : {}) };
    case "GitHub Copilot CLI":
      return { type: "http", url: http.url, ...(headers ? { headers } : {}), tools: ["*"] };
    default:
      return { type: "http", url: http.url, ...(headers ? { headers } : {}) };
  }
}

/** The entry to install: the bridge, or the direct HTTP endpoint when `http` is given. */
function entryFor(client: string, bridge: { command: string; args: string[] }, serverId: string, http?: HttpTarget): Raw {
  return http ? httpEntry(client, http) : bridgeEntry(client, bridge, serverId);
}

export interface EditOutcome {
  status: "added" | "already" | "conflict" | "error";
  text?: string;
  message: string;
}

function detectFormat(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = /^([ \t]+)\S/m.exec(text)?.[1];
  if (!indented) return { insertSpaces: true, tabSize: 2, eol };
  if (indented.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  // The smallest indent in the file is one level.
  const sizes = [...text.matchAll(/^( +)\S/gm)].map((m) => m[1]!.length);
  return { insertSpaces: true, tabSize: Math.min(...sizes), eol };
}

interface Fmt {
  eol: string;
  unit: string;
}

const lineStart = (text: string, offset: number): number => text.lastIndexOf("\n", offset - 1) + 1;
const leadingWs = (text: string, offset: number): string => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];

/** `"name": value`, with the value's later lines indented to sit under `indent`. */
function propertyText(name: string, value: unknown, fmt: Fmt, indent: string): string {
  const body = JSON.stringify(value, null, fmt.unit).replace(/\n/g, fmt.eol + indent);
  return `${JSON.stringify(name)}: ${body}`;
}

/**
 * Pure insertions that add one property to an object node, matching the surrounding style.
 * Nothing that is already in the file is rewritten (apart from adding the comma it needs).
 */
function insertProperty(text: string, obj: Node, name: string, value: unknown, fmt: Fmt): Edit[] {
  const props = obj.children ?? [];
  const objEnd = obj.offset + obj.length;
  if (!props.length) {
    const inner = text.slice(obj.offset + 1, objEnd - 1);
    const base = leadingWs(text, obj.offset);
    const indent = base + fmt.unit;
    const prop = propertyText(name, value, fmt, indent);
    // Only whitespace is replaced; if there are comments inside, they stay in front of the new property.
    return inner.trim() === ""
      ? [{ offset: obj.offset + 1, length: inner.length, content: fmt.eol + indent + prop + fmt.eol + base }]
      : [{ offset: obj.offset + 1, length: 0, content: fmt.eol + indent + prop + "," }];
  }

  const last = props[props.length - 1]!;
  const lastEnd = last.offset + last.length;
  const multiline = text.slice(obj.offset, props[0]!.offset).includes("\n");
  const trailing = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*,/.exec(text.slice(lastEnd, objEnd - 1));
  const afterLast = trailing ? lastEnd + trailing[0].length : lastEnd;

  // The rest of the last property's line must be blank or a comment, otherwise fall back to an inline insert.
  const nl = text.indexOf("\n", afterLast);
  const lineEnd = nl < 0 ? text.length : nl > 0 && text[nl - 1] === "\r" ? nl - 1 : nl;
  const restIsBlank = /^[ \t]*(?:\/\/.*|\/\*.*?\*\/[ \t]*)?$/.test(text.slice(afterLast, lineEnd));

  if (multiline && restIsBlank && lineEnd <= objEnd) {
    const indent = leadingWs(text, last.offset);
    const prop = propertyText(name, value, fmt, indent);
    if (trailing) return [{ offset: lineEnd, length: 0, content: fmt.eol + indent + prop + "," }];
    if (lineEnd === lastEnd) return [{ offset: lastEnd, length: 0, content: "," + fmt.eol + indent + prop }];
    return [
      { offset: lastEnd, length: 0, content: "," },
      { offset: lineEnd, length: 0, content: fmt.eol + indent + prop },
    ];
  }
  return [{ offset: afterLast, length: 0, content: `${trailing ? " " : ", "}${JSON.stringify(name)}: ${JSON.stringify(value)}${trailing ? "," : ""}` }];
}

/** Does this entry run the MCP Hub bridge for `serverId`? */
function isHubEntryFor(raw: unknown, serverId: string): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Raw;
  if (!pointsAtHub(r)) return false;
  const args: unknown[] = Array.isArray(r.args) ? r.args : [];
  const viaUrl = (v: unknown): boolean => typeof v === "string" && v.endsWith(`/mcp/${serverId}`);
  return args[args.length - 1] === serverId || viaUrl(r.url) || args.some(viaUrl);
}

/**
 * Adds `entry` under `key.serverId` in a JSON (or JSON-with-comments) config by editing the text in
 * place. Everything else in the file, including comments, ordering, indentation and line endings,
 * is left exactly as it was. Does nothing if the hub's version is already there.
 */
export function addServerToConfig(input: string, key: string, serverId: string, entry: Raw): EditOutcome {
  const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = input.slice(bom.length);
  const errors: ParseError[] = [];
  const empty = text.trim() === "";
  const root = empty ? {} : parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !root || typeof root !== "object" || Array.isArray(root)) {
    return { status: "error", message: "The config file isn't a JSON object, so it was left alone." };
  }
  const map = (root as Raw)[key];
  if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map))) {
    return { status: "error", message: `"${key}" in the config file isn't an object, so it was left alone.` };
  }

  let sibling: string | undefined;
  for (const [k, v] of Object.entries((map ?? {}) as Raw)) {
    if (k === serverId) {
      return isHubEntryFor(v, serverId)
        ? { status: "already", message: "Already set up to use MCP Hub." }
        : { status: "conflict", message: `A different server named "${serverId}" is already there. Remove or rename it, then install again.` };
    }
    if (isHubEntryFor(v, serverId)) return { status: "already", message: `Already set up to use MCP Hub (as "${k}").` };
    if (!sibling && slugify(k) === serverId) sibling = k;
  }

  let next: string;
  if (empty) {
    next = JSON.stringify({ [key]: { [serverId]: entry } }, null, 2) + "\n";
  } else {
    const f = detectFormat(text);
    const fmt: Fmt = { eol: f.eol, unit: f.insertSpaces ? " ".repeat(f.tabSize) : "\t" };
    const rootNode = parseTree(text, [], { allowTrailingComma: true })!;
    const mapNode = rootNode.children?.find((c) => c.children?.[0]?.value === key)?.children?.[1];
    const edits = mapNode ? insertProperty(text, mapNode, serverId, entry, fmt) : insertProperty(text, rootNode, key, { [serverId]: entry }, fmt);
    next = applyEdits(text, edits);
  }

  // Safety net: the only difference may be the new entry.
  const errors2: ParseError[] = [];
  const after = parse(next, errors2, { allowTrailingComma: true });
  const expected = { ...(root as Raw), [key]: { ...((map ?? {}) as Raw), [serverId]: entry } };
  if (errors2.length || !isDeepStrictEqual(after, expected)) {
    return { status: "error", message: "The edit didn't come out as expected, so the file was left alone." };
  }

  const note = sibling ? ` Your original "${sibling}" entry is still there; remove it to avoid a duplicate.` : "";
  return { status: "added", text: bom + next, message: `Added. Restart the app to pick it up.${note}` };
}

/** Writes through symlinks, keeps the file's permissions, and replaces it atomically. */
function writeInPlace(path: string, text: string): void {
  const real = realpathSync(path);
  const mode = statSync(real).mode & 0o777;
  const tmp = join(dirname(real), `.${Date.now()}.mcp-hub.tmp`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameWithRetry(tmp, real);
}

const KEEP_BACKUPS = 10;
let backupSeq = 0;

/**
 * Copies a config file to a sibling, `<file>.mcp-hub-backup-<time>`, before it is changed. The copy has the
 * same permissions as the original (configs can hold tokens). Keeps the newest few per file.
 */
export function backupFile(path: string): string {
  const real = realpathSync(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${basename(real)}.mcp-hub-backup-`;
  const dest = join(dirname(real), `${prefix}${stamp}-${String(++backupSeq % 10000).padStart(4, "0")}`);
  copyFileSync(real, dest);
  chmodSync(dest, statSync(real).mode & 0o777);
  const dir = dirname(real);
  const old = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // a leftover backup is harmless
    }
  }
  return dest;
}

/** A short, secret-free description of an entry: its command (no arguments) or its URL (no query, credentials or headers). */
function summarize(raw: Raw): string {
  if (typeof raw.url === "string") {
    try {
      const u = new URL(raw.url);
      return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "a remote server";
    }
  }
  if (typeof raw.command === "string") return raw.command;
  return "an unrecognised entry";
}

/** The entries in a config that are the same MCP as `serverId` (same name, or the name it would be given) and aren't the hub's. */
function findExisting(file: ClientConfigFile, text: string, serverId: string): { existing: ExistingEntry[]; error?: string } {
  const found = new Map<string, Raw>();
  const take = (list: unknown): void => {
    if (!list || typeof list !== "object" || Array.isArray(list)) return;
    for (const [key, value] of Object.entries(list as Raw)) {
      if (found.has(key) || !value || typeof value !== "object" || pointsAtHub(value)) continue;
      if (key === serverId || slugify(key) === serverId) found.set(key, value as Raw);
    }
  };
  if (file.format === "toml") {
    const r = readCodexServers(text);
    if (r.error) return { existing: [], error: r.error };
    take(r.servers);
  } else {
    const errors: ParseError[] = [];
    const root = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
    if (text.trim() !== "" && (errors.length || !root || typeof root !== "object" || Array.isArray(root))) return { existing: [] };
    // The same places migrateConfigText reads.
    take(root?.mcpServers);
    take(root?.servers);
    const projects = root?.projects;
    if (projects && typeof projects === "object") for (const p of Object.values(projects as Raw)) take((p as Raw | null)?.mcpServers);
  }
  return { existing: [...found].map(([key, raw]) => ({ key, summary: summarize(raw) })) };
}

interface Plan {
  status: InstallPreview["status"];
  message: string;
  existing: ExistingEntry[];
  before?: string;
  /** What the file becomes if the server is simply added. */
  addText?: string;
  /** The file doesn't exist yet; installing creates it. */
  created?: boolean;
}

const NO_FILE = (file: ClientConfigFile): string =>
  `No config file found.${existsSync(dirname(file.path)) ? "" : " Its folder doesn't exist either, so the app may not be installed."}`;

/** Creates a config file that doesn't exist yet (and its folder), private to the user. Fails if the file appears meanwhile. */
function createConfigFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
}

/**
 * `text` stands in for the file's content, so several servers can be planned one after another before anything is written.
 * With `create`, a missing file is planned as an empty one (installing then creates it); without it a missing file is "no-file".
 */
function planInstall(serverId: string, file: ClientConfigFile, bridge: { command: string; args: string[] }, text?: string, http?: HttpTarget, create = false): Plan {
  const missing = !existsSync(file.path);
  if (missing && !create) return { status: "no-file", message: NO_FILE(file), existing: [] };
  const before = text ?? (missing ? "" : readFileSync(file.path, "utf-8"));
  const entry = entryFor(file.client, bridge, serverId, http);
  const out = file.format === "toml" ? addCodexServer(before, serverId, entry) : addServerToConfig(before, file.key, serverId, entry);
  if (out.status === "already" || out.status === "error") return { status: out.status, message: out.message, existing: [], before };
  const { existing } = findExisting(file, before, serverId);
  if (existing.length) {
    const keys = existing.map((e) => `"${e.key}"`).join(", ");
    return { status: "replace", message: `Already has ${keys}. Installing replaces ${existing.length === 1 ? "it" : "them"} with the MCP Hub version.`, existing, before };
  }
  if (out.status === "conflict") return { status: "conflict", message: out.message, existing: [], before };
  return { status: "add", message: missing ? "The config file will be created with this server in it." : "Will be added.", existing: [], before, addText: out.text, ...(missing ? { created: true } : {}) };
}

/** Works out what installing would do to each chosen app's config, without changing anything. */
export function previewInstall(
  serverId: string,
  clients: string[],
  bridge: { command: string; args: string[] },
  files: ClientConfigFile[] = candidatePaths(),
  options: { http?: HttpTarget; create?: boolean } = {},
): InstallPreview[] {
  return clients.map((client): InstallPreview => {
    const file = files.find((f) => f.client === client);
    if (!file) return { client, path: "", status: "error", message: "Unknown app.", existing: [] };
    try {
      const { status, message, existing } = planInstall(serverId, file, bridge, undefined, options.http, options.create);
      return { client, path: file.path, status, message, existing };
    } catch (err) {
      return { client, path: file.path, status: "error", message: (err as Error).message, existing: [] };
    }
  });
}

/**
 * Adds the hub's version of a server to each chosen app's config. Only touches files for the apps named.
 * An entry that is already there under the same name is left alone unless `replace` is set; then it is
 * swapped for the hub's version under the same key, after the file is backed up. A config file that doesn't
 * exist is only created when `create` is set.
 */
export function installServer(
  serverId: string,
  clients: string[],
  bridge: { command: string; args: string[] },
  files: ClientConfigFile[] = candidatePaths(),
  options: { replace?: boolean; http?: HttpTarget; create?: boolean } = {},
): InstallResult[] {
  return clients.map((client): InstallResult => {
    const file = files.find((f) => f.client === client);
    if (!file) return { client, path: "", status: "error", message: "Unknown app." };
    const done = (status: InstallStatus, message: string, backup?: string, created?: boolean): InstallResult => ({ client, path: file.path, status, message, ...(backup ? { backup } : {}), ...(created ? { created } : {}) });
    try {
      const plan = planInstall(serverId, file, bridge, undefined, options.http, options.create);
      const step = applyPlan(plan, file, bridge, serverId, options.replace === true, options.http);
      if (step.text === undefined) return done(step.status, step.message);
      if (plan.created) {
        // Nothing to back up. The file is only created if it still isn't there.
        try {
          createConfigFile(file.path, step.text);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return done("error", "The file appeared while installing. Try again.");
          throw err;
        }
        return done(step.status, "Created the config file and added the server. Restart the app to pick it up.", undefined, true);
      }
      // Keep a copy of the file as it is now. If that fails, nothing is changed.
      const backup = backupFile(file.path);
      // The app may be writing this file too; don't clobber a change that landed meanwhile.
      if (readFileSync(file.path, "utf-8") !== plan.before) return done("error", "The file changed while installing. Try again.");
      writeInPlace(file.path, step.text);
      return done(step.status, step.message, backup);
    } catch (err) {
      return done("error", (err as Error).message);
    }
  });
}

/** What one plan turns into: the new file text if it can go ahead, otherwise why not. */
function applyPlan(plan: Plan, file: ClientConfigFile, bridge: { command: string; args: string[] }, serverId: string, replace: boolean, http?: HttpTarget): { status: InstallStatus; message: string; text?: string } {
  if (plan.status === "add") return { status: "added", message: "Added. Restart the app to pick it up.", text: plan.addText! };
  if (plan.status === "replace" && replace) {
    const entry = entryFor(file.client, bridge, serverId, http);
    const swap = Object.fromEntries(plan.existing.map((e) => [e.key, entry]));
    const out = file.format === "toml" ? migrateCodexText(plan.before!, swap) : migrateConfigText(plan.before!, swap);
    const why = out.skipped.map((s) => s.reason).join(" ");
    if (out.error) return { status: "error", message: out.error };
    if (!out.text) return { status: "conflict", message: `Couldn't replace it. ${why}`.trim() };
    return { status: "replaced", message: `Replaced ${out.migrated.map((k) => `"${k}"`).join(", ")}. Restart the app to pick it up.${why ? ` ${why}` : ""}`, text: out.text };
  }
  return plan.status === "replace"
    ? { status: "conflict", message: `${plan.message} Confirm the replacement to continue.` }
    : { status: plan.status as InstallStatus, message: plan.message };
}

export interface ServerInstallPreview {
  serverId: string;
  status: InstallPreview["status"];
  message: string;
  existing: ExistingEntry[];
}

export interface ServerInstallResult {
  serverId: string;
  status: InstallStatus;
  message: string;
}

/** Works out what installing several servers into one app would do, without changing anything. */
export function previewInstallServers(
  serverIds: string[],
  client: string,
  bridge: { command: string; args: string[] },
  files: ClientConfigFile[] = candidatePaths(),
  options: { create?: boolean } = {},
): { client: string; path: string; servers: ServerInstallPreview[] } {
  const file = files.find((f) => f.client === client);
  if (!file) return { client, path: "", servers: serverIds.map((serverId) => ({ serverId, status: "error", message: "Unknown app.", existing: [] })) };
  return {
    client,
    path: file.path,
    servers: serverIds.map((serverId): ServerInstallPreview => {
      try {
        const { status, message, existing } = planInstall(serverId, file, bridge, undefined, undefined, options.create);
        return { serverId, status, message, existing };
      } catch (err) {
        return { serverId, status: "error", message: (err as Error).message, existing: [] };
      }
    }),
  };
}

/**
 * Adds several servers to one app's config in a single edit: the file is read once, backed up once
 * and written once, so a failure leaves it untouched and one backup holds the original. A config file that
 * doesn't exist is only created when `create` is set (then there is nothing to back up).
 */
export function installServers(
  serverIds: string[],
  client: string,
  bridge: { command: string; args: string[] },
  files: ClientConfigFile[] = candidatePaths(),
  options: { replace?: boolean; create?: boolean } = {},
): { client: string; path: string; backup?: string; created?: boolean; servers: ServerInstallResult[] } {
  const file = files.find((f) => f.client === client);
  const all = (status: InstallStatus, message: string): ServerInstallResult[] => serverIds.map((serverId) => ({ serverId, status, message }));
  if (!file) return { client, path: "", servers: all("error", "Unknown app.") };
  try {
    const missing = !existsSync(file.path);
    if (missing && !options.create) return { client, path: file.path, servers: all("no-file", NO_FILE(file)) };
    const original = missing ? "" : readFileSync(file.path, "utf-8");
    let text = original;
    const servers = serverIds.map((serverId): ServerInstallResult => {
      try {
        const step = applyPlan(planInstall(serverId, file, bridge, text, undefined, options.create), file, bridge, serverId, options.replace === true);
        if (step.text !== undefined) text = step.text;
        return { serverId, status: step.status, message: step.message };
      } catch (err) {
        return { serverId, status: "error", message: (err as Error).message };
      }
    });
    if (text === original) return { client, path: file.path, servers };
    if (missing) {
      try {
        createConfigFile(file.path, text);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return { client, path: file.path, servers: all("error", "The file appeared while installing. Try again.") };
        throw err;
      }
      return { client, path: file.path, created: true, servers };
    }
    const backup = backupFile(file.path);
    if (readFileSync(file.path, "utf-8") !== original) return { client, path: file.path, servers: all("error", "The file changed while installing. Try again.") };
    writeInPlace(file.path, text);
    return { client, path: file.path, backup, servers };
  } catch (err) {
    return { client, path: file.path, servers: all("error", (err as Error).message) };
  }
}

// ------------------------------------------------------------------ migrating existing entries

export interface MigrateOutcome {
  text?: string;
  migrated: string[];
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

/**
 * Replaces existing entries with MCP Hub ones, keeping each entry's key. Apps name their tools after the key,
 * so keeping it means tool names don't change. `plan` maps an entry's key to the entry that should replace it.
 * Only the replaced values change; the rest of the file is left as it is.
 * Copies of a key in other places (Claude Code keeps per-project lists) are replaced too, but only if they
 * are identical to the first copy; a different one is left and reported.
 */
export function migrateConfigText(input: string, plan: Record<string, Raw>): MigrateOutcome {
  const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = input.slice(bom.length);
  const errors: ParseError[] = [];
  const rootNode = parseTree(text, errors, { allowTrailingComma: true });
  const root = rootNode && getNodeValue(rootNode);
  if (errors.length || !rootNode || !root || typeof root !== "object" || Array.isArray(root)) {
    return { migrated: [], skipped: [], error: "The config file isn't a JSON object, so it was left alone." };
  }

  // Every object in the file that lists servers, in the order the scan reads them.
  const prop = (obj: Node | undefined, name: string): Node | undefined => obj?.children?.find((c) => c.children?.[0]?.value === name);
  const lists: Array<{ path: string[]; node: Node }> = [];
  for (const k of ["mcpServers", "servers"]) {
    const v = prop(rootNode, k)?.children?.[1];
    if (v?.type === "object") lists.push({ path: [k], node: v });
  }
  const projects = prop(rootNode, "projects")?.children?.[1];
  for (const p of projects?.type === "object" ? (projects.children ?? []) : []) {
    const v = prop(p.children?.[1], "mcpServers")?.children?.[1];
    if (v?.type === "object") lists.push({ path: ["projects", String(p.children?.[0]?.value), "mcpServers"], node: v });
  }

  const f = detectFormat(text);
  const fmt: Fmt = { eol: f.eol, unit: f.insertSpaces ? " ".repeat(f.tabSize) : "\t" };
  const edits: Edit[] = [];
  const migrated = new Set<string>();
  const skipped: MigrateOutcome["skipped"] = [];
  const expected = JSON.parse(JSON.stringify(root)) as Raw;
  const reference = new Map<string, unknown>();

  for (const list of lists) {
    for (const entry of list.node.children ?? []) {
      const name = String(entry.children?.[0]?.value);
      const valueNode = entry.children?.[1];
      const replacement = plan[name];
      if (!replacement || !valueNode) continue;
      const current = getNodeValue(valueNode);
      if (pointsAtHub(current)) continue;
      if (!reference.has(name)) reference.set(name, current);
      if (!isDeepStrictEqual(current, reference.get(name))) {
        skipped.push({ name, reason: `Another "${name}" in this file is different from the first one, so it was left as it is.` });
        continue;
      }
      const startsLine = text.slice(lineStart(text, entry.offset), entry.offset).trim() === "";
      const indent = leadingWs(text, entry.offset);
      const body = startsLine ? JSON.stringify(replacement, null, fmt.unit).replace(/\n/g, fmt.eol + indent) : JSON.stringify(replacement);
      edits.push({ offset: valueNode.offset, length: valueNode.length, content: body });
      let target: Raw = expected;
      for (const step of list.path) target = target[step];
      target[name] = replacement;
      migrated.add(name);
    }
  }
  if (!edits.length) return { migrated: [], skipped };

  const next = applyEdits(text, edits);
  const errors2: ParseError[] = [];
  const after = parse(next, errors2, { allowTrailingComma: true });
  if (errors2.length || !isDeepStrictEqual(after, expected)) {
    return { migrated: [], skipped, error: "The edit didn't come out as expected, so the file was left alone." };
  }
  return { text: bom + next, migrated: [...migrated], skipped };
}

export interface MigrateResult extends InstallResult {
  migrated: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** Rewrites one app's config so the listed entries (key -> hub server id) run through MCP Hub. Backs the file up first. */
export function migrateClientConfig(
  client: string,
  plan: Record<string, string>,
  bridge: { command: string; args: string[] },
  files: ClientConfigFile[] = candidatePaths(),
): MigrateResult {
  const file = files.find((f) => f.client === client);
  const fail = (status: InstallStatus, message: string, extra: Partial<MigrateResult> = {}): MigrateResult => ({ client, path: file?.path ?? "", status, message, migrated: [], skipped: [], ...extra });
  if (!file) return fail("error", "Unknown app.");
  if (!existsSync(file.path)) return fail("no-file", "No config file found.");
  try {
    const before = readFileSync(file.path, "utf-8");
    const entries = Object.fromEntries(Object.entries(plan).map(([name, id]) => [name, bridgeEntry(client, bridge, id)]));
    const out = file.format === "toml" ? migrateCodexText(before, entries) : migrateConfigText(before, entries);
    if (out.error) return fail("error", out.error);
    if (!out.text) return fail("already", "Nothing to change: those entries already use MCP Hub.", { skipped: out.skipped });
    const backup = backupFile(file.path);
    if (readFileSync(file.path, "utf-8") !== before) return fail("error", "The file changed while migrating. Try again.");
    writeInPlace(file.path, out.text);
    return { client, path: file.path, status: "added", message: "Migrated. Restart the app to pick it up.", backup, migrated: out.migrated, skipped: out.skipped };
  } catch (err) {
    return fail("error", (err as Error).message);
  }
}
