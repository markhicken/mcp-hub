import { useRef, useState } from "react";
import { timeAgo } from "./lib";
import { Badge } from "./ui";
import type { ServerStatus, Snapshot } from "./types";

export type Tone = "good" | "warn" | "bad" | "accent" | "neutral";

export interface DerivedStatus {
  key: "off" | "connecting" | "credentials" | "needs-auth" | "error" | "in-use" | "authenticated" | "idle";
  label: string;
  tone: Tone;
  pulse?: boolean;
  detail?: string;
}

/** One human-friendly status for a server, combining connection, credential and traffic state. */
export function deriveStatus(s: ServerStatus, snap: Snapshot): DerivedStatus {
  if (!s.config.enabled && s.state === "disconnected") return { key: "off", label: "Off", tone: "neutral" };
  if (s.state === "needs-auth") return { key: "needs-auth", label: "Needs sign-in", tone: "warn" };
  if (s.state === "error") return { key: "error", label: "Error", tone: "bad", detail: s.error };
  if (s.state === "connecting") {
    if (s.credentials === "resolving") {
      const reading = snap.credentials.reading.find((r) => r.requester === s.id);
      return { key: "credentials", label: reading ? `Waiting for ${reading.sourceName}` : "Waiting for credentials…", tone: "warn", pulse: true };
    }
    return { key: "connecting", label: "Connecting…", tone: "accent", pulse: true };
  }
  if (s.state === "connected") {
    if (s.inUse) {
      const apps = s.clients.filter((c) => c.active).length;
      return { key: "in-use", label: apps > 1 ? `In use · ${apps} apps` : "In use", tone: "accent", pulse: true };
    }
    if (s.authenticated) return { key: "authenticated", label: "Authenticated", tone: "good" };
    return { key: "idle", label: "Idle", tone: "good" };
  }
  return { key: "off", label: "Not connected", tone: "neutral" };
}

/** The badge; hovering it lists the apps attached to the server and which of them are using it. */
export function StatusBadge({ status, server }: { status: DerivedStatus; server?: ServerStatus }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const clients = server?.clients ?? [];
  const badge = (
    <Badge tone={status.tone} pulse={status.pulse}>
      {status.label}
    </Badge>
  );
  if (!clients.length) return badge;

  const active = clients.filter((c) => c.active);
  const idle = clients.filter((c) => !c.active);
  const show = () => ref.current && setRect(ref.current.getBoundingClientRect());
  const hide = () => setRect(null);
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 280)) : 0;
  const below = rect ? rect.bottom + 6 : 0;

  return (
    <span ref={ref} tabIndex={0} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      {badge}
      {rect && (
        <div role="tooltip" style={{ position: "fixed", left, top: below, width: 264 }} className="fade-in z-50 rounded-xl border border-border bg-surface p-3 text-left text-xs shadow-xl">
          {active.length > 0 && <Group title="In use by" clients={active} />}
          {idle.length > 0 && <Group title={active.length ? "Also connected" : "Connected apps"} clients={idle} className={active.length ? "mt-2.5" : ""} />}
        </div>
      )}
    </span>
  );
}

function Group({ title, clients, className }: { title: string; clients: ServerStatus["clients"]; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <ul className="space-y-1">
        {clients.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`size-1.5 shrink-0 rounded-full ${c.active ? "bg-accent pulse-dot" : "bg-border"}`} />
              <span className="truncate font-medium text-fg">{c.name}</span>
            </span>
            <span className="shrink-0 text-muted">{c.inFlight > 0 ? `${c.inFlight} running` : c.lastActivityAt ? timeAgo(c.lastActivityAt) : "connected"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
