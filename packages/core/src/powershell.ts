import { execFile } from "node:child_process";

export class PowerShellError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

const PRELUDE = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n";

/** `-EncodedCommand` takes UTF-16LE base64, which sidesteps every quoting problem a multi-line `-Command` has. */
export const encodePowerShell = (script: string): string => Buffer.from(PRELUDE + script, "utf16le").toString("base64");

export function powerShellArgs(script: string, opts: { sta?: boolean } = {}): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(opts.sta ? ["-STA"] : []), "-EncodedCommand", encodePowerShell(script)];
}

/** With `-EncodedCommand`, PowerShell reports errors on stderr as CLIXML (`<S S="Error">text_x000D__x000A_</S>`); this gives the text back. */
export function plainPowerShellError(stderr: string): string {
  if (!stderr.startsWith("#< CLIXML")) return stderr;
  const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  return [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)]
    .map((m) => m[1]!.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => entities[e]!))
    .join("")
    .trim();
}

/** Constrained Language Mode / AppLocker blocks `Add-Type` and .NET method calls; say so plainly. */
export function explainPowerShellFailure(stderr: string): string {
  const text = plainPowerShellError(stderr);
  if (/constrained language|language mode|not allowed in this language mode|Cannot invoke method|Add-Type.*(block|disabled|not allowed)/i.test(text)) {
    return "PowerShell is running in Constrained Language Mode (an administrator policy), which blocks this";
  }
  return text.trim().split(/\r?\n/)[0]?.slice(0, 200) || "PowerShell failed";
}

/**
 * Runs a PowerShell script (Windows PowerShell 5.1, present on every supported Windows). Values the script needs, such
 * as secrets, go in `env` or on `input` (stdin), never in the script text or the command line.
 */
export function runPowerShell(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; sta?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      powerShellArgs(script, opts),
      { timeout: opts.timeoutMs ?? 30_000, env: opts.env ? { ...process.env, ...opts.env } : undefined, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") return reject(new PowerShellError("PowerShell isn't available"));
        reject(new PowerShellError(e.killed ? "PowerShell timed out" : explainPowerShellFailure(String(stderr) || e.message), String(stderr)));
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}
