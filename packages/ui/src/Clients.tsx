import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import { timeAgo } from "./lib";
import type { ClientInfo, ServerStatus } from "./types";
import { Button, Chip, Confirm, Dialog, PathLink, cx, useToast } from "./ui";

const DOT = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" } as const;
const StatusDot = ({ tone }: { tone: keyof typeof DOT }) => <span className={cx("size-2 shrink-0 rounded-full", DOT[tone])} />;

/** `servers` limits what an allowed app may use; leave it out to allow every server. `remember` (default) saves the choice for the app. */
export function useDecide() {
  const toast = useToast();
  return async (c: ClientInfo, allow: boolean, servers?: string[], remember?: boolean): Promise<boolean> => {
    try {
      await api("POST", `/api/clients/${encodeURIComponent(c.id)}/decision`, { allow, ...(servers ? { servers } : {}), ...(remember !== undefined ? { remember } : {}) });
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };
}

/**
 * Asked once per app, and reused to change an app's access later. Every server is ticked to begin with. The answer
 * is remembered for the app by default, so it isn't asked again after it restarts.
 */
export function ClientApproval({ client, servers, onLater, onClose }: { client: ClientInfo; servers: ServerStatus[]; onLater?: () => void; onClose?: () => void }) {
  const decide = useDecide();
  const asking = client.status === "pending";
  // An allowed app asking for servers it wasn't offered (added after it was allowed).
  const wanted = asking ? [] : client.asking.filter((id) => servers.some((s) => s.id === id));
  const [picked, setPicked] = useState<Set<string>>(() => new Set([...(client.allowed ?? servers.map((s) => s.id)), ...wanted]));
  const [remember, setRemember] = useState(() => (asking ? true : client.remembered));
  const [busy, setBusy] = useState(false);
  const leave = onLater ?? onClose ?? (() => {});

  const answer = async (allow: boolean, without: string[] = []) => {
    setBusy(true);
    const ok = await decide(client, allow, allow && servers.length ? [...picked].filter((id) => !without.includes(id)) : undefined, remember);
    setBusy(false);
    if (ok) onClose?.();
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });
  const wantedNames = wanted.map((id) => servers.find((s) => s.id === id)!.config.name);
  const asked = client.servers.filter((id) => servers.some((s) => s.id === id)).map((id) => servers.find((s) => s.id === id)!.config.name);

  return (
    <Dialog
      title={asking ? `Allow ${client.name} to use MCP Hub?` : wanted.length ? `Let ${client.name} use ${wantedNames.map((s) => `“${s}”`).join(", ")}?` : `What can ${client.name} use?`}
      subtitle={<PathLink running={client.id} path={client.path} />}
      onClose={leave}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={leave}>{asking || wanted.length ? "Decide later" : "Cancel"}</Button>
          {asking && <Button disabled={busy} onClick={() => answer(false)}>Deny</Button>}
          {wanted.length > 0 && <Button disabled={busy} onClick={() => answer(true, wanted)}>Don't allow</Button>}
          <Button variant="primary" disabled={busy || (servers.length > 0 && !picked.size)} onClick={() => answer(true)}><ShieldCheck className="size-4" /> {asking ? "Allow" : wanted.length ? "Allow selected" : "Save"}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {wanted.length > 0 && (
          <p>
            <strong>{client.name}</strong> is asking to use {wantedNames.map((s) => `“${s}”`).join(", ")}, which you haven't answered about yet. It was allowed to use only some of your servers.
          </p>
        )}
        {asking && (
          <p>
            <strong>{client.name}</strong> is asking to connect to {asked.length ? asked.map((s) => `“${s}”`).join(", ") : "your servers"} through MCP Hub.
          </p>
        )}
        {servers.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">Servers {client.name} may use ({picked.size} of {servers.length})</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(servers.map((s) => s.id)))}>All</Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>None</Button>
              </span>
            </div>
            <ul className="max-h-64 divide-y divide-border overflow-auto rounded-xl border border-border">
              {servers.map((s) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2">
                    <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                    <span className="flex-1 text-sm font-medium">{s.config.name}</span>
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{s.config.transport}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              {picked.size === servers.length ? `With every server ticked, ${client.name} can also use servers you add later.` : `${client.name} can't use the servers you leave unticked, including ones you add later.`}
            </p>
          </>
        ) : (
          <p className="text-muted">There are no servers in MCP Hub yet.</p>
        )}
        {client.running && (
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              <span className="font-medium text-fg">Remember this for {client.name}</span>
              <span className="block text-muted">{remember ? `MCP Hub won't ask again when ${client.name} restarts. Change or remove it any time in Settings.` : `You'll be asked again the next time ${client.name} starts. Nothing is saved.`}</span>
            </span>
          </label>
        )}
      </div>
    </Dialog>
  );
}

export function ClientList({ clients, servers }: { clients: ClientInfo[]; servers: ServerStatus[] }) {
  const decide = useDecide();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const editingClient = clients.find((c) => c.id === editing);
  const removingClient = clients.find((c) => c.id === removing);
  if (!clients.length) return <p className="px-5 py-4 text-sm text-muted">No apps have connected yet.</p>;
  const verdict = (c: ClientInfo) => (c.status === "allowed" ? (c.allowed ? `Allowed: ${c.allowed.filter((id) => servers.some((s) => s.id === id)).length} of ${servers.length} servers` : "Allowed: every server") : c.status === "pending" ? "Waiting for your answer" : "Denied") + (c.status === "allowed" && c.asking.some((id) => servers.some((s) => s.id === id)) ? " · asking for a new server" : "");
  const activity = (c: ClientInfo) => (c.running ? `${c.servers.length} requested · active ${timeAgo(c.lastSeen)}` : `not running · last seen ${timeAgo(c.lastSeen)}`);
  return (
    <>
    <ul className="divide-y divide-border">
      {clients.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <StatusDot tone={c.status === "allowed" ? "good" : c.status === "pending" ? "warn" : "bad"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">{c.name}{c.status !== "pending" && <Chip>{c.remembered ? "Remembered" : "This session only"}</Chip>}</div>
            <div className="truncate text-xs text-muted">{verdict(c)} · {activity(c)}</div>
            <PathLink running={c.id} path={c.path} className="font-mono text-[11px] text-muted" />
          </div>
          {c.status === "allowed" && <Button size="sm" onClick={() => setEditing(c.id)}>Choose servers…</Button>}
          {c.status !== "allowed" && <Button size="sm" variant="primary" onClick={() => setEditing(c.id)}>Allow…</Button>}
          {c.status !== "denied" && <Button size="sm" onClick={() => decide(c, false, undefined, c.status === "pending" ? true : c.remembered)}>{c.status === "allowed" ? "Revoke" : "Deny"}</Button>}
          {c.status !== "pending" && <Button size="sm" variant="ghost" onClick={() => setRemoving(c.id)}>Remove</Button>}
        </li>
      ))}
    </ul>
    {editingClient && <ClientApproval key={editingClient.id} client={{ ...editingClient, status: editingClient.status === "pending" ? "pending" : "allowed" }} servers={servers} onClose={() => setEditing(null)} />}
    {removingClient && (
      <Confirm
        title={`Remove ${removingClient.name}?`}
        body={`MCP Hub forgets what you decided about ${removingClient.name}. The next time it connects you'll be asked again, and it can't use any server until you allow it.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api("DELETE", `/api/clients/${encodeURIComponent(removingClient.id)}`);
            toast(`${removingClient.name} removed`);
          } catch (e) {
            toast((e as Error).message, "error");
          }
        }}
        onClose={() => setRemoving(null)}
      />
    )}
    </>
  );
}
