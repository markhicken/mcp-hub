// A tiny MCP server used by the integration tests. Speaks stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-mcp", version: "1.2.3" });

server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));

server.registerTool("env", { description: "Read an env var", inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
}));

server.registerTool("slow", { description: "Report progress then finish", inputSchema: { steps: z.number() } }, async ({ steps }, extra) => {
  const token = extra._meta?.progressToken;
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, 30));
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: steps } });
  }
  return { content: [{ type: "text", text: "done" }] };
});

server.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: "text", text: "boom" }],
}));

await server.connect(new StdioServerTransport());
process.stderr.write("mock-mcp ready\n");
