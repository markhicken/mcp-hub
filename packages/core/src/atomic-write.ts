import { copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `renameSync` that survives Windows briefly refusing to replace a file: an antivirus scanner or an indexer
 * holds the destination open for a moment and the rename fails with EPERM/EBUSY/EACCES. Elsewhere it is exactly
 * `renameSync`. `platform` and `rename` are parameters so the retry can be tested on any system.
 */
export function renameWithRetry(
  from: string,
  to: string,
  opts: { platform?: NodeJS.Platform; rename?: (a: string, b: string) => void; attempts?: number; delayMs?: number; wait?: (ms: number) => void } = {},
): void {
  const rename = opts.rename ?? renameSync;
  if ((opts.platform ?? process.platform) !== "win32") return rename(from, to);
  const attempts = opts.attempts ?? 8;
  const wait = opts.wait ?? sleep;
  for (let i = 1; ; i++) {
    try {
      return rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code)) throw err;
      if (i >= attempts) {
        // Replacing in place is not atomic, but a save that lands beats one that fails.
        copyFileSync(from, to);
        rmSync(from, { force: true });
        return;
      }
      wait((opts.delayMs ?? 25) * i);
    }
  }
}

/** Writes `data` to a temporary file next to `path`, then moves it into place, so a crash never leaves half a file. */
export function atomicWriteFileSync(path: string, data: string | Uint8Array, opts: { mode?: number; tmp?: string } = {}): void {
  const tmp = opts.tmp ?? `${path}.tmp`;
  writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
  renameWithRetry(tmp, path);
}
