import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHub, waitFor, type TestHub } from "./helpers.js";

let t: TestHub;
let upstream: Server;
let url = "";
let posts = 0;

beforeAll(async () => {
  // A remote server whose token has expired, answering the way a real one does.
  upstream = createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid token", message: 'Session expired - refresh token invalid: {"error":"invalid_grant"}' }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  t = await startHub();
});

afterAll(async () => {
  await t.stop();
  await new Promise<void>((r) => {
    upstream.close(() => r());
    upstream.closeAllConnections();
  });
});

const logs = (id: string) => t.hub.manager.get(id)!.logs.tail(500).map((l) => l.text);
const attempts = (id: string) => logs(id).filter((l) => l.startsWith("Connecting")).length;

async function addOff(body: Record<string, unknown>, id: string) {
  expect((await t.api("POST", "/api/servers", { ...body, enabled: false })).status).toBe(201);
  const conn = t.hub.manager.get(id)!;
  conn.retryBaseMs = 5;
  return conn;
}

describe("automatic reconnects", () => {
  it("does not retry when the server says the token is invalid or expired, and shows its reason", async () => {
    await addOff({ name: "Expired", transport: "http", url, headers: { Authorization: "Bearer old" } }, "expired");
    await t.api("POST", "/api/servers/expired/enable");
    await waitFor(async () => (await t.api("GET", "/api/servers/expired")).body.state === "error", 10_000, "error state");
    const before = posts;
    await new Promise((r) => setTimeout(r, 300));

    expect(posts).toBe(before);
    expect(attempts("expired")).toBe(1);
    expect(logs("expired").some((l) => l.startsWith("Reconnecting"))).toBe(false);
    const status = (await t.api("GET", "/api/servers/expired")).body;
    expect(status.error).toMatch(/rejected the credentials \(HTTP 401\): Invalid token: Session expired - refresh token invalid/);
    expect(status.error).toMatch(/press Retry/);
  });

  it("gives up after a few failed attempts in a row, and Retry starts over", async () => {
    // Nothing is listening on port 1, so every attempt fails the same way.
    await addOff({ name: "Down", transport: "http", url: "http://127.0.0.1:1/mcp", headers: {} }, "down");
    await t.api("POST", "/api/servers/down/enable");
    await waitFor(() => logs("down").some((l) => l.startsWith("Gave up after 5")), 10_000, "gave up");
    expect(attempts("down")).toBe(6);
    const status = (await t.api("GET", "/api/servers/down")).body;
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/stopped retrying after 5 attempts/);

    await new Promise((r) => setTimeout(r, 300));
    expect(attempts("down")).toBe(6);

    // A manual retry gets a fresh set of attempts.
    await t.api("POST", "/api/servers/down/restart");
    await waitFor(() => attempts("down") === 12, 10_000, "second round of attempts");
    await waitFor(() => logs("down").filter((l) => l.startsWith("Gave up")).length === 2, 10_000, "gave up again");
  });

  it("stops when a local server reports an invalid token on stderr and never answers", async () => {
    const script = `console.error('HTTP 401: {"title":"ErrInvalidOauthToken","status":401,"error_code":401013,"message":"Oauth token is not valid"}'); setInterval(() => {}, 1000);`;
    const conn = await addOff({ name: "Local expired", transport: "stdio", command: process.execPath, args: ["-e", script] }, "local-expired");
    conn.handshakeTimeoutMs = 400;
    await t.api("POST", "/api/servers/local-expired/enable");
    await waitFor(async () => (await t.api("GET", "/api/servers/local-expired")).body.state === "error", 10_000, "error state");
    await new Promise((r) => setTimeout(r, 300));

    expect(attempts("local-expired")).toBe(1);
    expect(logs("local-expired").some((l) => l.startsWith("Reconnecting"))).toBe(false);
    const status = (await t.api("GET", "/api/servers/local-expired")).body;
    expect(status.error).toMatch(/rejected the credentials: ErrInvalidOauthToken: Oauth token is not valid/);
  });

  it("stops retrying a server that connects and then dies straight away", async () => {
    const script = `process.stdin.once('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'flaky', version: '1' } } }) + '\\n'); setTimeout(() => process.exit(1), 20); });`;
    await addOff({ name: "Flaky", transport: "stdio", command: process.execPath, args: ["-e", script] }, "flaky");
    await t.api("POST", "/api/servers/flaky/enable");
    await waitFor(() => logs("flaky").some((l) => l.startsWith("Gave up after 5")), 15_000, "gave up");
    const count = attempts("flaky");
    expect(count).toBe(6);
    await new Promise((r) => setTimeout(r, 300));
    expect(attempts("flaky")).toBe(count);
  });
});
