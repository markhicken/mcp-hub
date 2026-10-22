import { existsSync } from "node:fs";
import { run } from "./exec.js";

/**
 * Where a command is on this machine, found the way a person would: `where.exe` on Windows, `which` elsewhere, using the
 * environment the hub gives its servers (so the same PATH, including one refreshed from the registry). Returns the full
 * path, or null if the command isn't found. `platform` and `runner` are parameters so each platform's handling can be tested anywhere.
 */
export async function findCommand(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  runner: typeof run = run,
  exists: (p: string) => boolean = existsSync,
): Promise<string | null> {
  // The name goes straight to the tool as an argument; nothing that isn't a plain command name is looked up.
  if (!/^[\w.+-]+$/.test(name)) return null;
  const win = platform === "win32";
  try {
    const { stdout } = await runner(win ? "where.exe" : "which", [name], { timeoutMs: 10_000, env });
    const found = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && exists(l));
    // `where` lists every match (op, op.exe, op.cmd…): something Windows can run beats an extensionless script.
    const rank = (l: string) => (/\.exe$/i.test(l) ? 0 : /\.(cmd|bat)$/i.test(l) ? 1 : 2);
    return (win ? [...found].sort((a, b) => rank(a) - rank(b))[0] : found[0]) ?? null;
  } catch {
    return null;
  }
}
