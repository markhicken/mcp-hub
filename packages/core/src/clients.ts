import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename } from "node:path";

export interface ClientInfo {
  id: string;
  name: string;
  pid: number;
  path: string;
  status: "pending" | "allowed" | "denied";
  since: number;
  lastSeen: number;
  requests: number;
  /** Servers the app has asked for. */
  servers: string[];
  /** Servers it may use: null means every one, including servers added later. */
  allowed: string[] | null;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Start time as printed by ps; distinguishes a reused pid. */
  started: string;
  /** Executable path (ps comm). */
  command: string;
}

export type ProcLookup = (pid: number) => Promise<ProcInfo | null>;
export type ArgsLookup = (pid: number) => Promise<string>;

export const psLookup: ProcLookup = (pid) =>
  new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(String(out).trim());
      resolve(m ? { pid, ppid: Number(m[1]), started: m[2]!.replace(/\s+/g, " "), command: m[3]! } : null);
    });
  });

export const psArgs: ArgsLookup = (pid) =>
  new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 }, (err, out) => resolve(err ? "" : String(out).trim()));
  });

// Shells and launchers sit between an app and the MCP bridge; they are never "the client".
const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh", "env", "login", "sudo", "npx", "npm", "pnpm", "yarn", "uvx", "uv", "pipx", "bunx", "tsx", "nohup", "caffeinate", "tmux", "screen", "script"]);
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "ruby", "java"]);

const exeName = (command: string) => basename(command).replace(/^-/, "").toLowerCase();

/** The outermost .app bundle in an executable path, if any. */
export function appBundle(command: string): string | null {
  const i = command.indexOf(".app/");
  return i < 0 ? null : command.slice(0, i + 4);
}

export interface ResolvedClient {
  key: string;
  name: string;
  pid: number;
  path: string;
}

/**
 * Work out which app owns a bridge process: the nearest ancestor that is not a shell or launcher.
 * Apps (.app bundles) are identified by their topmost process, so every helper they spawn shares one identity.
 */
export async function resolveClient(shimPid: number, lookup: ProcLookup = psLookup, args: ArgsLookup = psArgs): Promise<ResolvedClient | null> {
  const self = await lookup(shimPid);
  if (!self) return null;
  const chain: ProcInfo[] = [];
  for (let next = self.ppid; next > 1 && chain.length < 16; ) {
    const p = await lookup(next);
    if (!p) break;
    chain.push(p);
    next = p.ppid;
  }
  let i = chain.findIndex((p) => !WRAPPERS.has(exeName(p.command)));
  if (i < 0) return null;
  const app = appBundle(chain[i]!.command);
  let name: string;
  let path = chain[i]!.command;
  if (app) {
    while (i + 1 < chain.length && appBundle(chain[i + 1]!.command) === app) i++;
    name = basename(app, ".app");
    path = app;
  } else if (RUNTIMES.has(exeName(path))) {
    const cmd = await args(chain[i]!.pid);
    const script = cmd.split(/\s+/).slice(1).find((a) => !a.startsWith("-")) ?? "";
    const pkg = [...script.matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)/g)].pop()?.[1];
    name = pkg ?? (script ? basename(script) : basename(path));
  } else {
    name = basename(path);
  }
  const top = chain[i]!;
  return { key: `${top.pid}:${top.started}`, name, pid: top.pid, path };
}

export interface GateOptions {
  lookup?: ProcLookup;
  args?: ArgsLookup;
  /** How long a request waits for the user before it is told approval is still pending. */
  waitMs?: number;
  alive?: (pid: number) => boolean;
  sweepMs?: number;
}

export type Verdict = { status: "allowed" | "denied" | "pending"; client?: ClientInfo; reason?: string };

const copy = (c: ClientInfo): ClientInfo => ({ ...c, servers: [...c.servers], allowed: c.allowed ? [...c.allowed] : null });

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Per-app approval for clients that connect over the local socket. One decision covers every
 * connection the app opens, and it lasts until the app quits or the hub restarts. Memory only.
 * Events: "change" (list changed), "pending" (a new app is waiting for a decision), "decided" (the user answered; carries
 * the app and its previous status), "gone" (an app quit; carries its id, name and status).
 */
export class ClientGate extends EventEmitter {
  private readonly clients = new Map<string, ClientInfo>();
  private readonly byPid = new Map<number, string>();
  private readonly resolving = new Map<number, Promise<string | null>>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: GateOptions = {}) {
    super();
    this.timer = setInterval(() => this.sweep(), opts.sweepMs ?? 5000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    for (const list of this.waiters.values()) list.forEach((w) => w());
    this.waiters.clear();
  }

  list(): ClientInfo[] {
    return [...this.clients.values()].map(copy);
  }

  private identify(pid: number): Promise<string | null> {
    const known = this.byPid.get(pid);
    if (known && this.clients.has(known)) return Promise.resolve(known);
    let p = this.resolving.get(pid);
    if (!p) {
      p = resolveClient(pid, this.opts.lookup, this.opts.args)
        .then((r) => {
          if (!r) return null;
          if (!this.clients.has(r.key)) {
            const now = Date.now();
            const info: ClientInfo = { id: r.key, name: r.name, pid: r.pid, path: r.path, status: "pending", since: now, lastSeen: now, requests: 0, servers: [], allowed: null };
            this.clients.set(r.key, info);
            this.emit("pending", { ...info });
            this.emit("change");
          }
          this.byPid.set(pid, r.key);
          return r.key;
        })
        .finally(() => this.resolving.delete(pid));
      this.resolving.set(pid, p);
    }
    return p;
  }

  async authorize(pid: number, serverId: string): Promise<Verdict> {
    const id = await this.identify(pid);
    const c = id ? this.clients.get(id) : undefined;
    if (!id || !c) return { status: "denied", reason: "MCP Hub could not tell which app this connection belongs to." };
    c.lastSeen = Date.now();
    c.requests++;
    if (!c.servers.includes(serverId)) {
      c.servers.push(serverId);
      this.emit("change");
    }
    if (c.status === "pending") {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(id) ?? [];
        list.push(resolve);
        this.waiters.set(id, list);
        setTimeout(resolve, this.opts.waitMs ?? 50_000).unref();
      });
    }
    if (c.status === "allowed" && c.allowed && !c.allowed.includes(serverId)) {
      return { status: "denied", client: copy(c), reason: `${c.name} wasn't given access to this server. Change what it can use in MCP Hub → Settings.` };
    }
    return { status: c.status, client: copy(c) };
  }

  /** `servers` limits what an allowed app may use; leave it out (or null) to allow every server. */
  decide(id: string, allow: boolean, servers: string[] | null = null): boolean {
    const c = this.clients.get(id);
    if (!c) return false;
    const before = c.status;
    c.status = allow ? "allowed" : "denied";
    c.allowed = allow && servers ? [...new Set(servers)] : null;
    this.emit("decided", copy(c), before);
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
    this.emit("change");
    return true;
  }

  private sweep(): void {
    const alive = this.opts.alive ?? pidAlive;
    let changed = false;
    for (const c of [...this.clients.values()]) {
      if (alive(c.pid)) continue;
      this.clients.delete(c.id);
      this.emit("gone", c.id, c.name, c.status);
      for (const [pid, id] of this.byPid) if (id === c.id) this.byPid.delete(pid);
      for (const w of this.waiters.get(c.id) ?? []) w();
      this.waiters.delete(c.id);
      changed = true;
    }
    if (changed) this.emit("change");
  }
}
