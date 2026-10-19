import { run, ExecError } from "./exec.js";
import { CredentialError, type ProviderFactory } from "./types.js";

const WIN_SCRIPT = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class HubCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string t, int type, int flags, out IntPtr p);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string t) {
    IntPtr p; if (!CredRead(t, 1, 0, out p)) throw new Exception("not found");
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(p); }
  }
}
'@
[Console]::Out.Write([HubCred]::Read($env:HUB_TARGET))
`;

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
        const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], {
          timeoutMs: 30_000,
          env: { ...deps.env, HUB_TARGET: service },
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
