import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { taskkillTree, windowsProcesses } from "./proc.js";

interface Entry {
  pid: number;
  /** The program the hub started, used to make sure a recycled pid isn't mistaken for it. */
  command: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function read(path: string): Entry[] {
  try {
    const list = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(list) ? list.filter((e): e is Entry => !!e && Number.isInteger((e as Entry).pid) && typeof (e as Entry).command === "string") : [];
  } catch {
    return [];
  }
}

/** Every process on the machine as pid -> {ppid, command}. `ps` on macOS/Linux, one CIM query on Windows. */
async function processes(): Promise<Map<number, { ppid: number; command: string }>> {
  const map = new Map<number, { ppid: number; command: string }>();
  if (process.platform === "win32") {
    // Fresh: what a server started a moment ago must show up. The command is the program plus its arguments.
    for (const [pid, p] of await windowsProcesses({ fresh: true })) map.set(pid, { ppid: p.ppid, command: `${p.command} ${p.cmdline}` });
    return map;
  }
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) map.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! });
    }
  } catch {
    // no ps: nothing can be checked, so nothing is touched
  }
  return map;
}

/** `pid` and everything it started, found from the process table (without `pid` itself). Empty if the table can't be read. */
export async function descendantsOf(pid: number): Promise<number[]> {
  const all = await processes();
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.pop()!;
    if (found.includes(p)) continue;
    found.push(p);
    for (const [child, info] of all) if (info.ppid === p) queue.push(child);
  }
  return all.has(pid) ? found.slice(1) : [];
}

/**
 * Stops processes a server left behind after it was stopped (the real server behind a wrapper, helpers it forked).
 * Polite first, then forced for any that ignore it. Windows has no polite signal, so each is ended with its own tree.
 */
export async function stopLeftovers(pids: number[], grace = 2000): Promise<void> {
  const live = pids.filter(alive);
  if (!live.length) return;
  if (process.platform === "win32") return taskkillTree(live);

  const send = (sig: NodeJS.Signals) => {
    for (const pid of live.filter(alive)) {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  send("SIGTERM");
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && live.some(alive)) await new Promise((r) => setTimeout(r, 50));
  send("SIGKILL");
}

/**
 * Remembers the stdio servers the hub started, so that if the hub is killed without a chance to stop them
 * (a crash, `kill -9`, a power cut) the next start can find and stop the leftovers.
 * The file holds only pids and program names.
 */
export class ChildRegistry {
  constructor(private path: string) {}

  add(pid: number, command: string): void {
    const kept = read(this.path).filter((e) => e.pid !== pid && alive(e.pid));
    this.save([...kept, { pid, command }]);
  }

  /** Forgets servers that have exited. */
  prune(): void {
    this.save(read(this.path).filter((e) => alive(e.pid)));
  }

  private save(list: Entry[]): void {
    try {
      if (!list.length) return rmSync(this.path, { force: true });
      writeFileSync(this.path, JSON.stringify(list), { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      // best effort: this is a safety net, never a reason to stop a server from starting
    }
  }

  /**
   * Stops servers left running by a previous hub that died. A pid is only touched if it still runs the
   * program that was recorded; its child processes (an `npx` wrapper's real server) go with it.
   * Returns how many processes were stopped.
   */
  async sweep(grace = 1500): Promise<number> {
    const entries = read(this.path);
    rmSync(this.path, { force: true });
    if (!entries.length) return 0;
    const all = await processes();
    const targets = new Set<number>();
    for (const e of entries) {
      const p = all.get(e.pid);
      if (!p || !p.command.includes(e.command)) continue;
      const queue = [e.pid];
      while (queue.length) {
        const pid = queue.pop()!;
        if (targets.has(pid)) continue;
        targets.add(pid);
        for (const [child, info] of all) if (info.ppid === pid) queue.push(child);
      }
    }
    if (process.platform === "win32") {
      await taskkillTree([...targets]);
      return targets.size;
    }
    const signal = (sig: NodeJS.Signals) => {
      for (const pid of targets) {
        try {
          process.kill(pid, sig);
        } catch {
          // already gone
        }
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + grace;
    while (Date.now() < deadline && [...targets].some(alive)) await new Promise((r) => setTimeout(r, 50));
    signal("SIGKILL");
    return targets.size;
  }
}
