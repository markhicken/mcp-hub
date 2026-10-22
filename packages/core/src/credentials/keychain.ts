import { run, ExecError } from "./exec.js";
import { powerShellArgs } from "../powershell.js";
import { CredentialError, type ProviderFactory } from "./types.js";
import { NOT_FOUND, READ_KEYCHAIN_SCRIPT, keychainTargets } from "./wincred.js";
function parseRef(ref: string): { service: string; account: string } {
  const rest = ref.slice("keychain://".length);
  const i = rest.indexOf("/");
  const service = decodeURIComponent(i < 0 ? rest : rest.slice(0, i));
  const account = i < 0 ? "" : decodeURIComponent(rest.slice(i + 1));
  if (!service) throw new CredentialError("keychain reference needs a service: keychain://service/account", "invalid");
  return { service, account };
}

/**
 * keychain://service/account
 *  - macOS: generic password in the login keychain
 *  - Linux: libsecret (`secret-tool lookup service S account A`)
 *  - Windows: Credential Manager generic credential whose target name is the service
 */
export const createKeychainProvider: ProviderFactory = (source, deps) => ({
  source,
  async resolve(ref) {
    const { service, account } = parseRef(ref);
    try {
      if (process.platform === "darwin") {
        const args = ["find-generic-password", "-s", service, "-w"];
        if (account) args.splice(3, 0, "-a", account);
        const { stdout } = await run("security", args, { timeoutMs: 60_000, env: deps.env });
        return stdout.replace(/\r?\n$/, "");
      }
      if (process.platform === "win32") {
        const { stdout } = await run("powershell.exe", powerShellArgs(READ_KEYCHAIN_SCRIPT), {
          timeoutMs: 30_000,
          env: { ...deps.env, HUB_SERVICE: service, HUB_ACCOUNT: account, HUB_TARGETS: keychainTargets(service, account).join("\n") },
        });
        return stdout;
      }
      const args = ["lookup", "service", service];
      if (account) args.push("account", account);
      const { stdout } = await run("secret-tool", args, { timeoutMs: 60_000, env: deps.env });
      return stdout.replace(/\r?\n$/, "");
    } catch (err) {
      if (err instanceof ExecError) {
        if (err.code === "ENOENT") throw new CredentialError("Keychain tool not available on this system", "unavailable");
        if (process.platform === "win32" && err.code === NOT_FOUND) throw new CredentialError(`No keychain entry for ${service}${account ? "/" + account : ""}`, "not-found");
        if (/could not be found|not found|SecKeychainSearchCopyNext/i.test(err.stderr + err.message)) {
          throw new CredentialError(`No keychain entry for ${service}${account ? "/" + account : ""}`, "not-found");
        }
        if (/User canceled|denied|cancel/i.test(err.stderr)) throw new CredentialError("Keychain access was denied", "denied");
        throw new CredentialError(err.stderr || err.message, "unavailable");
      }
      throw err;
    }
  },
  async test() {
    const tool = process.platform === "darwin" ? "security" : process.platform === "win32" ? "powershell.exe" : "secret-tool";
    try {
      await run(tool, process.platform === "darwin" ? ["help"] : process.platform === "win32" ? ["-NoProfile", "-Command", "1"] : ["--version"], {
        timeoutMs: 10_000,
      });
      return { ok: true, message: "OS keychain tooling is available" };
    } catch (err) {
      // `security help` exits non-zero on macOS but proves the binary exists.
      if (err instanceof ExecError && err.code !== "ENOENT") return { ok: true, message: "OS keychain tooling is available" };
      return { ok: false, message: `${tool} not found` };
    }
  },
});
