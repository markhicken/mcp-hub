import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { vi } from "vitest";

// Tests must never reach the real 1Password CLI, Vault CLI or OS keychain: that would pop approval prompts and
// make results depend on the machine. Fakes in test/fixtures or a temp directory are fine.
const SECRET_TOOLS = new Set(["op", "vault", "security", "secret-tool", "powershell", "pwsh", "which", "where"]);
const allowedDirs = [join(import.meta.dirname, "fixtures"), tmpdir()].map((d) => resolve(d));

// Config locations that an app lets the user move must not leak from the real environment into tests, which point
// the home folder at a temporary one: a stray COPILOT_HOME would make a test read or write the developer's real config.
for (const name of ["COPILOT_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

// Tests point the home directory at a temp folder with `process.env.HOME`. Windows' `os.homedir()` reads USERPROFILE
// instead, so follow HOME there too; elsewhere this is what `homedir()` already does.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => (process.platform === "win32" && process.env.HOME ? process.env.HOME : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("../src/credentials/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/credentials/exec.js")>();
  return {
    ...actual,
    run: (file: string, args: string[], opts?: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => {
      const tool = basename(file).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
      const fake = isAbsolute(file) && allowedDirs.some((d) => resolve(file).startsWith(d));
      if (SECRET_TOOLS.has(tool) && !fake) return Promise.reject(new actual.ExecError(`spawn ${file} ENOENT (blocked: tests may not run the real ${tool})`, "", "ENOENT", false));
      return actual.run(file, args, opts);
    },
  };
});
