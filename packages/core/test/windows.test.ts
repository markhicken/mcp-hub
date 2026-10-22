import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync, renameWithRetry } from "../src/atomic-write.js";
import { KeyStoreError, windowsCredentialManager, windowsKeyStore, type KeyStore } from "../src/credentials/keystore.js";
import { NOT_FOUND, keychainTargets } from "../src/credentials/wincred.js";
import { pointsAtHub } from "../src/hub-entry.js";
import { toServerConfig, unwrapCmdShell } from "../src/import.js";
import { isPipePath, socketPath } from "../src/paths.js";
import { encodePowerShell, explainPowerShellFailure, plainPowerShellError } from "../src/powershell.js";
import { descendantsInTable, parseWindowsProcesses, resetWindowsProcessCache, windowsProcess, windowsProcesses } from "../src/proc.js";
import { combinePaths, mergeEnv, parseRegPath } from "../src/system.js";

// Everything here takes the platform (or a fake PowerShell) as input, so it runs the same on macOS, Linux and Windows.

const tmp = () => mkdtempSync(join(tmpdir(), "mcp-hub-win-"));
const errno = (code: string) => Object.assign(new Error(code), { code });

describe("atomic writes", () => {
  it("retries a rename Windows briefly refuses, then succeeds", () => {
    let calls = 0;
    const waits: number[] = [];
    renameWithRetry("a", "b", {
      platform: "win32",
      rename: () => {
        if (++calls < 3) throw errno("EPERM");
      },
      wait: (ms) => waits.push(ms),
    });
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("falls back to copying when the destination stays locked", () => {
    const dir = tmp();
    const from = join(dir, "x.tmp");
    const to = join(dir, "x.json");
    writeFileSync(from, "new");
    writeFileSync(to, "old");
    renameWithRetry(from, to, { platform: "win32", attempts: 2, rename: () => { throw errno("EBUSY"); }, wait: () => {} });
    expect(readFileSync(to, "utf-8")).toBe("new");
    expect(existsSync(from)).toBe(false);
  });

  it("does not retry elsewhere, nor errors that aren't about locking", () => {
    let calls = 0;
    expect(() => renameWithRetry("a", "b", { platform: "darwin", rename: () => { calls++; throw errno("EPERM"); } })).toThrow();
    expect(calls).toBe(1);
    expect(() => renameWithRetry("a", "b", { platform: "win32", rename: () => { throw errno("ENOENT"); }, wait: () => {} })).toThrow(/ENOENT/);
  });

  it("writes through a temporary file", () => {
    const file = join(tmp(), "data.json");
    atomicWriteFileSync(file, "one", { mode: 0o600 });
    atomicWriteFileSync(file, "two", { mode: 0o600 });
    expect(readFileSync(file, "utf-8")).toBe("two");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("the Windows process table", () => {
  beforeEach(() => resetWindowsProcessCache());

  const json = JSON.stringify([
    { pid: 10, ppid: 1, name: "claude.exe", exe: "C:\\Apps\\claude.exe", cmd: '"C:\\Apps\\claude.exe" --x', started: "133000000000000000" },
    { pid: 11, ppid: 10, name: "node.exe", exe: null, cmd: null, started: "" },
    { pid: 12, ppid: 11, name: "node.exe", exe: "C:\\node.exe", cmd: "node a.js", started: "1" },
    { pid: "bad", ppid: 1 },
  ]);

  it("reads CIM output, including a lone process and missing fields", () => {
    const table = parseWindowsProcesses(json);
    expect([...table.keys()]).toEqual([10, 11, 12]);
    expect(table.get(10)).toMatchObject({ ppid: 1, command: "C:\\Apps\\claude.exe", cmdline: '"C:\\Apps\\claude.exe" --x' });
    expect(table.get(11)).toMatchObject({ command: "node.exe", cmdline: "" });
    expect(parseWindowsProcesses(JSON.stringify({ pid: 5, ppid: 4, name: "System" })).get(5)?.command).toBe("System");
    expect(parseWindowsProcesses("not json").size).toBe(0);
  });

  it("finds descendants, and nothing for a pid that isn't in the table", () => {
    const table = parseWindowsProcesses(json);
    expect(descendantsInTable(table, 10).sort()).toEqual([11, 12]);
    expect(descendantsInTable(table, 99)).toEqual([]);
  });

  it("asks PowerShell once for concurrent and quick repeat lookups, again when forced or stale", async () => {
    let queries = 0;
    let now = 1000;
    const run = async () => (queries++, json);
    await Promise.all([windowsProcesses({ run, now: () => now }), windowsProcesses({ run, now: () => now })]);
    await windowsProcesses({ run, now: () => (now += 1000) });
    expect(queries).toBe(1);
    await windowsProcesses({ run, now: () => (now += 5000) });
    expect(queries).toBe(2);
    await windowsProcesses({ run, now: () => now, fresh: true });
    expect(queries).toBe(3);
  });

  it("looks a missing pid up again, but not on every miss", async () => {
    let queries = 0;
    let now = 1000;
    const run = async () => (queries++, json);
    expect(await windowsProcess(12, { run, now: () => now })).toMatchObject({ pid: 12 });
    now += 10;
    expect(await windowsProcess(999, { run, now: () => now })).toBeNull();
    expect(queries).toBe(1); // the table was only 10 ms old
    now += 2000;
    expect(await windowsProcess(999, { run, now: () => now })).toBeNull();
    expect(queries).toBe(2);
  });
});

describe("PowerShell scripts", () => {
  it("are sent as UTF-16LE base64 so no quoting can break them", () => {
    const script = "Write-Output 'héllo \"quoted\"'";
    const decoded = Buffer.from(encodePowerShell(script), "base64").toString("utf16le");
    expect(decoded.endsWith(script)).toBe(true);
  });

  it("turns PowerShell's CLIXML error report back into text", () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Cannot invoke method &lt;x&gt;._x000D__x000A_</S><S S="Error">At line:3 char:1_x000D__x000A_</S></Objs>';
    expect(plainPowerShellError(clixml)).toBe("Cannot invoke method <x>.\r\nAt line:3 char:1");
    expect(explainPowerShellFailure(clixml)).toMatch(/Constrained Language Mode/);
    expect(explainPowerShellFailure("plain failure\nmore")).toBe("plain failure");
  });
});

describe("the master key on Windows", () => {
  const key = Buffer.alloc(32, 7);
  const memory = (name: string, opts: { fail?: boolean; saved?: Buffer | null } = {}): KeyStore & { saved: Buffer | null } => {
    const s = { name, saved: opts.saved ?? null, read: () => (opts.fail ? (() => { throw new KeyStoreError("blocked"); })() : s.saved), write: (k: Buffer) => { if (opts.fail) throw new KeyStoreError("blocked"); s.saved = k; } };
    return s;
  };

  it("sends the key on stdin, never in the script or the environment", () => {
    const seen: Array<{ script: string; input?: string; env?: Record<string, string> }> = [];
    const store = windowsCredentialManager((script, input, env) => {
      seen.push({ script, input, env });
      return "";
    });
    store.write(key);
    const b64 = key.toString("base64");
    expect(seen[0]!.input).toBe(b64);
    expect(seen[0]!.script).not.toContain(b64);
    expect(JSON.stringify(seen[0]!.env)).not.toContain(b64);
  });

  it("reads the key back, and treats a missing credential as no key yet", () => {
    expect(windowsCredentialManager(() => key.toString("base64")).read()?.equals(key)).toBe(true);
    const missing = windowsCredentialManager(() => {
      throw Object.assign(new KeyStoreError("not found"), { notFound: true });
    });
    expect(missing.read()).toBeNull();
    expect(NOT_FOUND).toBe(3);
  });

  it("refuses a saved key that isn't 32 bytes", () => {
    expect(() => windowsCredentialManager(() => "AAAA").read()).toThrow(/32 bytes/);
  });

  it("uses Credential Manager when it works", () => {
    const credman = memory("Windows Credential Manager");
    const dpapi = memory("Windows DPAPI");
    const store = windowsKeyStore("dir", { credman, dpapi });
    expect(store.read()).toBeNull();
    store.write(key);
    expect(credman.saved).toEqual(key);
    expect(dpapi.saved).toBeNull();
    expect(store.name).toBe("Windows Credential Manager");
  });

  it("falls back to the DPAPI file when Credential Manager can't be used, and reads it back", () => {
    const credman = memory("Windows Credential Manager", { fail: true });
    const dpapi = memory("Windows DPAPI");
    const store = windowsKeyStore("dir", { credman, dpapi });
    expect(store.read()).toBeNull(); // nothing saved yet: a new key may be made
    store.write(key);
    expect(dpapi.saved).toEqual(key);
    expect(store.name).toBe("Windows DPAPI");
    expect(windowsKeyStore("dir", { credman, dpapi }).read()).toEqual(key);
  });

  it("reports a broken store when there is no fallback", () => {
    expect(() => windowsKeyStore(undefined, { credman: memory("Windows Credential Manager", { fail: true }) }).read()).toThrow(/blocked/);
  });
});

describe("keychain:// on Windows", () => {
  it("tries the service name, then service/account and service:account when an account is given", () => {
    expect(keychainTargets("svc", "")).toEqual(["svc"]);
    expect(keychainTargets("svc", "me")).toEqual(["svc", "svc/me", "svc:me"]);
  });
});

describe("the local socket name", () => {
  it("is an unguessable named pipe on Windows and a file elsewhere", () => {
    const a = socketPath("C:\\data", "win32");
    expect(isPipePath(a)).toBe(true);
    expect(a).toMatch(/^\\\\\.\\pipe\\mcp-hub-[0-9a-f]{32}$/);
    expect(socketPath("C:\\data", "win32")).not.toBe(a);
    expect(isPipePath(socketPath("/tmp/x", "darwin"))).toBe(false);
  });
});

describe("environments on Windows", () => {
  it("merges variable names without regard to case, keeping the first spelling", () => {
    expect(mergeEnv({ Path: "a", SystemRoot: "C:\\Windows" }, { PATH: "b", extra: "1" }, "win32")).toEqual({ Path: "b", SystemRoot: "C:\\Windows", extra: "1" });
    expect(mergeEnv({ Path: "a" }, { PATH: "b" }, "darwin")).toEqual({ Path: "a", PATH: "b" });
  });

  it("reads PATH from `reg query` output and combines machine, user and current entries without repeats", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools\r\n";
    expect(parseRegPath(out)).toBe("%USERPROFILE%\\bin;C:\\Tools");
    expect(parseRegPath("nothing here")).toBe("");
    const combined = combinePaths("C:\\Windows;C:\\Tools", parseRegPath(out), "c:\\windows;D:\\Old", { USERPROFILE: "C:\\Users\\me" });
    expect(combined).toBe("C:\\Windows;C:\\Tools;C:\\Users\\me\\bin;D:\\Old");
  });
});

describe("importing Windows app entries", () => {
  it("drops the `cmd /c` wrapper around npx", () => {
    expect(unwrapCmdShell({ command: "cmd", args: ["/c", "npx", "-y", "@acme/server"] })).toMatchObject({ command: "npx", args: ["-y", "@acme/server"] });
    expect(unwrapCmdShell({ command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "npx -y server"] })).toMatchObject({ command: "npx", args: ["-y", "server"] });
    expect(toServerConfig("x", { command: "cmd", args: ["/c", "npx", "-y", "srv"] })).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "srv"] });
  });

  it("leaves shell syntax and other programs alone", () => {
    const piped = { command: "cmd", args: ["/c", "npx a | more"] };
    expect(unwrapCmdShell(piped)).toBe(piped);
    const other = { command: "node", args: ["/c", "x"] };
    expect(unwrapCmdShell(other)).toBe(other);
  });

  it("sees through `cmd /c npx mcp-remote` to the HTTP server", () => {
    expect(toServerConfig("remote", { command: "cmd", args: ["/c", "npx", "-y", "mcp-remote", "https://example.com/mcp"] })).toMatchObject({ transport: "http", url: "https://example.com/mcp" });
  });

  it("recognises hub entries written with Windows paths", () => {
    expect(pointsAtHub({ command: "C:\\Users\\me\\Repositories\\mcp-hub\\packages\\shim\\src\\shim.mjs" })).toBe(true);
    expect(pointsAtHub({ command: "C:\\Program Files\\MCP Hub\\mcp-hub-stdio.exe" })).toBe(true);
    expect(pointsAtHub({ command: "npx", args: ["-y", "something"] })).toBe(false);
  });
});
