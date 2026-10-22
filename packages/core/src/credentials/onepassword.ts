import { run, ExecError } from "./exec.js";
import { CredentialError, type CredentialProvider, type ProviderFactory } from "./types.js";

const DENIED_RE = /(cancel|dismiss|denied|declined|not authori[sz]ed|authorization (prompt|was)|operation not permitted|data from other apps)/i;
const NOT_FOUND_RE = /(isn't an item|could not be found|not found|no item|isn't a vault|invalid secret reference)/i;
const APP_DOWN_RE = /(desktop app|cannot connect to 1Password app|make sure it is running|app is locked)/i;
const NOT_SIGNED_IN_RE = /(not signed in|no accounts? (configured|found)|sign in)/i;

/** `op` prefixes its errors with `[ERROR] 2026/10/21 23:40:35 `; the person reading the message doesn't need that. */
export const tidyOpError = (stderr: string): string =>
  stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[ERROR\]\s+\d{4}\/\d\d\/\d\d\s+\d\d:\d\d:\d\d\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);

const APP_DOWN_MESSAGE = "The 1Password app isn't running or is locked. Open and unlock it, then test again.";
const NO_ACCOUNT_MESSAGE = "No 1Password account is connected to the CLI. In the 1Password app open Settings → Developer and turn on “Integrate with 1Password CLI” (or run `op account add`), then test again.";

type Runner = typeof run;

/**
 * Is the 1Password CLI usable? `op whoami` only works once a session exists, and with the app integration that is not until
 * the first approval, so "account is not signed in" doesn't mean something is wrong. When that's the answer, ask `op account list`:
 * it works without a session and says why when it can't (the app isn't running, or no account is connected).
 */
export async function checkOnePassword(opPath: string, account: string | undefined, env: NodeJS.ProcessEnv, runner: Runner = run): Promise<{ ok: boolean; message: string }> {
  const withAccount = (args: string[]) => (account ? [...args, "--account", account] : args);
  try {
    await runner(opPath, withAccount(["whoami", "--format", "json"]), { timeoutMs: 30_000, env });
    return { ok: true, message: "Signed in to 1Password" };
  } catch (err) {
    if (!(err instanceof ExecError)) return { ok: false, message: String(err) };
    if (err.code === "ENOENT") return { ok: false, message: "1Password CLI (op) not found" };
    if (APP_DOWN_RE.test(err.stderr)) return { ok: false, message: APP_DOWN_MESSAGE };
    if (!NOT_SIGNED_IN_RE.test(err.stderr)) return { ok: false, message: tidyOpError(err.stderr) || err.message };
  }
  try {
    const { stdout } = await runner(opPath, ["account", "list", "--format", "json"], { timeoutMs: 30_000, env });
    const accounts = JSON.parse(stdout || "[]") as Array<{ email?: string; url?: string }>;
    if (!Array.isArray(accounts) || accounts.length === 0) return { ok: false, message: NO_ACCOUNT_MESSAGE };
    const names = accounts.map((a) => a.email || a.url).filter(Boolean).join(", ");
    return { ok: true, message: `1Password is available${names ? ` (${names})` : ""}. The 1Password app will ask you to approve the first time a secret is read` };
  } catch (err) {
    if (err instanceof ExecError) {
      if (APP_DOWN_RE.test(err.stderr)) return { ok: false, message: APP_DOWN_MESSAGE };
      if (NOT_SIGNED_IN_RE.test(err.stderr)) return { ok: false, message: NO_ACCOUNT_MESSAGE };
      return { ok: false, message: tidyOpError(err.stderr) || err.message };
    }
    return { ok: false, message: NO_ACCOUNT_MESSAGE };
  }
}

/**
 * Options:
 *  - opPath: path to the `op` CLI (default "op")
 *  - account: optional --account value
 *  - allowedVaults: optional comma separated vault names; other vaults are refused
 */
export const createOnePasswordProvider: ProviderFactory = (source, deps): CredentialProvider => {
  const opPath = source.options.opPath || "op";
  const account = source.options.account;
  const allowed = (source.options.allowedVaults ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    source,
    async resolve(ref) {
      if (allowed.length) {
        const vault = decodeURIComponent(ref.slice("op://".length).split("/")[0] ?? "").toLowerCase();
        if (!allowed.includes(vault)) {
          throw new CredentialError(`Vault "${vault}" is not allowed by this source`, "invalid");
        }
      }
      const args = ["read", "--no-newline", ref];
      if (account) args.push("--account", account);
      try {
        const { stdout } = await run(opPath, args, { timeoutMs: 90_000, env: deps.env });
        return stdout;
      } catch (err) {
        if (err instanceof ExecError) {
          if (err.code === "ENOENT") {
            throw new CredentialError("1Password CLI (op) was not found. Open Credentials in MCP Hub for install steps.", "unavailable");
          }
          if (err.timedOut) throw new CredentialError("Timed out waiting for 1Password", "unavailable");
          if (DENIED_RE.test(err.stderr)) throw new CredentialError("1Password access was denied or dismissed", "denied");
          if (NOT_FOUND_RE.test(err.stderr)) throw new CredentialError(err.stderr || "Item not found", "not-found");
          throw new CredentialError(err.stderr || err.message, "unavailable");
        }
        throw err;
      }
    },
    async test() {
      return checkOnePassword(opPath, account, deps.env);
    },
  };
};
