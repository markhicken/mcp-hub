import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { pointsAtHub } from "./hub-entry.js";

type Raw = Record<string, any>;

/**
 * Codex keeps its MCP servers in `~/.codex/config.toml` as `[mcp_servers.<name>]` tables. The ChatGPT desktop
 * app, the Codex CLI and the IDE extension read the same file, so one entry serves them all.
 * Reading uses a TOML parser; changing the file only edits the text of the tables involved, so comments,
 * ordering and everything else stay exactly as they were.
 */

/** A Codex server table in the shape other apps use, so the rest of the importer can treat it alike. */
function toRaw(t: Raw): Raw {
  const out: Raw = {};
  if (t.enabled === false) out.enabled = false;
  if (typeof t.url === "string") {
    out.url = t.url;
    out.type = "http";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((t.http_headers ?? {}) as Raw)) headers[k] = String(v);
    // Codex reads these from the environment when it starts the server; the hub does the same through env://.
    for (const [k, v] of Object.entries((t.env_http_headers ?? {}) as Raw)) headers[k] = `{{env://${String(v)}}}`;
    if (typeof t.bearer_token_env_var === "string") headers.Authorization = `Bearer {{env://${t.bearer_token_env_var}}}`;
    if (Object.keys(headers).length) out.headers = headers;
    return out;
  }
  if (typeof t.command === "string") {
    out.command = t.command;
    if (Array.isArray(t.args)) out.args = t.args.map(String);
    if (t.env && typeof t.env === "object") out.env = Object.fromEntries(Object.entries(t.env as Raw).map(([k, v]) => [k, String(v)]));
    if (typeof t.cwd === "string") out.cwd = t.cwd;
  }
  return out;
}

/** The servers in a Codex config, as generic entries. An unreadable file gives an error and no servers. */
export function readCodexServers(text: string): { servers: Record<string, Raw>; error?: string } {
  try {
    const root = parseToml(text.replace(/^\uFEFF/, "")) as Raw;
    const table = root.mcp_servers;
    if (table === undefined) return { servers: {} };
    if (!table || typeof table !== "object" || Array.isArray(table)) return { servers: {}, error: "mcp_servers in the config isn't a table." };
    const servers: Record<string, Raw> = {};
    for (const [name, t] of Object.entries(table as Raw)) if (t && typeof t === "object" && !Array.isArray(t)) servers[name] = toRaw(t as Raw);
    return { servers };
  } catch (err) {
    return { servers: {}, error: `The config file isn't valid TOML (${(err as Error).message.split("\n")[0]}).` };
  }
}

// ------------------------------------------------------------------ writing

const bareKey = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k: string): string => (bareKey.test(k) ? k : JSON.stringify(k));

/** Strings and arrays are written as JSON (valid TOML); a flat object becomes an inline table. */
function tomlValue(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${JSON.stringify(x)}`).join(", ")} }`;
  return JSON.stringify(v);
}

function tomlTable(name: string, entry: Raw, eol: string): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  for (const [k, v] of Object.entries(entry)) lines.push(`${k} = ${tomlValue(v)}`);
  return lines.join(eol) + eol;
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/** Plain-data copy for comparing parsed files (dates become strings; the parser's own object types don't matter). */
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

export interface CodexEdit {
  status: "added" | "already" | "conflict" | "error";
  text?: string;
  message: string;
}

