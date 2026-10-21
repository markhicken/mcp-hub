import { Check, Eye, EyeOff, PackagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { InstallDialog } from "./Install";
import { Button, CodeBlock, CopyButton, Dialog, PathLink, Segmented } from "./ui";
import type { ServerStatus, Snapshot } from "./types";

type Client = "claude-desktop" | "claude-code" | "copilot" | "cursor" | "vscode" | "augment" | "codex" | "other";

const clientOptions: Array<{ value: Client; label: string }> = [
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "ChatGPT / Codex" },
  { value: "copilot", label: "Copilot CLI" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "augment", label: "Augment" },
  { value: "other", label: "Other" },
];

/** The app's name as Install knows it; "other" has no config file to edit. */
const INSTALL_NAME: Partial<Record<Client, string>> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  codex: "ChatGPT / Codex",
  copilot: "GitHub Copilot CLI",
  cursor: "Cursor",
  vscode: "VS Code",
  augment: "Augment",
};

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

/**
 * Every app connects through the MCP Hub bridge: it reaches the hub over a private local socket,
 * and the hub asks you once per app. The Direct HTTP section (URL and token) is shown separately, when that setting is on.
 */
export function snippetsFor(client: Client, s: ServerStatus, snap: Snapshot): { intro: string; blocks: Array<{ label: string; code: string }> } {
  const { shim } = snap;

  if (!shim) {
    return {
      intro: "Apps connect through the mcp-hub-stdio bridge, which ships with the MCP Hub desktop app.",
      blocks: [{ label: "Bridge not found", code: "Open this page from the MCP Hub app to get a ready-made snippet." }],
    };
  }
  const command = shim.command;
  const args = [...shim.args, s.id];
  const entry = { command, args };
  const approval = "The first time the app connects, MCP Hub asks you to allow it. One answer covers all of that app's servers, and MCP Hub remembers it for that app.";
  // Only the server's own entry: it goes inside the app's existing "mcpServers" object.
  const json = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ [s.id]: { ...entry, ...extra } }, null, 2)
      .split("\n")
      .slice(1, -1)
      .map((l) => l.slice(2))
      .join("\n");

  switch (client) {
    case "claude-desktop":
      return { intro: `Paste this inside "mcpServers" in the app's config file, then restart Claude Desktop. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }] };
    case "claude-code":
      return {
        intro: `Run this once in a terminal, or paste the entry inside "mcpServers" in your project's .mcp.json. ${approval}`,
        blocks: [
          { label: "Terminal", code: `claude mcp add ${s.id} -- ${[command, ...args].map(sh).join(" ")}` },
          { label: "Entry for mcpServers", code: json() },
        ],
      };
    case "copilot":
      return { intro: `Paste this inside "mcpServers" in the app's config file. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json({ type: "local", tools: ["*"] }) }] };
    case "cursor":
      return { intro: `Paste this inside "mcpServers" in the app's config file. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }] };
    case "vscode":
      return { intro: `Paste this inside "servers" in the app's config file (or Command Palette → MCP: Open User Configuration). ${approval}`, blocks: [{ label: "Entry for servers", code: json({ type: "stdio" }) }] };
    case "augment":
      return { intro: `Paste this inside "mcpServers" in the app's config file (Auggie CLI), then restart Auggie. ${approval}`, blocks: [{ label: "Entry for mcpServers", code: json() }] };
    case "codex":
      return {
        intro: `The ChatGPT desktop app, the Codex CLI and the Codex IDE extension all read the same config file, so one entry covers them. Run this once in a terminal, or paste the table into that file. ${approval}`,
        blocks: [
          { label: "Terminal", code: `codex mcp add ${s.id} -- ${[command, ...args].map(sh).join(" ")}` },
          { label: "Table for the Codex config file", code: `[mcp_servers.${s.id}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}` },
        ],
      };
    default:
      return {
        intro: `Any app that can launch a local (stdio) MCP server can use the bridge. ${approval}`,
        blocks: [{ label: "Command", code: [command, ...args].map(sh).join(" ") }],
      };
  }
}

