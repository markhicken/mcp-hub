import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK, startHub, type TestHub } from "./helpers.js";

const SHIM = join(import.meta.dirname, "..", "..", "shim", "src", "shim.mjs");

/** Run the shim, send JSON-RPC lines, and collect responses by id. */
function runShim(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [SHIM, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: any[] = [];
  let buf = "";
  const waiters: Array<() => void> = [];
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) lines.push(JSON.parse(line));
    }
    waiters.splice(0).forEach((w) => w());
  });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const response = async (id: number | string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = lines.find((l) => l.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response for ${id}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  const close = () =>
    new Promise<void>((r) => {
      child.on("exit", () => r());
      child.stdin.end();
    });
  return { send, response, close };
}

let t: TestHub;

beforeAll(async () => {
  t = await startHub();
  await t.api("POST", "/api/servers", { name: "Mock", transport: "stdio", command: process.execPath, args: [MOCK] });
  const start = Date.now();
  while ((await t.api("GET", "/api/servers/mock")).body.state !== "connected") {
    if (Date.now() - start > 15_000) throw new Error("mock did not connect");
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(async () => {
  await t.stop();
});

describe("stdio shim", () => {
  it("bridges stdio JSON-RPC to the hub", async () => {
    const shim = runShim(["mock", "--url", t.base]);
    shim.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const init = await shim.response(1);
    expect(init.result.serverInfo.name).toBe("mock-mcp");
    shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((await shim.response(2)).result.tools.length).toBe(4);
    shim.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "via-shim" } } });
    expect((await shim.response(3)).result.content[0].text).toBe("echo:via-shim");
    await shim.close();
  });

  it("transparently starts a new session if the hub forgot the old one", async () => {
    const shim = runShim(["mock", "--url", t.base]);
    shim.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await shim.response(1);
    t.hub.endpoint.dropServerSessions("mock");
    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "again" } } });
    expect((await shim.response(2)).result.content[0].text).toBe("echo:again");
    await shim.close();
  });

  it("returns a helpful error when the hub is not running", async () => {
    const shim = runShim(["mock", "--url", "http://127.0.0.1:1"]);
    shim.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const res = await shim.response(1);
    expect(res.error.message).toMatch(/MCP Hub isn't running/);
    await shim.close();
  });
});
