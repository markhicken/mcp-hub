import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "../src/credentials/broker.js";
import { CredentialError } from "../src/credentials/types.js";
import type { SourceConfig } from "../src/types.js";
import { startHub } from "./helpers.js";
import { run } from "../src/credentials/exec.js";

const FAKE_OP = join(import.meta.dirname, "fixtures", "fake-op.mjs");
chmodSync(FAKE_OP, 0o755);

let dir: string;
let log: string;
let deny: string;
let clock: number;

const onePassword = (options: Record<string, string> = {}): SourceConfig => ({ id: "op", type: "1password", name: "1Password", enabled: true, options: { opPath: FAKE_OP, ...options } });
const builtins: SourceConfig[] = [
  { id: "env", type: "env", name: "Env", enabled: true, options: {} },
  { id: "manual", type: "manual", name: "Manual", enabled: true, options: {} },
];

function makeBroker(sources: SourceConfig[] = [onePassword(), ...builtins], ttl = 3600) {
  return new CredentialBroker({
    getSources: () => sources,
    getCacheTtlSeconds: () => ttl,
    getDenialCooldownSeconds: () => 10,
    env: { ...process.env, FAKE_OP_LOG: log, FAKE_OP_DENY: deny, HUB_TEMPLATE_ENV: "from-env" },
    now: () => clock,
  });
}

const reads = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter((l) => l.startsWith("start")).length : 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-hub-broker-"));
  log = join(dir, "op.log");
  deny = join(dir, "deny");
  clock = 1_000_000;
});

