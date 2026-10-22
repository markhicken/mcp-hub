/**
 * Windows Credential Manager access through PowerShell (`advapi32` CredRead/CredWrite), shared by the `keychain://`
 * provider and the master-key store. Scripts are run with `-EncodedCommand` (see powershell.ts); values reach them in
 * environment variables or on stdin, never in the script text or on a command line.
 */

/** Defines `HubCred`: `Read(target)` -> `[userName, secret]` or `$null` when there is no such credential; `Write(target, user, secret)`. */
export const CRED_TYPE = `
Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text;
public static class HubCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string t, int type, int flags, out IntPtr p);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  // Other tools store the secret as UTF-16 (cmdkey, the Windows UI) or as UTF-8 text; UTF-16 text of an ASCII secret has a zero in every second byte.
  static string Decode(byte[] b) {
    if (b.Length >= 2 && b.Length % 2 == 0) {
      bool wide = true;
      for (int i = 1; i < b.Length; i += 2) { if (b[i] != 0) { wide = false; break; } }
      if (wide) return Encoding.Unicode.GetString(b);
    }
    return new UTF8Encoding(false).GetString(b);
  }
  public static string[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new Win32Exception(e); }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return new string[] { c.UserName == null ? "" : c.UserName, Decode(b) };
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
}
'@
`;

/** Exit status the scripts use for "no such credential". */
export const NOT_FOUND = 3;

/**
 * Reads the first credential among the target names in `$env:HUB_TARGETS` (one per line) that matches. The plain service
 * name (`$env:HUB_SERVICE`) must also carry the requested account (`$env:HUB_ACCOUNT`) as its user name when one was asked for.
 * Prints the secret; exits with NOT_FOUND when nothing matches.
 */
export const READ_KEYCHAIN_SCRIPT = `${CRED_TYPE}
foreach ($t in ($env:HUB_TARGETS -split "\`n")) {
  if (-not $t) { continue }
  $r = [HubCred]::Read($t)
  if ($r -eq $null) { continue }
  if ($t -eq $env:HUB_SERVICE -and $env:HUB_ACCOUNT -and $r[0] -ne $env:HUB_ACCOUNT) { continue }
  [Console]::Out.Write($r[1])
  exit 0
}
exit ${NOT_FOUND}
`;

/** The credential targets to try for `keychain://service/account`. */
export function keychainTargets(service: string, account: string): string[] {
  return account ? [service, `${service}/${account}`, `${service}:${account}`] : [service];
}

/** Prints the secret saved under `$env:HUB_TARGET`; exits with NOT_FOUND if there is none. */
export const READ_SECRET_SCRIPT = `${CRED_TYPE}
$r = [HubCred]::Read($env:HUB_TARGET)
if ($r -eq $null) { exit ${NOT_FOUND} }
[Console]::Out.Write($r[1])
`;

/** Saves the secret given on stdin as a credential for this machine and user (it stays across restarts). */
export const WRITE_SECRET_SCRIPT = `${CRED_TYPE}
$secret = [Console]::In.ReadToEnd().Trim()
[HubCred]::Write($env:HUB_TARGET, $env:HUB_USER, $secret)
`;

/** DPAPI (current user): stdin holds base64 bytes, stdout gets the base64 result. */
export const DPAPI_PROTECT_SCRIPT = `Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

export const DPAPI_UNPROTECT_SCRIPT = `Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;
