import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, type HubOptions } from "../src/hub.js";
import { memoryKeyStore } from "../src/credentials/keystore.js";

export const MOCK = join(import.meta.dirname, "fixtures", "mock-mcp.mjs");
export const TOKEN = "test-ui-token";

export interface TestHub {
  hub: Hub;
  dir: string;
  base: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}

export async function startHub(env: NodeJS.ProcessEnv = {}, hubOpts: Partial<HubOptions> = {}): Promise<TestHub> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-test-"));
  const hub = new Hub({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    metricsPath: ":memory:",
    uiToken: TOKEN,
    quiet: true,
    keyStore: memoryKeyStore(),
    // No test should ever open a real Save dialog or Finder window.
    pickSavePath: async () => undefined,
    reveal: () => {},
    baseEnv: () => ({ ...process.env, ...env }),
    ...hubOpts,
  });
  // Most tests talk to /mcp over HTTP directly; the socket and approval flow has its own tests.
  hub.store.updateSettings({ allowTcpMcp: true });
  // Some tests reference {{env://...}}; the environment source is off by default.
  hub.store.upsertSource({ ...hub.store.sources.find((x) => x.type === "env")!, enabled: true });
  await hub.listen(0);
  const base = hub.baseUrl;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed as any };
  };
  return {
    hub,
    dir,
    base,
    api,
    stop: async () => {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000, label = "condition"): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}
