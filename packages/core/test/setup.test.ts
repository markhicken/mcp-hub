import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecError, type run } from "../src/credentials/exec.js";
import { checkOnePassword, tidyOpError } from "../src/credentials/onepassword.js";
import { findCommand } from "../src/credentials/which.js";
import { detectSetup } from "../src/credentials/setup.js";
import { ConfigStore } from "../src/store.js";
import type { SourceConfig } from "../src/types.js";
import { startHub } from "./helpers.js";

const FAKE_OP = join(import.meta.dirname, "fixtures", "fake-op.mjs");
chmodSync(FAKE_OP, 0o755);

const op = (options: Record<string, string> = {}): SourceConfig => ({ id: "1password", type: "1password", name: "1Password", enabled: true, options });

function storeWith(content: unknown) {
  const path = join(mkdtempSync(join(tmpdir(), "mcp-hub-setup-")), "config.json");
  if (content !== undefined) writeFileSync(path, JSON.stringify(content));
  return new ConfigStore(path);
}

describe("automatic credential setup", () => {
  it("adds the keychain on and 1Password off on a fresh install", () => {
    const s = storeWith(undefined);
    expect(s.sources.map((x) => [x.type, x.enabled])).toEqual(expect.arrayContaining([["keychain", true], ["1password", false], ["manual", true], ["env", false]]));
    expect(s.sources.some((x) => x.type === "vault")).toBe(false);
    expect(s.settings.sourcesAutoConfigured).toBe(true);
  });

  it("adds them once to an existing install, never duplicates one you made, and respects a removal", () => {
    const mine = { id: "work-op", type: "1password", name: "Work", enabled: true, options: { account: "work" } };
    const s = storeWith({ version: 1, servers: [], sources: [mine], settings: {} });
    expect(s.sources.filter((x) => x.type === "1password")).toEqual([mine]);
    expect(s.sources.some((x) => x.type === "keychain")).toBe(true);

    // Once set up, removing a source keeps it removed on the next start.
    s.removeSource("keychain");
    s.save();
    expect(new ConfigStore((s as unknown as { path: string }).path).sources.some((x) => x.type === "keychain")).toBe(false);
  });

  // The fake `op` is a shebang script, which Windows can't run directly.
  it.skipIf(process.platform === "win32")("finds the 1Password CLI and reports its version without asking it for a secret", async () => {
    const [st] = await detectSetup([op({ opPath: FAKE_OP })], process.env);
    expect(st).toMatchObject({ ready: true, version: "2.30.0", sourceId: "1password" });
    expect(st!.help).toBeUndefined();
  });

  it("explains how to install the CLI when it is missing", async () => {
    const [st] = await detectSetup([op({ opPath: join(tmpdir(), "definitely-not-op") })], { PATH: "" });
    expect(st).toMatchObject({ ready: false });
    expect(st!.help!.steps.join(" ")).toMatch(/Integrate with 1Password CLI/);
    expect(st!.help!.links[0]!.url).toContain("developer.1password.com");
    if (process.platform === "darwin") expect(st!.help!.commands).toEqual(["brew install --cask 1password-cli"]);
  });

  it("reports the keychain tooling", async () => {
    const statuses = await detectSetup([{ id: "keychain", type: "keychain", name: "OS keychain", enabled: true, options: {} }], process.env);
    expect(statuses).toHaveLength(1);
    if (process.platform === "darwin") expect(statuses[0]).toMatchObject({ ready: true, detail: "macOS Keychain is built in" });
  });

  // The fake `op` is a shebang script, which Windows can't run directly.
  it.skipIf(process.platform === "win32")("is available over the API", async () => {
    const t = await startHub();
    try {
      await t.api("PUT", "/api/sources/1password", { enabled: true, options: { opPath: FAKE_OP } });
      const res = await t.api("GET", "/api/credentials/setup");
      expect(res.status).toBe(200);
      const byType = Object.fromEntries(res.body.statuses.map((s: { type: string }) => [s.type, s]));
      expect(byType["1password"]).toMatchObject({ ready: true, version: "2.30.0" });
      expect(byType.keychain).toBeDefined();
      expect(byType.env).toBeUndefined();
    } finally {
      await t.stop();
    }
  });

  it("doesn't check, or nag about, a 1Password source that is switched off", async () => {
    const t = await startHub();
    try {
      const sources = (await t.api("GET", "/api/state")).body.sources;
      expect(sources.find((s: { type: string }) => s.type === "1password")).toMatchObject({ enabled: false });
      const statuses = (await t.api("GET", "/api/credentials/setup")).body.statuses;
      expect(statuses.some((s: { type: string }) => s.type === "1password")).toBe(false);
    } finally {
      await t.stop();
    }
  });
});