/** Appends `[mcp_servers.<id>]` for the hub's bridge. Nothing else in the file is touched. */
export function addCodexServer(input: string, serverId: string, entry: Raw): CodexEdit {
  const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = input.slice(bom.length);
  let root: Raw;
  try {
    root = text.trim() ? (parseToml(text) as Raw) : {};
  } catch {
    return { status: "error", message: "The config file isn't valid TOML, so it was left alone." };
  }
  const table = root.mcp_servers;
  if (table !== undefined && (!table || typeof table !== "object" || Array.isArray(table))) {
    return { status: "error", message: "mcp_servers in the config file isn't a table, so it was left alone." };
  }
  for (const [k, t] of Object.entries((table ?? {}) as Raw)) {
    const raw = toRaw((t ?? {}) as Raw);
    const hub = pointsAtHub(raw);
    const lastArg = Array.isArray(raw.args) ? raw.args[raw.args.length - 1] : undefined;
    const isThis = lastArg === serverId || (typeof raw.url === "string" && raw.url.endsWith(`/mcp/${serverId}`));
    if (k === serverId) {
      return hub && isThis
        ? { status: "already", message: "Already set up to use MCP Hub." }
        : { status: "conflict", message: `A different server named "${serverId}" is already there. Remove or rename it, then install again.` };
    }
    if (hub && isThis) return { status: "already", message: `Already set up to use MCP Hub (as "${k}").` };
  }

  const eol = eolOf(text);
  const gap = text.trim() === "" ? "" : (text.endsWith("\n") ? "" : eol) + eol;
  const next = (text.trim() === "" ? "" : text) + gap + tomlTable(serverId, entry, eol);

  // Safety net: the only difference may be the new table.
  let after: Raw;
  try {
    after = parseToml(next) as Raw;
  } catch {
    return { status: "error", message: "The edit didn't come out as expected, so the file was left alone." };
  }
  const expected = { ...root, mcp_servers: { ...((table ?? {}) as Raw), [serverId]: entry } };
  if (!isDeepStrictEqual(norm(after), norm(expected))) return { status: "error", message: "The edit didn't come out as expected, so the file was left alone." };
  return { status: "added", text: bom + next, message: "Added. Restart the app to pick it up." };
}

interface Header {
  start: number;
  path: string[];
  array: boolean;
}

/** `[mcp_servers.foo."bar.baz"]` -> ["mcp_servers","foo","bar.baz"]; null if the line isn't a table header. */
function parseHeader(line: string): { path: string[]; array: boolean } | null {
  let i = 0;
  const ws = () => {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  };
  ws();
  if (line[i] !== "[") return null;
  i++;
  const array = line[i] === "[";
  if (array) i++;
  const path: string[] = [];
  for (;;) {
    ws();
    let key = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          const n = line[i + 1]!;
          key += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else key += line[i++];
      }
      if (line[i] !== '"') return null;
      i++;
    } else if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      key = line.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) return null;
      key = m[0];
      i += key.length;
    }
    path.push(key);
    ws();
    if (line[i] === ".") {
      i++;
      continue;
    }
    break;
  }
  if (line[i] !== "]") return null;
  i++;
  if (array) {
    if (line[i] !== "]") return null;
    i++;
  }
  ws();
  if (i < line.length && line[i] !== "#") return null;
  return { path, array };
}

/** Table headers that start a line at the top level (not inside a string or a multi-line array). */
function scanHeaders(text: string): Header[] {
  const headers: Header[] = [];
  type Mode = "none" | "basic" | "literal" | "mlbasic" | "mlliteral" | "comment";
  let mode: Mode = "none";
  let depth = 0;
  let lineStart = 0;
  let top = true;
  const finishLine = (end: number) => {
    if (top) {
      const h = parseHeader(text.slice(lineStart, end).replace(/\r$/, ""));
      if (h) headers.push({ start: lineStart, ...h });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") {
      finishLine(i);
      lineStart = i + 1;
      if (mode === "comment" || mode === "basic" || mode === "literal") mode = "none";
      top = mode === "none" && depth === 0;
      continue;
    }
    if (mode === "none") {
      if (c === "#") mode = "comment";
      else if (c === '"') {
        if (text.startsWith('"""', i)) {
          mode = "mlbasic";
          i += 2;
        } else mode = "basic";
      } else if (c === "'") {
        if (text.startsWith("'''", i)) {
          mode = "mlliteral";
          i += 2;
        } else mode = "literal";
      } else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    } else if (mode === "basic") {
      if (c === "\\") i++;
      else if (c === '"') mode = "none";
    } else if (mode === "literal") {
      if (c === "'") mode = "none";
    } else if (mode === "mlbasic") {
      if (c === "\\") i++;
      else if (text.startsWith('"""', i)) {
        mode = "none";
        i += 2;
      }
    } else if (mode === "mlliteral") {
      if (text.startsWith("'''", i)) {
        mode = "none";
        i += 2;
      }
    }
  }
  finishLine(text.length);
  return headers;
}

