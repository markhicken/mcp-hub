import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("adds 1Password and the keychain on a fresh install", () => {
    const s = storeWith(undefined);
    expect(s.sources.map((x) => [x.type, x.enabled])).toEqual(expect.arrayContaining([["1password", true], ["keychain", true], ["manual", true], ["env", false]]));
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

  it("finds the 1Password CLI and reports its version without asking it for a secret", async () => {
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

  it("is available over the API", async () => {
    const t = await startHub();
    try {
      await t.api("PUT", "/api/sources/1password", { options: { opPath: FAKE_OP } });
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
});
