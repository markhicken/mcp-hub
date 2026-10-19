import { Check } from "lucide-react";
import { useState } from "react";
import { CodeBlock, Dialog, Segmented } from "./ui";
import type { ServerStatus, Snapshot } from "./types";

type Client = "claude-desktop" | "claude-code" | "copilot" | "cursor" | "augment" | "codex" | "other";

const clientOptions: Array<{ value: Client; label: string }> = [
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "ChatGPT / Codex" },
  { value: "copilot", label: "Copilot CLI" },
  { value: "cursor", label: "Cursor" },
  { value: "augment", label: "Augment" },
  { value: "other", label: "Other" },
];

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

/**
 * Every app connects through the MCP Hub bridge: it reaches the hub over a private local socket,
 * and the hub asks you once per app. Direct HTTP URLs are only offered when that setting is on.
 */
export function snippetsFor(client: Client, s: ServerStatus, snap: Snapshot): { intro: string; blocks: Array<{ label: string; code: string }> } {
  const { settings, shim } = snap;
  const auth = settings.requireClientToken ? { Authorization: `Bearer ${settings.clientToken}` } : undefined;
  const direct: Array<{ label: string; code: string }> = settings.allowTcpMcp ? [{ label: "Direct HTTP URL (no approval)", code: s.mcpUrl }] : [];

  if (!shim) {
    return {
      intro: "Apps connect through the mcp-hub-stdio bridge, which ships with the MCP Hub desktop app.",
      blocks: [{ label: "Bridge not found", code: "Open this page from the MCP Hub app to get a ready-made snippet." }, ...direct],
    };
  }
  const command = shim.command;
  const args = [...shim.args, s.id];
  const entry = { command, args };
  const approval = "The first time the app connects, MCP Hub asks you to allow it. One answer covers all of that app's servers until it quits.";
  // Only the server's own entry: it goes inside the app's existing "mcpServers" object.
  const json = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ [s.id]: { ...entry, ...extra } }, null, 2)
      .split("\n")
      .slice(1, -1)
      .map((l) => l.slice(2))
      .join("\n");

  switch (client) {
    case "claude-desktop":
      return { intro: `Paste this inside "mcpServers" in claude_desktop_config.json, then restart Claude Desktop. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }, ...direct] };
    case "claude-code":
      return {
        intro: `Run this once in a terminal, or paste the entry inside "mcpServers" in your project's .mcp.json. ${approval}`,
        blocks: [
          { label: "Terminal", code: `claude mcp add ${s.id} -- ${[command, ...args].map(sh).join(" ")}` },
          { label: "Entry for mcpServers", code: json() },
          ...(settings.allowTcpMcp ? [{ label: "Direct HTTP instead", code: `claude mcp add --transport http ${s.id} ${s.mcpUrl}${auth ? ` --header "Authorization: Bearer ${settings.clientToken}"` : ""}` }] : []),
        ],
      };
    case "copilot":
      return { intro: `Paste this inside "mcpServers" in ~/.copilot/mcp-config.json. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json({ type: "local", tools: ["*"] }) }, ...direct] };
    case "cursor":
      return { intro: `Paste this inside "mcpServers" in ~/.cursor/mcp.json. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }, ...direct] };
    case "augment":
      return { intro: `Paste this inside "mcpServers" in ~/.augment/settings.json (Auggie CLI), then restart Auggie. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }, ...direct] };
    case "codex":
      return {
        intro: `The ChatGPT desktop app, the Codex CLI and the Codex IDE extension all read ~/.codex/config.toml, so one entry covers them. Run this once in a terminal, or paste the table into that file. ${approval}`,
        blocks: [
          { label: "Terminal", code: `codex mcp add ${s.id} -- ${[command, ...args].map(sh).join(" ")}` },
          { label: "Table for ~/.codex/config.toml", code: `[mcp_servers.${s.id}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}` },
          ...direct,
        ],
      };
    default:
      return {
        intro: `Any app that can launch a local (stdio) MCP server can use the bridge. ${approval}`,
        blocks: [{ label: "Command", code: [command, ...args].map(sh).join(" ") }, ...direct, ...(auth ? [{ label: "Header", code: `Authorization: Bearer ${settings.clientToken}` }] : [])],
      };
  }
}

export function ConnectClientDialog({ server, snap, onClose }: { server: ServerStatus; snap: Snapshot; onClose: () => void }) {
  const [client, setClient] = useState<Client>("claude-desktop");
  const { intro, blocks } = snippetsFor(client, server, snap);
  return (
    <Dialog title={`Connect a client to ${server.config.name}`} subtitle="Point your AI app at the hub instead of the server itself." onClose={onClose} wide>
      <div className="space-y-4">
        <Segmented value={client} onChange={setClient} options={clientOptions} />
        <p className="text-sm text-muted">{intro}</p>
        {blocks.map((b) => (
          <div key={b.label} className="space-y-1.5">
            <div className="text-xs font-semibold text-muted">{b.label}</div>
            <CodeBlock code={b.code} />
          </div>
        ))}
        <p className="flex items-start gap-2 rounded-lg bg-good/10 p-3 text-xs text-good">
          <Check className="mt-0.5 size-3.5 shrink-0" />
          Credentials stay inside MCP Hub. Your client never sees the token for this server.
        </p>
      </div>
    </Dialog>
  );
}