export function ConnectClientDialog({ server, snap, onClose }: { server: ServerStatus; snap: Snapshot; onClose: () => void }) {
  const [client, setClient] = useState<Client>("claude-desktop");
  const [installing, setInstalling] = useState<string | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    api<{ apps: Array<{ client: string; path: string }> }>("GET", "/api/import/apps").then((r) => setPaths(Object.fromEntries(r.apps.map((a) => [a.client, a.path]))), () => {});
  }, []);
  const { intro, blocks } = snippetsFor(client, server, snap);
  const token = snap.settings.allowTcpMcp && snap.settings.requireClientToken ? snap.settings.clientToken : "";
  const httpCommand = `claude mcp add --transport http ${server.id} ${server.mcpUrl}${token ? ` --header "Authorization: Bearer ${token}"` : ""}`;
  const installName = INSTALL_NAME[client];
  const configPath = installName ? paths[installName] : undefined;
  return (
    <>
    <Dialog title={`Connect a client to ${server.config.name}`} subtitle="Point your AI app at the hub instead of the server itself." onClose={onClose} wide>
      <div className="space-y-4">
        <Segmented value={client} onChange={setClient} options={clientOptions} />
        {installName && configPath && (
          <div className="min-w-0 text-xs text-muted">
            Config file: <PathLink app={installName} path={configPath} className="inline-block align-bottom font-mono" />
          </div>
        )}
        {installName && (snap.shim || snap.settings.allowTcpMcp) && (
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Install it for me</h3>
              <p className="mt-0.5 text-xs text-muted">Adds the entry to {installName}'s config file. You'll review it first, and the file is backed up before anything changes.</p>
            </div>
            <Button variant="primary" onClick={() => setInstalling(installName)}><PackagePlus className="size-4" /> Preview &amp; install…</Button>
          </section>
        )}
        <p className="text-sm text-muted">{installName && (snap.shim || snap.settings.allowTcpMcp) ? <><strong className="font-semibold text-fg">Or do it yourself.</strong> </> : null}{intro}</p>
        {blocks.map((b) => (
          <div key={b.label} className="space-y-1.5">
            <div className="text-xs font-semibold text-muted">{b.label}</div>
            <CodeBlock code={b.code} />
          </div>
        ))}
        {snap.settings.allowTcpMcp && (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <div>
              <h3 className="text-sm font-semibold">Direct HTTP (no approval)</h3>
              <p className="mt-0.5 text-xs text-muted">For apps that can't use the bridge. Any program on this Mac can use this address{snap.settings.requireClientToken ? " with the token" : ""}.</p>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-muted">URL</div>
              <CodeBlock code={server.mcpUrl} />
            </div>
            {token && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-muted">Access token <span className="font-normal">(send as "Authorization: Bearer …")</span></div>
                <div className="flex items-center gap-2">
                  <code style={{ width: `calc(${token.length}ch + 1rem)` }} className="inline-block max-w-full shrink-0 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">{reveal ? token : "•".repeat(token.length)}</code>
                  <Button size="sm" variant="ghost" aria-label={reveal ? "Hide token" : "Reveal token"} onClick={() => setReveal((r) => !r)}>{reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
                  <CopyButton text={token} />
                </div>
              </div>
            )}
            {client === "claude-code" && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-muted">Terminal</div>
                <CodeBlock code={httpCommand} shown={token && !reveal ? httpCommand.replace(token, "•".repeat(token.length)) : undefined} />
              </div>
            )}
          </section>
        )}
        <p className="flex items-start gap-2 rounded-lg bg-good/10 p-3 text-xs text-good">
          <Check className="mt-0.5 size-3.5 shrink-0" />
          Credentials stay inside MCP Hub. Your client never sees the token for this server.
        </p>
      </div>
    </Dialog>
    {installing && <InstallDialog key={installing} server={server} client={installing} snap={snap} onClose={() => setInstalling(null)} />}
    </>
  );
}
