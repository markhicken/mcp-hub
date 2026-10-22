import { execFile } from "node:child_process";
import { runPowerShell } from "./powershell.js";

/** A process as the Windows process table (CIM `Win32_Process`) describes it. */
export interface WinProc {
  pid: number;
  ppid: number;
  /** Executable path; the bare image name for system processes that have no path. */
  command: string;
  /** Full command line (may be empty for protected processes). */
  cmdline: string;
  /** Creation time as Windows file time (100 ns ticks since 1601), as a string: tells a reused pid apart. */
  started: string;
}

const CIM_SCRIPT = `
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    name = $_.Name
    exe = $_.ExecutablePath
    cmd = $_.CommandLine
    started = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' })
  }
})
ConvertTo-Json -InputObject $rows -Compress
`;

/** Parses the JSON the CIM script prints (an array, or a bare object when there is a single process). */
export function parseWindowsProcesses(json: string): Map<number, WinProc> {
  const map = new Map<number, WinProc>();
  let rows: unknown;
  try {
    rows = JSON.parse(json.replace(/^\uFEFF/, ""));
  } catch {
    return map;
  }
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const o = r as { pid?: unknown; ppid?: unknown; name?: unknown; exe?: unknown; cmd?: unknown; started?: unknown } | null;
    if (!o || !Number.isInteger(o.pid) || !Number.isInteger(o.ppid)) continue;
    const exe = typeof o.exe === "string" ? o.exe : "";
    const name = typeof o.name === "string" ? o.name : "";
    map.set(o.pid as number, {
      pid: o.pid as number,
      ppid: o.ppid as number,
      command: exe || name,
      cmdline: typeof o.cmd === "string" ? o.cmd : "",
      started: typeof o.started === "string" ? o.started : "",
    });
  }
  return map;
}

export interface SnapshotOptions {
  /** Ignore the cached table (needed to see what a process started a moment ago). */
  fresh?: boolean;
  maxAgeMs?: number;
  /** Replaces PowerShell (tests). */
  run?: (script: string) => Promise<string>;
  now?: () => number;
}

let cache: { at: number; map: Map<number, WinProc> } | undefined;
let inflight: Promise<Map<number, WinProc>> | undefined;

/**
 * Every process on the machine, from one CIM query. PowerShell takes about a second to start, so the table is cached
 * for a couple of seconds and concurrent callers share one query. Empty if PowerShell can't run (then nothing is touched).
 */
export function windowsProcesses(opts: SnapshotOptions = {}): Promise<Map<number, WinProc>> {
  const now = (opts.now ?? Date.now)();
  if (!opts.fresh && cache && now - cache.at <= (opts.maxAgeMs ?? 2000)) return Promise.resolve(cache.map);
  if (inflight && !opts.fresh) return inflight;
  const run = opts.run ?? ((s: string) => runPowerShell(s, { timeoutMs: 20_000 }));
  const p: Promise<Map<number, WinProc>> = run(CIM_SCRIPT)
    .then((out) => {
      const map = parseWindowsProcesses(out);
      if (map.size) cache = { at: (opts.now ?? Date.now)(), map };
      return map;
    })
    .catch(() => new Map<number, WinProc>())
    .finally(() => {
      if (inflight === p) inflight = undefined;
    });
  if (!opts.fresh) inflight = p;
  return p;
}

/** Forgets the cached table (tests). */
export function resetWindowsProcessCache(): void {
  cache = undefined;
  inflight = undefined;
}

/**
 * One process by pid. A pid missing from a cached table is looked up again (it may have started since), but at most
 * once every half second so a chain that ends at an exited parent doesn't query again and again.
 */
export async function windowsProcess(pid: number, opts: SnapshotOptions = {}): Promise<WinProc | null> {
  let map = await windowsProcesses(opts);
  const hit = map.get(pid);
  if (hit) return hit;
  const age = cache ? (opts.now ?? Date.now)() - cache.at : Infinity;
  if (age > 500) {
    map = await windowsProcesses({ ...opts, fresh: true });
    return map.get(pid) ?? null;
  }
  return null;
}

/** `pid`'s descendants in a process table (not `pid` itself); empty if `pid` isn't in the table. */
export function descendantsInTable(table: ReadonlyMap<number, { ppid: number }>, pid: number): number[] {
  if (!table.has(pid)) return [];
  const found: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length) {
    const p = queue.pop()!;
    for (const [child, info] of table) {
      if (info.ppid === p && !seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/** Ends a process and everything it started. `taskkill /T` walks the tree itself, so children that are already listed go too. */
export function taskkillTree(pids: number[]): Promise<void> {
  return new Promise((resolve) => {
    if (!pids.length) return resolve();
    const args = pids.flatMap((p) => ["/PID", String(p)]);
    execFile("taskkill.exe", ["/T", "/F", ...args], { windowsHide: true, timeout: 15_000 }, () => resolve());
  });
}