export interface CodexMigrate {
  text?: string;
  migrated: string[];
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

/**
 * Replaces existing `[mcp_servers.<key>]` tables with MCP Hub ones under the same key, so the app's tool names
 * don't change. A table's sub-tables (`.env`, `.http_headers`) go with it. Only those tables change.
 */
export function migrateCodexText(input: string, plan: Record<string, Raw>): CodexMigrate {
  const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = input.slice(bom.length);
  let root: Raw;
  try {
    root = parseToml(text) as Raw;
  } catch {
    return { migrated: [], skipped: [], error: "The config file isn't valid TOML, so it was left alone." };
  }
  const table = root.mcp_servers;
  if (!table || typeof table !== "object" || Array.isArray(table)) return { migrated: [], skipped: [] };

  const eol = eolOf(text);
  const headers = scanHeaders(text);
  const lineEnds = (from: number): number => {
    const nl = text.indexOf("\n", from);
    return nl < 0 ? text.length : nl + 1;
  };
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const migrated: string[] = [];
  const skipped: CodexMigrate["skipped"] = [];
  const expected = JSON.parse(JSON.stringify(root, (_k, v) => (v instanceof Date ? { $date: v.toISOString() } : v))) as Raw;

  for (const [name, replacement] of Object.entries(plan)) {
    const current = (table as Raw)[name];
    if (!current || typeof current !== "object") continue;
    if (pointsAtHub(toRaw(current as Raw))) continue;
    const mine = headers.map((h, i) => ({ h, i })).filter(({ h }) => !h.array && h.path[0] === "mcp_servers" && h.path[1] === name);
    if (!mine.length) {
      skipped.push({ name, reason: `"${name}" is written in a layout MCP Hub can't edit safely (an inline table or dotted keys), so it was left as it is.` });
      continue;
    }
    mine.forEach(({ h, i }, n) => {
      let end = i + 1 < headers.length ? headers[i + 1]!.start : text.length;
      // Blank lines and comments just above the next table belong to it, not to this one.
      while (end > h.start) {
        const prevStart = text.lastIndexOf("\n", end - 2) + 1;
        const line = text.slice(prevStart, end).trim();
        if (prevStart > h.start && (line === "" || line.startsWith("#"))) end = prevStart;
        else break;
      }
      // A removed sub-table also takes the blank line after it (the replacement's own table already has one before the next).
      if (n > 0) {
        for (let m = /^[ \t]*\r?\n/.exec(text.slice(end)); m; m = /^[ \t]*\r?\n/.exec(text.slice(end))) end += m[0].length;
      }
      edits.push({ start: h.start, end: Math.max(end, lineEnds(h.start)), content: n === 0 ? tomlTable(name, replacement, eol) : "" });
    });
    expected.mcp_servers[name] = replacement;
    migrated.push(name);
  }
  if (!edits.length) return { migrated: [], skipped };

  let next = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.content + next.slice(e.end);
  try {
    const after = JSON.parse(JSON.stringify(parseToml(next), (_k, v) => (v instanceof Date ? { $date: v.toISOString() } : v)));
    if (!isDeepStrictEqual(after, expected)) throw new Error("mismatch");
  } catch {
    return { migrated: [], skipped, error: "The edit didn't come out as expected, so the file was left alone." };
  }
  return { text: bom + next, migrated, skipped };
}
