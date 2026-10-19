type Raw = Record<string, any>;

/** Entries that already go through MCP Hub (its bridge, or its own URL): listed, but never imported, so import never loops. */
export function pointsAtHub(raw: Raw): boolean {
  const s = JSON.stringify(raw);
  return (
    (s.includes("/mcp/") && (s.includes("127.0.0.1") || s.includes("localhost"))) ||
    s.includes("mcp-hub-stdio") ||
    s.includes("MCP Hub.app") ||
    s.includes("mcp-hub/packages/shim")
  );
}
