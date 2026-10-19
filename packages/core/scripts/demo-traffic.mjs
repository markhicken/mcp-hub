// Dev helper: adds demo servers to a running hub and generates traffic so the UI has something to show.
//   MCP_HUB_URL=http://127.0.0.1:47999 MCP_HUB_TOKEN=devtoken node scripts/demo-traffic.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";

const base = process.env.MCP_HUB_URL ?? "http://127.0.0.1:47615";
const token = process.env.MCP_HUB_TOKEN ?? "";
const mock = join(import.meta.dirname, "..", "test", "fixtures", "mock-mcp.mjs");

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// The demo clients below use plain HTTP, which the hub keeps off by default.
await api("PUT", "/api/settings", { allowTcpMcp: true });

const demo = ["GitHub", "Filesystem", "Playwright"];
for (const name of demo) {
  await api("POST", "/api/servers", { name, transport: "stdio", command: process.execPath, args: [mock], env: { TOKEN: "demo-token" } });
}
await api("POST", "/api/servers", { name: "Broken tool", transport: "stdio", command: "definitely-not-a-command" });
await new Promise((r) => setTimeout(r, 2500));

for (const [i, name] of demo.entries()) {
  const id = name.toLowerCase();
  const c = new Client({ name: "demo", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${id}`)));
  for (let n = 0; n < 24 - i * 8; n++) await c.callTool({ name: "echo", arguments: { text: "x".repeat(200 * (n + 1)) } });
  await c.callTool({ name: "boom", arguments: {} });
  if (i === 0) await c.callTool({ name: "slow", arguments: { steps: 4 } });
  await c.close();
}
console.log("demo traffic generated");
