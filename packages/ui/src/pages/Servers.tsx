import { Activity, ArrowDownUp, Cable, Download, Globe, LogIn, MoreHorizontal, PackagePlus, Plug, Plus, RefreshCw, Search, StickyNote, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AddServerDialog } from "../AddServer";
import { api, onLog } from "../api";
import { ConnectClientDialog } from "../ConnectClient";
import { InstallDialog } from "../Install";
import { colorFor, formatBytes, formatDuration, formatNumber, timeAgo } from "../lib";
import { StatusBadge, deriveStatus } from "../status";
import type { LogLine, ServerStatus, Snapshot } from "../types";
import { Button, Card, Chip, Confirm, CopyButton, Drawer, EmptyState, PageHeader, Segmented, Switch, cx, useToast } from "../ui";

interface Props {
  snap: Snapshot;
  onImport: () => void;
  focus?: { id: string; n: number } | null;
}

export function ServersPage({ snap, onImport, focus }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ServerStatus | null>(null);
  const [connecting, setConnecting] = useState<ServerStatus | null>(null);
  const [installing, setInstalling] = useState<ServerStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(focus?.id ?? null);
  const [removing, setRemoving] = useState<ServerStatus | null>(null);

  useEffect(() => {
    if (focus) setSelected(focus.id);
  }, [focus]);

  const servers = useMemo(() => snap.servers.filter((s) => `${s.config.name} ${s.id}`.toLowerCase().includes(query.toLowerCase())), [snap.servers, query]);
  const selectedServer = snap.servers.find((s) => s.id === selected) ?? null;
  const reading = snap.credentials.reading[0];

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div>
      <PageHeader
        title="Servers"
        subtitle={snap.servers.length ? `${snap.servers.filter((s) => s.state === "connected").length} of ${snap.servers.length} connected` : "Every MCP server on this machine, in one place."}
        actions={
          <>
            <div className="relative hidden sm:block">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
              <input aria-label="Search servers" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-9 w-48 rounded-lg border border-border bg-surface pl-8 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25" />
            </div>
            <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" /> Add server</Button>
          </>
        }
      />

      {reading && (
        <div className="fade-in mb-4 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <span className="size-2 rounded-full bg-warn pulse-dot" />
          <span><strong>Waiting for {reading.sourceName}.</strong> Approve the prompt on your device so “{reading.requester}” can start.</span>
        </div>
      )}

      {snap.servers.length === 0 ? (
        <EmptyState icon={<Cable className="size-6" />} title="No servers yet" body="Add the MCP servers you use, or bring them over from Claude, Cursor, Copilot or ChatGPT / Codex. MCP Hub keeps their credentials safe and shows what each one is doing.">
          <Button variant="primary" onClick={onImport}><Download className="size-4" /> Import from other apps</Button>
          <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add a server</Button>
        </EmptyState>
      ) : servers.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">No servers match “{query}”.</p>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(310px,1fr))]">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              snap={snap}
              onOpen={() => setSelected(s.id)}
              onToggle={(on) => act(() => api("POST", `/api/servers/${s.id}/${on ? "enable" : "disable"}`))}
              onSignIn={() => act(() => api("POST", `/api/servers/${s.id}/signin`), "Opening your browser…")}
              onRestart={() => act(() => api("POST", `/api/servers/${s.id}/restart`), "Restarting")}
              onConnectClient={() => setConnecting(s)}
              onInstall={() => setInstalling(s)}
              onEdit={() => setEditing(s)}
              onRemove={() => setRemoving(s)}
            />
          ))}
        </div>
      )}

      {adding && <AddServerDialog onClose={() => setAdding(false)} />}
      {editing && <AddServerDialog existing={editing} onClose={() => setEditing(null)} />}
      {connecting && <ConnectClientDialog server={connecting} snap={snap} onClose={() => setConnecting(null)} />}
      {installing && <InstallDialog server={installing} onClose={() => setInstalling(null)} />}
      {removing && (
        <Confirm
          title={`Remove ${removing.config.name}?`}
          body="It will be disconnected and removed from MCP Hub, along with its usage history. Clients still pointing at it will stop working. The original program is not uninstalled."
          confirmLabel="Remove server"
          onClose={() => setRemoving(null)}
          onConfirm={() => act(() => api("DELETE", `/api/servers/${removing.id}`), "Removed")}
        />
      )}
      {selectedServer && (
        <ServerDrawer
          server={selectedServer}
          snap={snap}
          onClose={() => setSelected(null)}
          onEdit={() => setEditing(selectedServer)}
          onConnectClient={() => setConnecting(selectedServer)}
          onInstall={() => setInstalling(selectedServer)}
          onSignIn={() => act(() => api("POST", `/api/servers/${selectedServer.id}/signin`), "Opening your browser…")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- card

function ServerCard(props: {
  server: ServerStatus;
  snap: Snapshot;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
  onSignIn: () => void;
  onRestart: () => void;
  onConnectClient: () => void;
  onInstall: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { server: s, snap } = props;
  const st = deriveStatus(s, snap);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menu]);

  const subtitle = s.config.description ?? (s.config.transport === "http" ? s.config.url : [s.config.command, ...(s.config.args ?? [])].join(" "));
  const on = s.config.enabled;

  return (
    <Card className={cx("fade-in group relative p-4 transition hover:border-accent/50", menu && "z-20")}>
      {/* Only the content is dimmed when off: dimming the whole card would make its menu see-through. */}
      <div className={cx("flex flex-col gap-3", !on && "opacity-75")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl text-white" style={{ background: colorFor(s.id) }} aria-hidden>
          {s.config.transport === "http" ? <Globe className="size-4" /> : <Terminal className="size-4" />}
        </span>
        <button onClick={props.onOpen} className="min-w-0 flex-1 text-left cursor-pointer">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{s.config.name}</h3>
            <Chip>{s.config.transport}</Chip>
            {s.config.notes && (
              <span title={s.config.notes} aria-label="Has notes" className="shrink-0 text-muted">
                <StickyNote className="size-3.5" />
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted" title={subtitle}>{subtitle}</p>
        </button>
        <Switch checked={on} onChange={props.onToggle} label={`${on ? "Disconnect" : "Connect"} ${s.config.name}`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={st} server={s} />
        {s.state === "needs-auth" && <Button size="sm" variant="primary" onClick={props.onSignIn}><LogIn className="size-3.5" /> Sign in</Button>}
        {s.state === "error" && <Button size="sm" onClick={props.onRestart}><RefreshCw className="size-3.5" /> Retry</Button>}
      </div>
      {st.detail && <p className="line-clamp-2 rounded-lg bg-bad/8 px-2.5 py-1.5 text-xs text-bad">{st.detail}</p>}

      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
        <Stat icon={<Plug className="size-3" />} label="Tools" value={s.toolCount != null ? String(s.toolCount) : "–"} />
        <Stat icon={<ArrowDownUp className="size-3" />} label="Traffic" value={formatBytes(s.bytesIn + s.bytesOut)} />
        <Stat icon={<Activity className="size-3" />} label="Last used" value={timeAgo(s.lastActivityAt)} />
      </dl>
      </div>

      <div className="absolute right-3 top-12" ref={menuRef}>
        <button aria-label={`More actions for ${s.config.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="rounded-md p-1 text-muted opacity-0 transition hover:bg-surface-2 hover:text-fg focus:opacity-100 group-hover:opacity-100 cursor-pointer">
          <MoreHorizontal className="size-4" />
        </button>
        {menu && (
          <div role="menu" className="fade-in absolute right-0 z-10 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl">
            {[
              ["Open details", props.onOpen],
              ["Install in an app…", props.onInstall],
              ["Connect a client…", props.onConnectClient],
              ["Edit", props.onEdit],
              ["Restart", props.onRestart],
            ].map(([label, fn]) => (
              <button key={label as string} role="menuitem" onClick={() => { setMenu(false); (fn as () => void)(); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 cursor-pointer">{label as string}</button>
            ))}
            <div className="mx-2 my-1 flex items-center justify-between px-1 text-xs text-muted">
              <span className="truncate">{s.mcpUrl}</span>
              <CopyButton text={s.mcpUrl} label="" />
            </div>
            <button role="menuitem" onClick={() => { setMenu(false); props.onRemove(); }} className="block w-full px-3 py-1.5 text-left text-sm text-bad hover:bg-bad/10 cursor-pointer">Remove…</button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-muted">{icon}{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------- drawer

type Tab = "overview" | "logs" | "tools";

function ServerDrawer({ server: s, snap, onClose, onEdit, onConnectClient, onInstall, onSignIn }: { server: ServerStatus; snap: Snapshot; onClose: () => void; onEdit: () => void; onConnectClient: () => void; onInstall: () => void; onSignIn: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const st = deriveStatus(s, snap);
  return (
    <Drawer title={s.config.name} onClose={onClose}>
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h2 className="truncate text-base font-semibold">{s.config.name}</h2><StatusBadge status={st} server={s} /></div>
          <p className="mt-1 truncate font-mono text-xs text-muted">{s.mcpUrl}</p>
        </div>
        <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer"><X className="size-4" /></button>
      </header>
      <div className="border-b border-border px-5 py-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: "overview", label: "Overview" }, { value: "logs", label: "Logs" }, { value: "tools", label: "Tools" }]} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && <Overview s={s} onEdit={onEdit} onConnectClient={onConnectClient} onInstall={onInstall} onSignIn={onSignIn} />}
        {tab === "logs" && <Logs serverId={s.id} />}
        {tab === "tools" && <Tools server={s} />}
      </div>
    </Drawer>
  );
}

function Overview({ s, onEdit, onConnectClient, onInstall, onSignIn }: { s: ServerStatus; onEdit: () => void; onConnectClient: () => void; onInstall: () => void; onSignIn: () => void }) {
  const rows: Array<[string, string]> = [
    ["Server", s.serverInfo?.name ? `${s.serverInfo.name} ${s.serverInfo.version ?? ""}` : "–"],
    ["Protocol", s.protocolVersion ?? "–"],
    ["Connected for", s.connectedAt ? formatDuration(Date.now() - s.connectedAt) : "–"],
    ["Clients attached", String(s.activeSessions)],
    ["Requests", `${formatNumber(s.requests)} (${formatNumber(s.errors)} errors)`],
    ["Data in / out", `${formatBytes(s.bytesIn)} / ${formatBytes(s.bytesOut)}`],
    ["Runs", s.config.lifecycle === "keep-alive" ? "Always on" : `When needed (stops after ${s.config.idleTimeoutMinutes ?? 0} idle min)`],
  ];
  return (
    <div className="space-y-5 p-5">
      {s.error && <p className="rounded-lg bg-bad/10 p-3 text-sm text-bad">{s.error}</p>}
      <dl className="divide-y divide-border rounded-xl border border-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2.5 text-sm"><dt className="text-muted">{k}</dt><dd className="truncate text-right font-medium">{v}</dd></div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onInstall}><PackagePlus className="size-4" /> Install in an app</Button>
        <Button onClick={onConnectClient}><Cable className="size-4" /> Connect a client</Button>
        <Button onClick={onEdit}>Edit</Button>
        {s.state === "needs-auth" && <Button onClick={onSignIn}><LogIn className="size-4" /> Sign in</Button>}
        {s.config.auth === "oauth" && s.state === "connected" && <Button onClick={() => api("POST", `/api/servers/${s.id}/signout`)}>Sign out</Button>}
        <CopyButton text={s.mcpUrl} label="Copy URL" size="md" />
      </div>
    </div>
  );
}

function Logs({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api<{ lines: LogLine[] }>("GET", `/api/servers/${serverId}/logs?n=300`).then((r) => live && setLines(r.lines));
    const off = onLog((id, line) => id === serverId && setLines((l) => [...l.slice(-499), line]));
    return () => {
      live = false;
      off();
    };
  }, [serverId]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const color = { info: "text-muted", warn: "text-warn", error: "text-bad", stderr: "text-fg/70 italic" } as const;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-2">
        <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
        <Button size="sm" variant="ghost" onClick={async () => { await api("DELETE", `/api/servers/${serverId}/logs`); setLines([]); }}>Clear</Button>
      </div>
      <div ref={box} className="flex-1 overflow-y-auto bg-surface-2 p-3 font-mono text-xs leading-relaxed" role="log" aria-live="off">
        {lines.length === 0 ? <p className="p-2 text-muted">No log output yet.</p> : lines.map((l, i) => (
          <div key={i} className={cx("whitespace-pre-wrap break-words", color[l.level])}>
            <span className="mr-2 text-muted/60">{new Date(l.t).toLocaleTimeString()}</span>
            {l.level === "stderr" && <span className="mr-1 not-italic text-muted/70">[stderr]</span>}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Tools({ server }: { server: ServerStatus }) {
  const [tools, setTools] = useState<Array<{ name: string; description?: string }> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (server.state !== "connected") return;
    api<{ tools: Array<{ name: string; description?: string }> }>("GET", `/api/servers/${server.id}/tools`).then((r) => setTools(r.tools), (e) => setError((e as Error).message));
  }, [server.id, server.state]);
  if (server.state !== "connected") return <p className="p-5 text-sm text-muted">Connect this server to see its tools.</p>;
  if (error) return <p className="p-5 text-sm text-bad">{error}</p>;
  if (!tools) return <p className="p-5 text-sm text-muted">Loading…</p>;
  return (
    <ul className="divide-y divide-border">
      {tools.map((t) => (
        <li key={t.name} className="px-5 py-3">
          <div className="font-mono text-sm font-medium">{t.name}</div>
          {t.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description}</p>}
        </li>
      ))}
      {tools.length === 0 && <li className="p-5 text-sm text-muted">This server doesn't expose any tools.</li>}
    </ul>
  );
}
