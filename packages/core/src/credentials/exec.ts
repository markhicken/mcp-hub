import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | string | null,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

export function run(
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv } = { timeoutMs: 30_000 },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, env: opts.env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          reject(new ExecError(e.message, String(stderr ?? "").trim(), e.code ?? null, Boolean(e.killed)));
        } else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
