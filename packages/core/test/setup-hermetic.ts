import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { vi } from "vitest";

// Tests must never reach the real 1Password CLI, Vault CLI or OS keychain: that would pop approval prompts and
// make results depend on the machine. Fakes in test/fixtures or a temp directory are fine.
const SECRET_TOOLS = new Set(["op", "vault", "security", "secret-tool", "powershell", "pwsh"]);
const allowedDirs = [join(import.meta.dirname, "fixtures"), tmpdir()].map((d) => resolve(d));

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
