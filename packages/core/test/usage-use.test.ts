import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countsAsUse } from "../src/upstream.js";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

describe("what counts as use", () => {
  it("leaves out discovery and keep-alive, keeps real calls", () => {
    for (const m of ["tools/list", "prompts/list", "resources/list", "resources/templates/list", "ping", "logging/setLevel"]) expect(countsAsUse(m)).toBe(false);
    for (const m of ["tools/call", "resources/read", "prompts/get", "completion/complete"]) expect(countsAsUse(m)).toBe(true);
  });
});

describe("usage only reflects what connected apps actually use", () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startHub();
    await t.api("POST", "/api/servers", { name: "Mock", transport: "stdio", command: process.execPath, args: [MOCK] });
    await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.state === "connected", 15000, "mock connected");
  });
  afterAll(async () => {
    await t.stop();
  });

  it("connecting and listing tools is not usage; calling a tool is", async () => {
    const client = new Client({ name: "Test App", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/mock`)));
    await client.listTools();
    await client.ping();

    t.hub.metrics.flush();
    let s = (await t.api("GET", "/api/servers/mock")).body;
    expect(s).toMatchObject({ requests: 0, bytesIn: 0, bytesOut: 0, lastActivityAt: null });
    let usage = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(usage.totals).toEqual([]);

    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    t.hub.metrics.flush();
    s = (await t.api("GET", "/api/servers/mock")).body;
    expect(s.requests).toBe(1);
    expect(s.lastActivityAt).not.toBeNull();
    usage = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(usage.totals).toHaveLength(1);
    expect(usage.totals[0]).toMatchObject({ serverId: "mock", requests: 1 });
    expect(usage.clients.map((c: { client: string }) => c.client)).toEqual(["Direct HTTP"]);
    await client.close();
  });
});
