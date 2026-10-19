import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogBuffer } from "../src/logs.js";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

let t: TestHub;

async function connectClient(id: string): Promise<Client> {
  const client = new Client({ name: "usage-client", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp/${id}`)));
  return client;
}

const logText = (id: string) => t.hub.manager.get(id)!.logs.tail().map((l) => l.text);

beforeAll(async () => {
  t = await startHub();
  for (const name of ["One", "Two"]) {
    const res = await t.api("POST", "/api/servers", { name, transport: "stdio", command: process.execPath, args: [MOCK] });
    expect(res.status).toBe(201);
  }
  for (const id of ["one", "two"]) {
    await waitFor(async () => (await t.api("GET", `/api/servers/${id}`)).body.state === "connected", 15000, `${id} connected`);
  }
});

afterAll(async () => {
  await t.stop();
});

describe("what counts as usage", () => {
  it("does not count connecting, only real requests", async () => {
    const client = await connectClient("one");
    await new Promise((r) => setTimeout(r, 200));
    expect((await t.api("GET", "/api/usage?range=1h")).body.clients).toEqual([]);
    expect((await t.api("GET", "/api/servers/one")).body).toMatchObject({ requests: 0, inUse: false });

    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    const usage = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(usage.clients).toMatchObject([{ client: "Direct HTTP", requests: 1 }]);
    await client.close();
  });

  it("clears the history for one server or for everything", async () => {
    const two = await connectClient("two");
    await two.callTool({ name: "echo", arguments: { text: "x" } });
    await two.close();
    const before = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(before.totals.map((r: { serverId: string }) => r.serverId).sort()).toEqual(["one", "two"]);

    expect((await t.api("DELETE", "/api/usage?server=one")).status).toBe(200);
    const scoped = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(scoped.totals.map((r: { serverId: string }) => r.serverId)).toEqual(["two"]);
    expect((await t.api("GET", "/api/servers/one")).body).toMatchObject({ requests: 0, bytesIn: 0, bytesOut: 0 });
    expect((await t.api("GET", "/api/servers/two")).body.requests).toBe(1);

    expect((await t.api("DELETE", "/api/usage")).status).toBe(200);
    expect((await t.api("GET", "/api/usage?range=1h")).body.totals).toEqual([]);
    expect((await t.api("GET", "/api/servers/two")).body).toMatchObject({ requests: 0, errors: 0 });
  });
});

describe("request diagnostics in the server log", () => {
  it("logs slow and failed requests with the app that made them", async () => {
    const conn = t.hub.manager.get("one")!;
    conn.slowLogMs = 50;
    const client = await connectClient("one");
    await client.callTool({ name: "slow", arguments: { steps: 5 } });
    await client.callTool({ name: "boom", arguments: {} });
    await client.close();
    await waitFor(() => logText("one").some((l) => /slow/.test(l) && /from Direct HTTP: ok in/.test(l)), 3000, "slow request logged");
    expect(logText("one").some((l) => /boom/.test(l) && /failed/.test(l))).toBe(true);
    conn.slowLogMs = 5000;
  });

  it("warns while a request is still running and logs when the app cancels it", async () => {
    const conn = t.hub.manager.get("one")!;
    conn.slowWarnMs = 100;
    const client = await connectClient("one");
    const ctl = new AbortController();
    const call = client.callTool({ name: "slow", arguments: { steps: 100 } }, undefined, { signal: ctl.signal }).catch(() => {});
    await waitFor(() => logText("one").some((l) => /still running/.test(l)), 3000, "still-running warning");
    ctl.abort();
    await call;
    await waitFor(() => logText("one").some((l) => /cancelled/.test(l)), 3000, "cancel logged");
    await client.close();
    conn.slowWarnMs = 30_000;
  });
});

describe("persisted logs", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "mcp-hub-logs-")), "s.jsonl");

  it("survive a restart and can be cleared", () => {
    const f = file();
    const first = new LogBuffer(500, f);
    first.add("stderr", "something went wrong");
    first.add("info", "second");
    const second = new LogBuffer(500, f);
    expect(second.tail().map((l) => l.text)).toEqual(["something went wrong", "second"]);
    second.clear();
    expect(new LogBuffer(500, f).tail()).toEqual([]);
  });

  it("never write a resolved secret to disk", () => {
    const f = file();
    const logs = new LogBuffer(500, f);
    logs.setSecrets(["s3cr3t-token"]);
    logs.add("stderr", "token s3cr3t-token leaked");
    expect(readFileSync(f, "utf8")).not.toContain("s3cr3t-token");
  });

  it("ignore a damaged line instead of failing", () => {
    const f = file();
    writeFileSync(f, 'not json\n{"t":1,"level":"info","text":"ok"}\n');
    expect(new LogBuffer(500, f).tail().map((l) => l.text)).toEqual(["ok"]);
  });

  it("rotate so the file cannot grow forever", () => {
    const f = file();
    const logs = new LogBuffer(10, f);
    const big = "x".repeat(1_900);
    for (let i = 0; i < 1000; i++) logs.add("info", big);
    expect(readFileSync(f).length).toBeLessThan(1_100_000);
    expect(readFileSync(`${f}.1`).length).toBeGreaterThan(0);
  });
});
