import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

let t: TestHub;

async function connectClient(id: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/${id}`)));
  return client;
}

beforeAll(async () => {
  t = await startHub({ HUB_TEST_SECRET: "s3cr3t-value" });
  const res = await t.api("POST", "/api/servers", {
    name: "Mock",
    transport: "stdio",
    command: process.execPath,
    args: [MOCK],
    env: { FROM_ENV_REF: "{{env://HUB_TEST_SECRET}}", PLAIN: "plain" },
  });
  expect(res.status).toBe(201);
  await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.state === "connected", 15000, "mock connected");
});

afterAll(async () => {
  await t.stop();
});

describe("proxying a stdio MCP through the hub", () => {
  it("reports server info and tool count in status", async () => {
    const { body } = await t.api("GET", "/api/servers/mock");
    expect(body.serverInfo).toMatchObject({ name: "mock-mcp", version: "1.2.3" });
    expect(body.authenticated).toBe(true);
    await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.toolCount === 4, 5000, "tool count");
  });

  it("lets a standard MCP client list and call tools", async () => {
    const client = await connectClient("mock");
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual(["boom", "echo", "env", "slow"]);
    const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect((res.content as any)[0].text).toBe("echo:hi");
    await client.close();
  });

  it("injects resolved credentials into the child environment", async () => {
    const client = await connectClient("mock");
    const a = await client.callTool({ name: "env", arguments: { name: "FROM_ENV_REF" } });
    expect((a.content as any)[0].text).toBe("s3cr3t-value");
    const b = await client.callTool({ name: "env", arguments: { name: "PLAIN" } });
    expect((b.content as any)[0].text).toBe("plain");
    await client.close();
  });

  it("keeps concurrent sessions isolated even with colliding JSON-RPC ids", async () => {
    const [c1, c2] = await Promise.all([connectClient("mock"), connectClient("mock")]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => [
        c1.callTool({ name: "echo", arguments: { text: `a${i}` } }),
        c2.callTool({ name: "echo", arguments: { text: `b${i}` } }),
      ]).flat(),
    );
    results.forEach((r, i) => expect((r.content as any)[0].text).toBe(`echo:${i % 2 === 0 ? "a" : "b"}${Math.floor(i / 2)}`));
    await Promise.all([c1.close(), c2.close()]);
  });

  it("routes progress notifications back to the right client", async () => {
    const client = await connectClient("mock");
    const progress: number[] = [];
    const res = await client.callTool({ name: "slow", arguments: { steps: 3 } }, undefined, { onprogress: (p) => progress.push(p.progress) });
    expect((res.content as any)[0].text).toBe("done");
    expect(progress).toEqual([1, 2, 3]);
    await client.close();
  });

  it("passes tool errors through and counts them", async () => {
    const client = await connectClient("mock");
    const res = await client.callTool({ name: "boom", arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
    const usage = (await t.api("GET", "/api/usage?range=1h")).body;
    const tool = usage.tools.find((x: any) => x.tool === "boom");
    expect(tool).toMatchObject({ serverId: "mock", calls: 1, errors: 1 });
  });

  it("tracks bytes, requests and latency", async () => {
    const usage = (await t.api("GET", "/api/usage?range=1h")).body;
    const totals = usage.totals.find((x: any) => x.serverId === "mock");
    expect(totals.requests).toBeGreaterThan(5);
    expect(totals.bytesIn).toBeGreaterThan(0);
    expect(totals.bytesOut).toBeGreaterThan(0);
    expect(totals.p95LatencyMs).toBeGreaterThan(0);
    // The "boom" tool returned isError, which counts toward the error rate.
    expect(totals.errors).toBeGreaterThanOrEqual(1);
    const status = (await t.api("GET", "/api/servers/mock")).body;
    expect(status.bytesIn).toBeGreaterThan(0);
  });

  it("disconnects and reconnects on demand from the API", async () => {
    await t.api("POST", "/api/servers/mock/disable");
    expect((await t.api("GET", "/api/servers/mock")).body.state).toBe("disconnected");
    const client = new Client({ name: "x", version: "0" });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/mock`)))).rejects.toThrow(/turned off/);
    await t.api("POST", "/api/servers/mock/enable");
    await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.state === "connected", 15000, "reconnect");
    const c = await connectClient("mock");
    expect((await c.callTool({ name: "echo", arguments: { text: "back" } })).content).toBeTruthy();
    await c.close();
  });

  it("recovers when the child process dies", async () => {
    const status = (await t.api("GET", "/api/servers/mock")).body;
    expect(status.state).toBe("connected");
    await t.api("POST", "/api/servers/mock/restart");
    await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.state === "connected", 15000, "restart");
  });
});
