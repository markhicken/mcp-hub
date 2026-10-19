import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK, TOKEN, startHub, type TestHub } from "./helpers.js";

let t: TestHub;
let port: number;

/** Raw request so we can forge Host / Origin headers that fetch() would refuse to send. */
function raw(path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
const mcpHeaders = (extra: Record<string, string> = {}) => ({ Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra });

beforeAll(async () => {
  t = await startHub();
  port = t.hub.port;
  await t.api("POST", "/api/servers", { name: "Mock", transport: "stdio", command: process.execPath, args: [MOCK] });
});
afterAll(async () => t.stop());

describe("local security", () => {
  it("serves /health to anyone on localhost", async () => {
    expect((await raw("/health", { Host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    expect((await raw("/health", { Host: "evil.example.com" })).status).toBe(403);
    expect((await raw("/api/state", { Host: `evil.example.com:${port}`, Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  });

  it("rejects browser requests from other origins", async () => {
    const r = await raw("/mcp/mock", mcpHeaders({ Origin: "https://evil.example.com" }), "POST", init);
    expect(r.status).toBe(403);
    expect((await raw("/api/state", { Host: `127.0.0.1:${port}`, Origin: "https://evil.example.com", Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  });

  it("allows its own origin", async () => {
    const r = await raw("/api/state", { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
  });

  it("requires the UI token for every /api call", async () => {
    expect((await raw("/api/state", { Host: `127.0.0.1:${port}` })).status).toBe(401);
    expect((await raw("/api/state", { Host: `127.0.0.1:${port}`, Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await raw(`/api/state?token=${TOKEN}`, { Host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await raw("/api/servers/mock/logs", { Host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("can require a client token on /mcp endpoints", async () => {
    const open = await raw("/mcp/mock", mcpHeaders(), "POST", init);
    expect(open.status).toBe(200);

    await t.api("PUT", "/api/settings", { requireClientToken: true });
    const clientToken = (await t.api("GET", "/api/settings")).body.clientToken as string;
    expect(clientToken.length).toBeGreaterThan(20);

    expect((await raw("/mcp/mock", mcpHeaders(), "POST", init)).status).toBe(401);
    expect((await raw("/mcp/mock", mcpHeaders({ Authorization: "Bearer nope" }), "POST", init)).status).toBe(401);
    expect((await raw("/mcp/mock", mcpHeaders({ Authorization: `Bearer ${clientToken}` }), "POST", init)).status).toBe(200);

    await t.api("PUT", "/api/settings", { requireClientToken: false });
  });

  it("validates settings input", async () => {
    expect((await t.api("PUT", "/api/settings", { port: 80 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { cacheTtlSeconds: "forever" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { requireClientToken: "yes" })).status).toBe(400);
  });

  it("does not leak files outside the UI directory", async () => {
    const r = await raw("/..%2f..%2f..%2fetc/passwd", { Host: `127.0.0.1:${port}` });
    expect(r.body).not.toContain("root:");
  });

  it("refuses OAuth callbacks nobody asked for", async () => {
    const r = await raw("/oauth/callback?code=abc&state=forged", { Host: `127.0.0.1:${port}` });
    expect(r.status).toBe(400);
    expect(r.body).toContain("Sign-in failed");
  });

  it("returns clean JSON-RPC errors for bad MCP requests", async () => {
    expect((await raw("/mcp/mock", mcpHeaders(), "POST", "not json")).status).toBe(400);
    expect((await raw("/mcp/mock", mcpHeaders(), "POST", JSON.stringify({ hello: "world" }))).status).toBe(400);
    const noSession = await raw("/mcp/mock", mcpHeaders(), "POST", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(noSession.status).toBe(400);
    const badSession = await raw("/mcp/mock", mcpHeaders({ "Mcp-Session-Id": "nope" }), "POST", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(badSession.status).toBe(404);
    expect((await raw("/mcp/does-not-exist", mcpHeaders(), "POST", init)).status).toBe(404);
  });

  it("validates server definitions", async () => {
    expect((await t.api("POST", "/api/servers", { name: "x", transport: "stdio" })).status).toBe(400);
    expect((await t.api("POST", "/api/servers", { name: "x", transport: "http", url: "ftp://nope" })).status).toBe(400);
    expect((await t.api("DELETE", "/api/servers/ghost")).status).toBe(404);
  });
});