describe.skipIf(process.platform === "win32")("credential broker", () => {
  it("resolves from 1Password and caches the result", async () => {
    const b = makeBroker();
    expect(await b.resolve("op://V/Item/field", "svc")).toBe("secret:op://V/Item/field");
    expect(await b.resolve("op://V/Item/field", "svc")).toBe("secret:op://V/Item/field");
    expect(reads()).toBe(1);
    expect(b.cached().map((c) => c.ref)).toEqual(["op://V/Item/field"]);
  });

  it("forgets one cached secret without touching the others", async () => {
    const b = makeBroker();
    await b.resolve("op://V/Item/a", "svc");
    await b.resolve("op://V/Item/b", "svc");
    expect(b.forget("op", "op://V/Item/a")).toBe(true);
    expect(b.forget("op", "op://V/Item/a")).toBe(false);
    expect(b.forget("other", "op://V/Item/b")).toBe(false);
    expect(b.cached().map((c) => c.ref)).toEqual(["op://V/Item/b"]);
    await b.resolve("op://V/Item/a", "svc");
    expect(reads()).toBe(3);
  });

  it("deduplicates concurrent requests for the same reference", async () => {
    const b = makeBroker();
    const results = await Promise.all(Array.from({ length: 6 }, () => b.resolve("op://V/Item/a", "svc")));
    expect(new Set(results).size).toBe(1);
    expect(reads()).toBe(1);
  });

  it("serializes different references so the user sees one prompt at a time", async () => {
    const b = makeBroker();
    await Promise.all(["a", "b", "c"].map((n) => b.resolve(`op://V/Item/${n}`, "svc")));
    const events = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" ")[0]);
    // start,end,start,end,... means reads never overlapped
    expect(events).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  it("keeps secrets for the whole run when the TTL is 0", async () => {
    const b = makeBroker(undefined, 0);
    await b.resolve("op://V/Item/forever", "svc");
    clock += 30 * 86_400_000;
    await b.resolve("op://V/Item/forever", "svc");
    expect(reads()).toBe(1);
  });

  it("expires cached secrets after the TTL", async () => {
    const b = makeBroker(undefined, 60);
    await b.resolve("op://V/Item/ttl", "svc");
    clock += 30_000;
    await b.resolve("op://V/Item/ttl", "svc");
    expect(reads()).toBe(1);
    clock += 31_000;
    await b.resolve("op://V/Item/ttl", "svc");
    expect(reads()).toBe(2);
  });

  it("stops asking for a while after a denied prompt", async () => {
    const b = makeBroker();
    writeFileSync(deny, "1");
    await expect(b.resolve("op://V/Item/x", "svc")).rejects.toMatchObject({ kind: "denied" });
    expect(reads()).toBe(1);
    // Within the cooldown: fails immediately without calling op again.
    await expect(b.resolve("op://V/Item/y", "svc")).rejects.toThrow(/denied recently/);
    expect(reads()).toBe(1);
    clock += 11_000;
    writeFileSync(deny, "");
    // File exists (empty) so still denied; remove by pointing at a missing file via a new broker.
    const ok = new CredentialBroker({ getSources: () => [onePassword(), ...builtins], getCacheTtlSeconds: () => 60, getDenialCooldownSeconds: () => 10, env: { ...process.env, FAKE_OP_LOG: log }, now: () => clock });
    expect(await ok.resolve("op://V/Item/y", "svc")).toBe("secret:op://V/Item/y");
  });

  it("forgets everything when locked, including typed secrets", async () => {
    const b = makeBroker();
    b.memory.set("typed", "hunter2");
    expect(await b.resolve("secret://typed", "svc")).toBe("hunter2");
    await b.resolve("op://V/Item/l", "svc");
    b.lock();
    expect(b.cached()).toEqual([]);
    await expect(b.resolve("secret://typed", "svc")).rejects.toMatchObject({ kind: "not-found" });
    await b.resolve("op://V/Item/l", "svc");
    expect(reads()).toBe(2);
  });

  it("refuses vaults outside the allow list", async () => {
    const b = makeBroker([onePassword({ allowedVaults: "Work" }), ...builtins]);
    await expect(b.resolve("op://Private/Item/f", "svc")).rejects.toBeInstanceOf(CredentialError);
    expect(reads()).toBe(0);
    expect(await b.resolve("op://Work/Item/f", "svc")).toContain("secret:");
  });

  it("resolves templates, bare references and environment references", async () => {
    const b = makeBroker();
    expect(await b.resolveTemplate("Bearer {{op://V/I/f}}", "svc")).toBe("Bearer secret:op://V/I/f");
    expect(await b.resolveTemplate("op://V/I/g", "svc")).toBe("secret:op://V/I/g");
    expect(await b.resolveTemplate("{{env://HUB_TEMPLATE_ENV}}-x", "svc")).toBe("from-env-x");
    expect(await b.resolveTemplate("plain value", "svc")).toBe("plain value");
    expect(b.needsCredentials(["plain", "a {{env://X}}"])).toBe(true);
    expect(b.needsCredentials(["plain", undefined])).toBe(false);
  });

  it("explains when no source handles a reference", async () => {
    const b = makeBroker(builtins);
    await expect(b.resolve("op://V/I/f", "svc")).rejects.toThrow(/No enabled credential source/);
    await expect(b.resolve("nope://x", "svc")).rejects.toThrow(/Unknown credential reference/);
  });

  it("reports source health", async () => {
    const b = makeBroker();
    expect(await b.testSource(onePassword())).toMatchObject({ ok: true });
    expect(await b.testSource(onePassword({ opPath: "/definitely/not/op" }))).toMatchObject({ ok: false });
  });
});

describe("test isolation and forgetting over the API", () => {
  it("never runs the real 1Password CLI or keychain tool in tests", async () => {
    await expect(run("op", ["whoami"])).rejects.toThrow(/blocked/);
    await expect(run("/opt/homebrew/bin/op", ["--version"])).rejects.toThrow(/blocked/);
    await expect(run("security", ["help"])).rejects.toThrow(/blocked/);
  });

  it("removes just that entry and validates the request", async () => {
    const t = await startHub({ FORGET_A: "a", FORGET_B: "b" });
    try {
      await t.hub.broker.resolve("env://FORGET_A", "svc");
      await t.hub.broker.resolve("env://FORGET_B", "svc");
      const forget = (body: unknown) => t.api("DELETE", "/api/credentials/cached", body);
      expect((await forget({ sourceId: "env" })).status).toBe(400);
      expect((await forget({ sourceId: "env", ref: "env://MISSING" })).status).toBe(404);
      expect((await forget({ sourceId: "env", ref: "env://FORGET_A" })).status).toBe(200);
      expect(t.hub.broker.cached().map((c) => c.ref)).toEqual(["env://FORGET_B"]);
    } finally {
      await t.stop();
    }
  });
});
