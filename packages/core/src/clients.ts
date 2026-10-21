import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { AppStore } from "./app-store.js";

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
  /** Which app this is across restarts (its bundle or program), as opposed to `id`, which is one running copy. */
  identity: string;
  /** The decision is saved and applies again whenever the app comes back. */
  remembered: boolean;
  /** The app is running now. A remembered app that isn't is listed so it can still be changed or removed. */
  running: boolean;
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
  /** Stable across restarts: the .app bundle, or the program (and script) for a command-line tool. */
  identity: string;
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
  let identity: string;
  if (app) {
    while (i + 1 < chain.length && appBundle(chain[i + 1]!.command) === app) i++;
    name = basename(app, ".app");
    path = app;
    identity = `app:${app}`;
  } else if (RUNTIMES.has(exeName(path))) {
    const cmd = await args(chain[i]!.pid);
    const script = cmd.split(/\s+/).slice(1).find((a) => !a.startsWith("-")) ?? "";
    const pkg = [...script.matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)/g)].pop()?.[1];
    name = pkg ?? (script ? basename(script) : basename(path));
    identity = `bin:${path}|${pkg ?? script}`;
  } else {
    name = basename(path);
    identity = `bin:${path}`;
  }
  const top = chain[i]!;
  return { key: `${top.pid}:${top.started}`, name, pid: top.pid, path, identity };
}

/** The code-signing identity of an app bundle, or "" when it has none that can be relied on (unsigned, ad hoc, no codesign). */
export type SignerLookup = (bundlePath: string) => Promise<string>;

export const codesignSigner: SignerLookup = (bundle) =>
  new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve("");
    // codesign describes the signature on stderr.
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], { timeout: 5000 }, (_err, _out, stderr) => {
      const text = String(stderr);
      const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
      const id = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
      resolve(team && team !== "not set" ? `${id ?? ""}|${team}` : "");
    });
  });

export interface GateOptions {
  lookup?: ProcLookup;
  args?: ArgsLookup;
  /** How long a request waits for the user before it is told approval is still pending. */
  waitMs?: number;
  alive?: (pid: number) => boolean;
  sweepMs?: number;
  /** Where remembered apps are kept. Without it every decision lasts only until the app quits. */
  file?: string;
  /** Reads an app's code-signing identity (tests replace it). */
  signer?: SignerLookup;
}

export type Verdict = { status: "allowed" | "denied" | "pending"; client?: ClientInfo; reason?: string };

const SAVED_PREFIX = "saved:";

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
 * Per-app approval for clients that connect over the local socket. One decision covers every connection the app
 * opens. By default it is remembered (in `apps.json`) and applies again whenever the same app comes back, until the
 * user changes or removes it; a decision made without "remember" lasts only until the app quits.
 * Events: "change" (list changed), "pending" (a new app is waiting for a decision), "decided" (the user answered; carries
 * the app, its previous status and whether it was remembered), "restored" (a remembered app came back and its saved
 * decision applied), "mismatch" (an app is at a remembered app's path but isn't signed the same, so it is asked about
 * again), "removed" (the user removed an app; carries the app and the ids of its running copies), "gone" (an app quit;
 * carries its id, name and status).
 */
