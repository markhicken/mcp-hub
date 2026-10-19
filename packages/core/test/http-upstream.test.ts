import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startHub, waitFor, type TestHub } from "./helpers.js";

let t: TestHub;
let upstream: Server;
let upstreamUrl = "";
const seenAuth: string[] = [];

beforeAll(async () => {
  // A stateless remote MCP server that requires "Authorization: Bearer let-me-in".
  upstream = createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
      return;
    }
    if (req.method === "POST" && req.url === "/register") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ client_id: "mock-client", redirect_uris: [`${t.base}/oauth/callback`] }));
      return;
    }
    if (req.method === "POST") seenAuth.push(auth);
    if (auth !== "Bearer let-me-in") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Authentication required" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = new McpServer({ name: "remote-mock", version: "9.9.9" });
    server.registerTool("whoami", { description: "Say hi", inputSchema: { who: z.string() } }, async ({ who }) => ({ content: [{ type: "text", text: `hi ${who}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  t = await startHub({ REMOTE_TOKEN: "let-me-in", WRONG_TOKEN: "nope" });
});

afterAll(async () => {
  await t.stop();
  await new Promise<void>((r) => {
    upstream.close(() => r());
    upstream.closeAllConnections();
  });
});

describe("remote HTTP upstream", () => {
  it("injects credentials into headers and proxies tools", async () => {
    const res = await t.api("POST", "/api/servers", { name: "Remote", transport: "http", url: upstreamUrl, headers: { Authorization: "Bearer {{env://REMOTE_TOKEN}}" } });
    expect(res.status).toBe(201);
    await waitFor(async () => (await t.api("GET", "/api/servers/remote")).body.state === "connected", 10_000, "remote connected");
    const status = (await t.api("GET", "/api/servers/remote")).body;
    expect(status.serverInfo).toMatchObject({ name: "remote-mock", version: "9.9.9" });
    expect(status.credentials).toBe("ok");

    const client = new Client({ name: "c", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/remote`)));
    const out = await client.callTool({ name: "whoami", arguments: { who: "hub" } });
    expect((out.content as any)[0].text).toBe("hi hub");
    await client.close();
    // The client never needed (or saw) the upstream token.
    expect(seenAuth.every((a) => a === "Bearer let-me-in")).toBe(true);
  });

  it("turns upstream 401s into a clear error instead of crashing the client", async () => {
    await t.api("POST", "/api/servers", { name: "Rejected", transport: "http", url: upstreamUrl, headers: { Authorization: "Bearer {{env://WRONG_TOKEN}}" }, lifecycle: "on-demand" });
    const client = new Client({ name: "c", version: "0" });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/rejected`)))).rejects.toThrow(/rejected the credentials/);
    const status = (await t.api("GET", "/api/servers/rejected")).body;
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/401/);
  });

  it("switches an imported server with no credentials to OAuth sign-in on a 401", async () => {
    const res = await t.api("POST", "/api/servers", { name: "Needs oauth", transport: "http", url: upstreamUrl, auth: "none" });
    expect(res.status).toBe(201);
    await waitFor(async () => (await t.api("GET", "/api/servers/needs-oauth")).body.state === "needs-auth", 10_000, "needs-auth");
    const status = (await t.api("GET", "/api/servers/needs-oauth")).body;
    expect(status.config.auth).toBe("oauth");
    expect(status.authUrl).toMatch(/\/authorize\?/);
  });

  it("reports missing credentials without starting the server", async () => {
    await t.api("POST", "/api/servers", { name: "No cred", transport: "http", url: upstreamUrl, headers: { Authorization: "Bearer {{env://DOES_NOT_EXIST}}" }, lifecycle: "on-demand" });
    const client = new Client({ name: "c", version: "0" });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/no-cred`)))).rejects.toThrow(/DOES_NOT_EXIST/);
    expect((await t.api("GET", "/api/servers/no-cred")).body.credentials).toBe("failed");
  });
});
