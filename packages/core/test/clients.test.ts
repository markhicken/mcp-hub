import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientGate, resolveClient, type ProcInfo } from "../src/clients.js";
import { socketPath } from "../src/paths.js";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

const SHIM = join(import.meta.dirname, "..", "..", "shim", "src", "shim.mjs");

function table(rows: Array<[number, number, string]>) {
  const procs = new Map<number, ProcInfo>(rows.map(([pid, ppid, command]) => [pid, { pid, ppid, started: `t${pid}`, command }]));
  return { lookup: async (pid: number) => procs.get(pid) ?? null, args: async () => "" };
}

describe("client identification", () => {
  it("treats every helper inside one .app as the same client", async () => {
    const t = table([
      [1100, 100, "shim"],
      [1101, 101, "shim"],
      [100, 50, "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"],
      [101, 50, "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"],
      [50, 20, "/Applications/Claude.app/Contents/MacOS/Claude"],
      [20, 1, "/sbin/launchd"],
    ]);
    const a = await resolveClient(1100, t.lookup, t.args);
    const b = await resolveClient(1101, t.lookup, t.args);
    expect(a).toMatchObject({ name: "Claude", pid: 50, path: "/Applications/Claude.app" });
    expect(b?.key).toBe(a?.key);
  });

  it("skips shells and names a CLI by its script, not its terminal", async () => {
    const t = table([
      [900, 300, "shim"],
      [300, 200, "/bin/zsh"],
      [200, 150, "/usr/local/bin/node"],
      [150, 120, "-zsh"],
      [120, 100, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
    ]);
    const r = await resolveClient(900, t.lookup, async () => "node /usr/local/lib/node_modules/@acme/cli/bin/run.js --flag");
    expect(r).toMatchObject({ name: "@acme/cli", pid: 200 });
  });

  it("falls back to the terminal when only shells are above the bridge", async () => {
    const t = table([
      [900, 300, "shim"],
      [300, 120, "/bin/zsh"],
      [120, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
    ]);
    expect((await resolveClient(900, t.lookup, t.args))?.name).toBe("iTerm");
  });
});

describe("Windows client identification", () => {
  // The fake table is made of Windows-shaped paths, so these run on every platform.
  const win = (rows: Array<[number, number, string]>, cmdlines: Record<number, string> = {}) => {
    const t = table(rows);
    return { lookup: t.lookup, args: async (pid: number) => cmdlines[pid] ?? "" };
  };
  const CLAUDE = "C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-0.9.2\\claude.exe";

  it("treats an Electron app and its helpers as one client, across updates", async () => {
    const t = win([
      [1100, 100, "C:\\Program Files\\MCP Hub\\mcp-hub-stdio.exe"],
      [100, 50, CLAUDE],
      [50, 20, CLAUDE],
      [20, 4, "C:\\Windows\\explorer.exe"],
    ]);
    const a = await resolveClient(1100, t.lookup, t.args);
    expect(a).toMatchObject({ name: "claude", pid: 50, path: CLAUDE });
    expect(a?.identity).toBe("app:c:\\users\\me\\appdata\\local\\anthropicclaude|claude");
    // The next version lives in another app-x.y.z folder but is the same app.
    const updated = await resolveClient(1100, win([[1100, 50, "x"], [50, 1, CLAUDE.replace("app-0.9.2", "app-0.9.3")]]).lookup, t.args);
    expect(updated?.identity).toBe(a?.identity);
  });

  it("gives an MSIX package one identity whatever its version", async () => {
    const pkg = (v: string) => `C:\\Program Files\\WindowsApps\\Claude_${v}_x64__abc123\\app\\Claude.exe`;
    const id = async (v: string) => (await resolveClient(9, win([[9, 8, "shim.exe"], [8, 1, pkg(v)]]).lookup, async () => ""))?.identity;
    expect(await id("1.2.3.0")).toBe(await id("1.3.0.0"));
    expect(await id("1.2.3.0")).toContain("claude_*_x64__abc123");
  });

  it("looks past cmd, PowerShell and the terminal, and names a CLI by its script", async () => {
    const t = win(
      [
        [900, 300, "C:\\Program Files\\MCP Hub\\mcp-hub-stdio.exe"],
        [300, 200, "C:\\Windows\\System32\\cmd.exe"],
        [200, 150, "C:\\Program Files\\nodejs\\node.exe"],
        [150, 120, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
        [120, 100, "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0.0.0_x64__8wekyb3d8bbwe\\WindowsTerminal.exe"],
      ],
      { 200: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@acme\\cli\\bin\\run.js" --flag' },
    );
    expect(await resolveClient(900, t.lookup, t.args)).toMatchObject({ name: "@acme/cli", pid: 200 });
  });

  it("falls back to the terminal when only shells are above the bridge", async () => {
    const t = win([
      [900, 300, "C:\\x\\mcp-hub-stdio.exe"],
      [300, 120, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
      [120, 1, "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0.0.0_x64__8wekyb3d8bbwe\\WindowsTerminal.exe"],
    ]);
    expect((await resolveClient(900, t.lookup, t.args))?.name).toBe("WindowsTerminal");
  });

  it("ignores a parent whose pid was reused by a newer process", async () => {
    const procs = new Map<number, ProcInfo>([
      [900, { pid: 900, ppid: 50, started: "1000", command: "C:\\x\\mcp-hub-stdio.exe" }],
      // pid 50 now belongs to a process that started after the bridge: the real parent is long gone.
      [50, { pid: 50, ppid: 4, started: "5000", command: "C:\\Other\\other.exe" }],
    ]);
    expect(await resolveClient(900, async (pid) => procs.get(pid) ?? null, async () => "")).toBeNull();
  });
});

describe("approval gate", () => {
  const fake = table([
    [10, 1, "/Applications/Fake Client.app/Contents/MacOS/Fake Client"],
  ]);
  const lookup = async (pid: number) => (pid === 10 ? fake.lookup(10) : { pid, ppid: 10, started: `s${pid}`, command: "shim" });
  const mk = (extra = {}) => new ClientGate({ lookup, args: fake.args, waitMs: 80, signer: async () => "", ...extra });

  it("asks once per app, whatever the number of connections", async () => {
    const g = mk();
    let prompts = 0;
    g.on("pending", () => prompts++);
    const first = Promise.all([g.authorize(21, "a"), g.authorize(22, "b"), g.authorize(23, "c")]);
    await waitFor(() => g.list().length === 1);
    expect(g.list()[0]).toMatchObject({ name: "Fake Client", status: "pending" });
    g.decide(g.list()[0]!.id, true);
    expect((await first).map((v) => v.status)).toEqual(["allowed", "allowed", "allowed"]);
    expect((await g.authorize(24, "d")).status).toBe("allowed");
    expect(prompts).toBe(1);
    expect(g.list()[0]!.servers.sort()).toEqual(["a", "b", "c", "d"]);
    g.close();
  });

  it("reports pending after the wait and remembers a denial", async () => {
    const g = mk();
    expect((await g.authorize(31, "a")).status).toBe("pending");
    g.decide(g.list()[0]!.id, false);
    expect((await g.authorize(32, "a")).status).toBe("denied");
    g.close();
  });

  it("lets an allowed app use only the servers it was given", async () => {
    const g = mk();
    const first = g.authorize(51, "a");
    await waitFor(() => g.list().length === 1);
    const id = g.list()[0]!.id;
    expect(g.list()[0]!.allowed).toBeNull();
    g.decide(id, true, ["a", "b"], true, ["a", "b", "c"]);
    expect((await first).status).toBe("allowed");
    expect((await g.authorize(52, "b")).status).toBe("allowed");
    const blocked = await g.authorize(53, "c");
    expect(blocked).toMatchObject({ status: "denied", reason: expect.stringContaining("wasn't given access") });
    // Changing the choice applies at once; allowing without a list means every server again.
    g.decide(id, true, ["c"], true, ["a", "b", "c"]);
    expect((await g.authorize(54, "c")).status).toBe("allowed");
    expect((await g.authorize(55, "a")).status).toBe("denied");
    g.decide(id, true);
    expect(g.list()[0]!.allowed).toBeNull();
    expect((await g.authorize(56, "a")).status).toBe("allowed");
    g.close();
  });

  it("asks again when an allowed app requests a server it was never offered", async () => {
    const g = mk();
    const asked: string[] = [];
    g.on("asking", (_c, server: string) => asked.push(server));
    const first = g.authorize(61, "a");
    await waitFor(() => g.list().length === 1);
    const id = g.list()[0]!.id;
    g.decide(id, true, ["a"], true, ["a", "b"]);
    await first;
    // "b" was offered and left unticked: refused without asking. "new" wasn't offered: the user is asked.
    expect((await g.authorize(62, "b")).status).toBe("denied");
    expect(asked).toEqual([]);
    const pending = g.authorize(63, "new");
    await waitFor(() => g.list()[0]!.asking.length === 1);
    expect(g.list()[0]).toMatchObject({ status: "allowed", asking: ["new"] });
    expect(asked).toEqual(["new"]);
    g.decide(id, true, ["a", "new"], true, ["a", "b", "new"]);
    expect((await pending).status).toBe("allowed");
    expect(g.list()[0]!.asking).toEqual([]);
    expect(asked).toEqual(["new"]);
    g.close();
  });

  it("reports pending while a new server is unanswered, and a refusal sticks", async () => {
    const g = mk();
    const first = g.authorize(71, "a");
    await waitFor(() => g.list().length === 1);
    const id = g.list()[0]!.id;
    g.decide(id, true, ["a"], false, ["a"]);
    await first;
    expect((await g.authorize(72, "new")).status).toBe("pending");
    g.decide(id, true, ["a"], false, ["a", "new"]);
    expect((await g.authorize(73, "new")).status).toBe("denied");
    g.close();
  });

  it("forgets an app when it quits, so the next launch asks again", async () => {
    let alive = true;
    const g = mk({ alive: () => alive, sweepMs: 20 });
    const gone: string[] = [];
    g.on("gone", (id: string) => gone.push(id));
    await g.authorize(41, "a");
    const id = g.list()[0]!.id;
    g.decide(id, true);
    alive = false;
    await waitFor(() => g.list().length === 0);
    expect(gone).toEqual([id]);
    alive = true;
    expect((await g.authorize(42, "a")).status).toBe("pending");
    g.close();
  });
});

describe("local socket", () => {
  let t: TestHub;
  let home: string;

  beforeAll(async () => {
    const fake = table([[4242, 1, "/Applications/Fake Client.app/Contents/MacOS/Fake Client"]]);
    const lookup = async (pid: number) => (pid === 4242 ? fake.lookup(4242) : { pid, ppid: 4242, started: `s${pid}`, command: "shim" });
    const dirless = { gate: { lookup, args: fake.args, alive: () => true, waitMs: 100, signer: async () => "" } };
    t = await startHubWithSocket(dirless);
    await t.api("PUT", "/api/settings", { allowTcpMcp: false });
    await t.api("POST", "/api/servers", { name: "Mock", transport: "stdio", command: process.execPath, args: [MOCK] });
    await waitFor(async () => (await t.api("GET", "/api/servers/mock")).body.state === "connected", 15_000, "mock connected");
  });

  afterAll(async () => {
    await t.stop();
  });

  async function startHubWithSocket(gate: object): Promise<TestHub> {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "mcp-hub-sock-"));
    home = dir;
    // A Unix socket in the data directory, or on Windows a named pipe.
    const hubT = await startHub({}, { dataDir: dir, configPath: join(dir, "config.json"), socketPath: socketPath(dir), ...gate });
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ pid: process.pid, port: hubT.hub.port, socket: hubT.hub.socket }));
    return hubT;
  }

  it("turns off the plain HTTP endpoint by default", async () => {
    const res = await fetch(`${t.base}/mcp/mock`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/turned off/);
  });

  it("lets an approved app use every server through the bridge", async () => {
    const child = spawn(process.execPath, [SHIM, "mock"], { env: { ...process.env, MCP_HUB_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");

    // The bridge waits while the user decides.
    await waitFor(() => t.hub.clients.list().some((c) => c.status === "pending"), 8000, "pending client");
    expect(t.hub.clients.list()[0]).toMatchObject({ name: "Fake Client" });
    expect((await t.api("GET", "/api/state")).body.clients[0].status).toBe("pending");
    expect(out).toBe("");

    const id = t.hub.clients.list()[0]!.id;
    expect((await t.api("POST", `/api/clients/${encodeURIComponent(id)}/decision`, { allow: true })).status).toBe(200);
    await waitFor(() => out.includes("mock-mcp"), 10_000, "initialize response");

    // Connecting isn't usage: the handshake leaves no trace in the usage history or on the server's totals.
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
    expect((await t.api("GET", "/api/usage?range=1h")).body.clients).toEqual([]);
    expect((await t.api("GET", "/api/servers/mock")).body).toMatchObject({ requests: 0, inUse: false });

    // A real call is counted, and the app is known by name.
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }) + "\n");
    await waitFor(() => out.includes("echo:hi"), 10_000, "tool result");
    const usage = (await t.api("GET", "/api/usage?range=1h")).body;
    expect(usage.clients.map((c: { client: string }) => c.client)).toContain("Fake Client");
    expect(usage.clients[0].requests).toBe(1);
    expect((await t.api("GET", "/api/usage?range=1h&client=Nobody")).body.totals).toEqual([]);
    const status = (await t.api("GET", "/api/servers/mock")).body;
    expect(status.clients).toMatchObject([{ name: "Fake Client", sessions: 1 }]);

    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  });

  it("tells the app when the user said no", async () => {
    const id = t.hub.clients.list()[0]!.id;
    await t.api("POST", `/api/clients/${encodeURIComponent(id)}/decision`, { allow: false });
    const child = spawn(process.execPath, [SHIM, "mock"], { env: { ...process.env, MCP_HUB_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    await waitFor(() => out.includes('"id":7'), 10_000, "denial");
    expect(out).toMatch(/was not allowed to use MCP Hub/);
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  });
});
