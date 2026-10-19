import { run, ExecError } from "./exec.js";
import { CredentialError, type CredentialProvider, type ProviderFactory } from "./types.js";

const DENIED_RE = /(cancel|dismiss|denied|declined|not authori[sz]ed|authorization (prompt|was)|operation not permitted|data from other apps)/i;
const NOT_FOUND_RE = /(isn't an item|could not be found|not found|no item|isn't a vault|invalid secret reference)/i;

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
      try {
        const args = ["whoami", "--format", "json"];
        if (account) args.push("--account", account);
        await run(opPath, args, { timeoutMs: 30_000, env: deps.env });
        return { ok: true, message: "Signed in to 1Password" };
      } catch (err) {
        if (err instanceof ExecError) {
          if (err.code === "ENOENT") return { ok: false, message: "1Password CLI (op) not found" };
          return { ok: false, message: err.stderr || "Not signed in. Unlock the 1Password app or run `op signin`." };
        }
        return { ok: false, message: String(err) };
      }
    },
  };
};