describe("explaining why 1Password isn't ready", () => {
  // What `op` really prints, including its timestamp prefix. `run` is replaced by a script of answers.
  const fail = (stderr: string, code: number | string = 1) => new ExecError("failed", stderr, code, false);
  const script = (answers: Record<string, string | Error>) => {
    const calls: string[] = [];
    const runner = (async (_file: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      calls.push(key);
      const a = key.startsWith("whoami") ? answers.whoami : answers.accounts;
      if (a instanceof Error) throw a;
      return { stdout: a ?? "", stderr: "" };
    }) as unknown as typeof run;
    return { calls, runner };
  };
  const NOT_SIGNED_IN = "[ERROR] 2026/10/21 23:40:35 account is not signed in";
  const APP_DOWN = "[ERROR] 2026/10/21 23:41:10 connecting to desktop app: cannot connect to 1Password app, make sure it is running";

  it("says signed in when whoami works, without asking for the account list", async () => {
    const { calls, runner } = script({ whoami: "{}" });
    expect(await checkOnePassword("op", undefined, {}, runner)).toEqual({ ok: true, message: "Signed in to 1Password" });
    expect(calls).toEqual(["whoami --format"]);
  });

  it("explains that the app isn't running instead of just 'account is not signed in'", async () => {
    const { runner } = script({ whoami: fail(NOT_SIGNED_IN), accounts: fail(APP_DOWN) });
    const r = await checkOnePassword("op", undefined, {}, runner);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/1Password app isn't running or is locked/);
    expect(r.message).not.toMatch(/ERROR|2026/);
  });

  it("treats 'not signed in' with an account connected as available, and names the account", async () => {
    const { runner } = script({ whoami: fail(NOT_SIGNED_IN), accounts: JSON.stringify([{ email: "me@example.com", url: "my.1password.com" }]) });
    const r = await checkOnePassword("op", undefined, {}, runner);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/me@example\.com/);
    expect(r.message).toMatch(/approve/);
  });

  it("points at the app integration when no account is connected", async () => {
    const { runner } = script({ whoami: fail(NOT_SIGNED_IN), accounts: "[]" });
    const r = await checkOnePassword("op", undefined, {}, runner);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/Integrate with 1Password CLI/);
  });

  it("reports a missing CLI, and shows other errors without op's timestamp prefix", async () => {
    expect(await checkOnePassword("op", undefined, {}, script({ whoami: fail("", "ENOENT") }).runner)).toEqual({ ok: false, message: "1Password CLI (op) not found" });
    expect(await checkOnePassword("op", undefined, {}, script({ whoami: fail("[ERROR] 2026/10/21 23:40:35 something odd happened") }).runner)).toEqual({ ok: false, message: "something odd happened" });
    expect(tidyOpError("[ERROR] 2026/10/21 23:40:35 a\n[ERROR] 2026/10/21 23:40:36 b")).toBe("a b");
  });
});

describe("finding the op command", () => {
  const out = (stdout: string) => (async () => ({ stdout, stderr: "" })) as unknown as typeof import("../src/credentials/exec.js").run;
  const always = () => true;

  it("asks where.exe on Windows and prefers a program Windows can run over a script", async () => {
    const calls: string[] = [];
    const runner = (async (file: string, args: string[]) => (calls.push(`${file} ${args.join(" ")}`), { stdout: "C:\\Tools\\op\r\nC:\\Tools\\op.cmd\r\nC:\\Program Files\\1Password CLI\\op.exe\r\n", stderr: "" })) as unknown as typeof import("../src/credentials/exec.js").run;
    expect(await findCommand("op", {}, "win32", runner, always)).toBe("C:\\Program Files\\1Password CLI\\op.exe");
    expect(await findCommand("op", {}, "win32", out("C:\\Tools\\op\r\nC:\\Tools\\op.cmd\r\n"), always)).toBe("C:\\Tools\\op.cmd");
    expect(calls).toEqual(["where.exe op"]);
  });

  it("asks which elsewhere, and ignores paths that don't exist", async () => {
    const calls: string[] = [];
    const runner = (async (file: string) => (calls.push(file), { stdout: "/gone/op\n/opt/homebrew/bin/op\n", stderr: "" })) as unknown as typeof import("../src/credentials/exec.js").run;
    expect(await findCommand("op", {}, "darwin", runner, (p) => p !== "/gone/op")).toBe("/opt/homebrew/bin/op");
    expect(calls).toEqual(["which"]);
  });

  it("returns null when it isn't found, the tool is missing, or the name isn't a plain command", async () => {
    expect(await findCommand("op", {}, "linux", out(""), always)).toBeNull();
    const failing = (async () => { throw new Error("ENOENT"); }) as unknown as typeof import("../src/credentials/exec.js").run;
    expect(await findCommand("op", {}, "linux", failing, always)).toBeNull();
    expect(await findCommand("op; rm -rf /", {}, "linux", out("/bin/op"), always)).toBeNull();
  });
});

describe("testing the 1Password source", () => {
  const opSource = async (t: Awaited<ReturnType<typeof startHub>>) => (await t.api("GET", "/api/state")).body.sources.find((s: { type: string }) => s.type === "1password");

  it("finds op, and saves where it is on the source", async () => {
    const asked: string[] = [];
    const t = await startHub({}, { locateCommand: async (name: string) => (asked.push(name), "/fake/bin/op") });
    try {
      expect((await opSource(t)).options.opPath).toBeUndefined();
      const res = await t.api("POST", "/api/sources/1password/test");
      expect(res.status).toBe(200);
      expect(asked).toEqual(["op"]);
      expect((await opSource(t)).options.opPath).toBe("/fake/bin/op");
    } finally {
      await t.stop();
    }
  });

  it("leaves a path that is already set and works, and doesn't look again", async () => {
    const t = await startHub({}, { locateCommand: async () => { throw new Error("should not look"); } });
    try {
      await t.api("PUT", "/api/sources/1password", { options: { opPath: FAKE_OP } });
      expect((await t.api("POST", "/api/sources/1password/test")).status).toBe(200);
      expect((await opSource(t)).options.opPath).toBe(FAKE_OP);
    } finally {
      await t.stop();
    }
  });

  it("replaces a saved path that no longer exists, and keeps it if op can't be found", async () => {
    const gone = join(tmpdir(), "no-longer-here", "op");
    const t = await startHub({}, { locateCommand: async () => null });
    try {
      await t.api("PUT", "/api/sources/1password", { options: { opPath: gone } });
      const res = await t.api("POST", "/api/sources/1password/test");
      expect(res.body.ok).toBe(false);
      expect((await opSource(t)).options.opPath).toBe(gone);
    } finally {
      await t.stop();
    }
  });
});
