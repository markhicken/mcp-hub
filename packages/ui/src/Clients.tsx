import { ShieldCheck } from "lucide-react";
import { api } from "./api";
import { timeAgo } from "./lib";
import type { ClientInfo } from "./types";
import { Button, Dialog, cx, useToast } from "./ui";

const DOT = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" } as const;
const StatusDot = ({ tone }: { tone: keyof typeof DOT }) => <span className={cx("size-2 shrink-0 rounded-full", DOT[tone])} />;

export function useDecide() {
  const toast = useToast();
  return async (c: ClientInfo, allow: boolean) => {
    try {
      await api("POST", `/api/clients/${encodeURIComponent(c.id)}/decision`, { allow });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
}

/** Asked once per app: one answer covers every server that app opens until it quits. */
export function ClientApproval({ client, onLater }: { client: ClientInfo; onLater: () => void }) {
  const decide = useDecide();
  return (
    <Dialog
      title={`Allow ${client.name} to use MCP Hub?`}
      subtitle={client.path}
      onClose={onLater}
      footer={
        <>
          <Button variant="ghost" onClick={onLater}>Decide later</Button>
          <Button onClick={() => decide(client, false)}>Deny</Button>
          <Button variant="primary" onClick={() => decide(client, true)}><ShieldCheck className="size-4" /> Allow</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          <strong>{client.name}</strong> is asking to connect to {client.servers.length ? client.servers.map((s) => `“${s}”`).join(", ") : "your servers"} through MCP Hub.
        </p>
        <p className="text-muted">Your answer covers every server this app opens. You'll be asked again the next time {client.name} starts. Nothing is stored.</p>
      </div>
    </Dialog>
  );
}

export function ClientList({ clients }: { clients: ClientInfo[] }) {
  const decide = useDecide();
  if (!clients.length) return <p className="px-5 py-4 text-sm text-muted">No apps have connected since MCP Hub started.</p>;
  return (
    <ul className="divide-y divide-border">
      {clients.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <StatusDot tone={c.status === "allowed" ? "good" : c.status === "pending" ? "warn" : "bad"} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{c.name}</div>
            <div className="truncate text-xs text-muted" title={c.path}>
              {c.status === "allowed" ? "Allowed" : c.status === "pending" ? "Waiting for your answer" : "Denied"} · {c.servers.length} server{c.servers.length === 1 ? "" : "s"} · active {timeAgo(c.lastSeen)}
            </div>
          </div>
          {c.status !== "allowed" && <Button size="sm" variant="primary" onClick={() => decide(c, true)}>Allow</Button>}
          {c.status !== "denied" && <Button size="sm" onClick={() => decide(c, false)}>{c.status === "allowed" ? "Revoke" : "Deny"}</Button>}
        </li>
      ))}
    </ul>
  );
}