export class ClientGate extends EventEmitter {
  private readonly clients = new Map<string, ClientInfo>();
  private readonly byPid = new Map<number, string>();
  private readonly resolving = new Map<number, Promise<string | null>>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly signers = new Map<string, string>();
  private readonly store?: AppStore;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: GateOptions = {}) {
    super();
    if (opts.file) this.store = new AppStore(opts.file);
    this.timer = setInterval(() => this.sweep(), opts.sweepMs ?? 5000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    for (const list of this.waiters.values()) list.forEach((w) => w());
    this.waiters.clear();
  }

  /** Apps running now, then remembered apps that aren't (so they can still be changed or removed). */
  list(): ClientInfo[] {
    const live = [...this.clients.values()].map(copy);
    const running = new Set(live.map((c) => c.identity));
    const idle = (this.store?.list() ?? [])
      .filter((a) => !running.has(a.identity))
      .map(
        (a): ClientInfo => ({
          id: `${SAVED_PREFIX}${a.identity}`,
          name: a.name,
          pid: 0,
          path: a.path,
          status: a.status,
          since: a.savedAt,
          lastSeen: a.lastSeen,
          requests: 0,
          servers: [],
          allowed: a.allowed,
          identity: a.identity,
          remembered: true,
          running: false,
        }),
      );
    return [...live, ...idle];
  }

  private identify(pid: number): Promise<string | null> {
    const known = this.byPid.get(pid);
    if (known && this.clients.has(known)) return Promise.resolve(known);
    let p = this.resolving.get(pid);
    if (!p) {
      p = resolveClient(pid, this.opts.lookup, this.opts.args)
        .then(async (r) => {
          if (!r) return null;
          if (!this.clients.has(r.key)) {
            const now = Date.now();
            const signer = r.identity.startsWith("app:") ? await (this.opts.signer ?? codesignSigner)(r.path) : "";
            const info: ClientInfo = { id: r.key, name: r.name, pid: r.pid, path: r.path, status: "pending", since: now, lastSeen: now, requests: 0, servers: [], allowed: null, identity: r.identity, remembered: false, running: true };
            // Another connection from the same app may have registered it while the signature was being read.
            if (!this.clients.has(r.key)) {
              this.signers.set(r.key, signer);
              const saved = this.store?.get(r.identity);
              if (saved && saved.signer === signer) {
                info.status = saved.status;
                info.allowed = saved.allowed;
                info.remembered = true;
                this.store?.touch(r.identity, { name: r.name, path: r.path, lastSeen: now });
                this.clients.set(r.key, info);
                this.emit("restored", copy(info));
              } else {
                this.clients.set(r.key, info);
                if (saved) this.emit("mismatch", copy(info));
                this.emit("pending", { ...info });
              }
              this.emit("change");
            }
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

  /**
   * `servers` limits what an allowed app may use; leave it out (or null) to allow every server.
   * `remember` (the default) saves the decision for the app itself, so it applies again after the app restarts;
   * without it the decision lasts until the app quits. An id from `list()` for an app that isn't running changes
   * its saved decision.
   */
  decide(id: string, allow: boolean, servers: string[] | null = null, remember = true): boolean {
    const chosen = allow && servers ? [...new Set(servers)] : null;
    if (id.startsWith(SAVED_PREFIX)) {
      const saved = this.store?.get(id.slice(SAVED_PREFIX.length));
      if (!saved) return false;
      this.store!.upsert({ ...saved, status: allow ? "allowed" : "denied", allowed: chosen });
      this.emit("decided", { ...this.list().find((c) => c.id === id)!, running: false }, saved.status, true);
      this.emit("change");
      return true;
    }
    const c = this.clients.get(id);
    if (!c) return false;
    const before = c.status;
    const persist = remember && !!this.store;
    // Every running copy of the same app gets the same answer when it is remembered.
    const same = persist ? [...this.clients.values()].filter((x) => x.identity === c.identity) : [c];
    for (const x of same) {
      x.status = allow ? "allowed" : "denied";
      x.allowed = chosen ? [...chosen] : null;
      x.remembered = persist;
    }
    if (this.store) {
      if (persist) {
        const now = Date.now();
        this.store.upsert({ identity: c.identity, name: c.name, path: c.path, status: c.status as "allowed" | "denied", allowed: c.allowed, signer: this.signers.get(c.id) ?? "", savedAt: now, lastSeen: now });
      } else {
        this.store.delete(c.identity);
      }
    }
    this.emit("decided", copy(c), before, persist);
    for (const x of same) {
      for (const w of this.waiters.get(x.id) ?? []) w();
      this.waiters.delete(x.id);
    }
    this.emit("change");
    return true;
  }

  /**
   * Forget an app completely: its saved decision goes, and if it is running it is dropped from the list, so the next
   * time it connects it has to be allowed again. Returns false if there is no such app.
   */
  remove(id: string): boolean {
    let identity: string;
    let gone: ClientInfo[];
    if (id.startsWith(SAVED_PREFIX)) {
      identity = id.slice(SAVED_PREFIX.length);
      gone = [];
      const saved = this.store?.get(identity);
      if (!saved) return false;
      this.emit("removed", { ...this.list().find((c) => c.id === id)!, running: false }, []);
    } else {
      const c = this.clients.get(id);
      if (!c) return false;
      identity = c.identity;
      gone = [...this.clients.values()].filter((x) => x.identity === identity);
      this.emit("removed", copy(c), gone.map((x) => x.id));
    }
    this.store?.delete(identity);
    for (const c of gone) this.drop(c.id);
    this.emit("change");
    return true;
  }

  private drop(id: string): void {
    this.clients.delete(id);
    this.signers.delete(id);
    for (const [pid, k] of this.byPid) if (k === id) this.byPid.delete(pid);
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }

  private sweep(): void {
    const alive = this.opts.alive ?? pidAlive;
    let changed = false;
    for (const c of [...this.clients.values()]) {
      if (alive(c.pid)) continue;
      if (c.remembered) this.store?.touch(c.identity, { name: c.name, path: c.path, lastSeen: c.lastSeen });
      this.drop(c.id);
      this.emit("gone", c.id, c.name, c.status);
      changed = true;
    }
    if (changed) this.emit("change");
  }
}
