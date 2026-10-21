import { Activity, ArrowDownUp, Cable, ChevronDown, Download, Globe, LogIn, Plug, Plus, Power, PowerOff, RefreshCw, Search, Shuffle, StickyNote, Tag, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AddServerDialog } from "../AddServer";
import { api, onLog } from "../api";
import { ConnectClientDialog } from "../ConnectClient";
import { colorFor, formatBytes, formatDuration, formatNumber, timeAgo } from "../lib";
import { StatusBadge, deriveStatus } from "../status";
import type { LogLine, ServerStatus, Snapshot } from "../types";
import { Button, Card, Chip, Confirm, CopyButton, Drawer, EmptyState, PageHeader, Segmented, Spinner, Switch, cx, useNow, useToast } from "../ui";

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
  const [selected, setSelected] = useState<string | null>(focus?.id ?? null);
  const [removing, setRemoving] = useState<ServerStatus | null>(null);
  // The order shown while a reorder is being saved, so the card doesn't jump back before the hub confirms it.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    if (focus) setSelected(focus.id);
  }, [focus]);

  const ordered = useMemo(() => {
    if (!localOrder) return snap.servers;
    const rank = (id: string) => { const i = localOrder.indexOf(id); return i < 0 ? localOrder.length : i; };
    return [...snap.servers].sort((a, b) => rank(a.id) - rank(b.id));
  }, [snap.servers, localOrder]);
  useEffect(() => {
    if (localOrder && snap.servers.length === localOrder.length && snap.servers.every((s, i) => s.id === localOrder[i])) setLocalOrder(null);
  }, [snap.servers, localOrder]);

  // Reordering a filtered list would be ambiguous, so it is only offered when every server is showing.
  const labels = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const s of snap.servers) for (const l of s.config.labels ?? []) if (!byKey.has(l.toLowerCase())) byKey.set(l.toLowerCase(), l);
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [snap.servers]);
  const [label, setLabel] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  // A label that no server has any more (its last server was removed or relabeled) stops filtering.
  const activeLabel = label && labels.find((l) => l.toLowerCase() === label.toLowerCase());
  const labeled = (s: ServerStatus, l: string) => (s.config.labels ?? []).some((x) => x.toLowerCase() === l.toLowerCase());
  const filtering = query.trim() !== "" || !!activeLabel;
  const servers = useMemo(() => {
    const q = query.toLowerCase();
    return ordered.filter((s) => (!activeLabel || labeled(s, activeLabel)) && `${s.config.name} ${s.id} ${(s.config.labels ?? []).join(" ")}`.toLowerCase().includes(q));
  }, [ordered, query, activeLabel]);
  const selectedServer = snap.servers.find((s) => s.id === selected) ?? null;

  const applyLabel = (l: string | null, action: "on" | "off" | "only") =>
    act(async () => {
      const r = await api<{ on: string[]; off: string[] }>("POST", "/api/labels/apply", l === null ? { action } : { label: l, action });
      const parts = [r.on.length && `turned on ${r.on.length}`, r.off.length && `turned off ${r.off.length}`].filter(Boolean);
      const name = l ?? "All servers";
      toast(parts.length ? `${name}: ${parts.join(", ")}` : `Nothing to change for ${name}`);
    });

  /** Put `id` where `target` is (or one place earlier/later with `by`), and save the new order. */
  const moveServer = async (id: string, to: { target: string } | { by: number }) => {
    const ids = ordered.map((s) => s.id);
    const from = ids.indexOf(id);
    const dest = "target" in to ? ids.indexOf(to.target) : from + to.by;
    if (from < 0 || dest < 0 || dest >= ids.length || dest === from) return;
    ids.splice(from, 1);
    ids.splice(dest, 0, id);
    setLocalOrder(ids);
    try {
      await api("PUT", "/api/servers/order", { ids });
    } catch (e) {
      setLocalOrder(null);
      toast((e as Error).message, "error");
    }
  };

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

      {labels.length > 0 && (
        <LabelBar
          labels={labels}
          active={activeLabel || null}
          servers={snap.servers}
          onSelect={setLabel}
          onApply={(l, action) => (action === "only" && l ? setSwitching(l) : void applyLabel(l, action))}
        />
      )}

      {snap.servers.length === 0 ? (
        <EmptyState icon={<Cable className="size-6" />} title="No servers yet" body="Add the MCP servers you use, or bring them over from Claude, Cursor, Copilot or ChatGPT / Codex. MCP Hub keeps their credentials safe and shows what each one is doing.">
          <Button variant="primary" onClick={onImport}><Download className="size-4" /> Import from other apps</Button>
          <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add a server</Button>
        </EmptyState>
      ) : servers.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">{query.trim() ? `No servers match “${query}”${activeLabel ? ` with the label “${activeLabel}”` : ""}.` : `No servers have the label “${activeLabel}”.`}</p>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(310px,1fr))]">
          {servers.map((s, i) => (
            <ServerCard
              key={s.id}
              server={s}
              snap={snap}
              reorder={{
                draggable: !filtering,
                dragging: dragId === s.id,
                dropTarget: !!dragId && dragId !== s.id && overId === s.id,
                onDragStart: () => setDragId(s.id),
                onDragEnd: () => { setDragId(null); setOverId(null); },
                onDragOver: () => dragId && setOverId(s.id),
                onDrop: () => { if (dragId) void moveServer(dragId, { target: s.id }); setDragId(null); setOverId(null); },
                onMove: filtering ? undefined : (by) => void moveServer(s.id, { by }),
                canMoveEarlier: i > 0,
                canMoveLater: i < servers.length - 1,
              }}
              onOpen={() => setSelected(s.id)}
              onLabel={setLabel}
              knownLabels={labels}
              onSetLabels={(labels) => act(() => api("PUT", `/api/servers/${s.id}`, { labels }))}
              onToggle={(on) => act(() => api("POST", `/api/servers/${s.id}/${on ? "enable" : "disable"}`))}
              onSignIn={() => act(() => api("POST", `/api/servers/${s.id}/signin`), "Opening your browser…")}
              onRestart={() => act(() => api("POST", `/api/servers/${s.id}/restart`), "Restarting")}
              onConnectClient={() => setConnecting(s)}
              onEdit={() => setEditing(s)}
              onRemove={() => setRemoving(s)}
            />
          ))}
        </div>
      )}

      {adding && <AddServerDialog knownLabels={labels} onClose={() => setAdding(false)} />}
      {editing && <AddServerDialog existing={editing} knownLabels={labels} onClose={() => setEditing(null)} />}
      {switching && (() => {
        const on = snap.servers.filter((s) => labeled(s, switching));
        const off = snap.servers.filter((s) => s.config.enabled && !labeled(s, switching));
        return (
          <Confirm
            title={`Switch to “${switching}”?`}
            body={
              <div className="space-y-2">
                <p>Turns on the {on.length === 1 ? "server" : `${on.length} servers`} labeled “{switching}”: {on.map((s) => s.config.name).join(", ")}.</p>
                <p>{off.length ? `Turns off ${off.map((s) => s.config.name).join(", ")}. Apps using them lose them until they are turned back on.` : "No other server is on, so nothing is turned off."}</p>
              </div>
            }
            confirmLabel={`Switch to “${switching}”`}
            onClose={() => setSwitching(null)}
            onConfirm={() => applyLabel(switching, "only")}
          />
        );
      })()}
      {connecting && <ConnectClientDialog server={connecting} snap={snap} onClose={() => setConnecting(null)} />}
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
          onSignIn={() => act(() => api("POST", `/api/servers/${selectedServer.id}/signin`), "Opening your browser…")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- labels

/** Filter the cards by label, and turn the servers with the selected label on or off together (or switch to them). */
function LabelBar({ labels, active, servers, onSelect, onApply }: { labels: string[]; active: string | null; servers: ServerStatus[]; onSelect: (l: string | null) => void; onApply: (l: string | null, action: "on" | "off" | "only") => void }) {
  const inLabel = (l: string) => servers.filter((s) => (s.config.labels ?? []).some((x) => x.toLowerCase() === l.toLowerCase()));
  const group = active ? inLabel(active) : servers;
  const onCount = group.filter((s) => s.config.enabled).length;
  const othersOn = servers.some((s) => s.config.enabled && !group.includes(s));
  const pill = (selected: boolean) =>
    cx("inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition cursor-pointer", selected ? "border-accent-solid bg-accent-solid text-white" : "border-border bg-surface text-muted hover:border-accent/50 hover:text-fg");
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div role="group" aria-label="Filter by label" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <Tag className="mr-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <button aria-pressed={!active} onClick={() => onSelect(null)} className={pill(!active)}>All</button>
        {labels.map((l) => {
          const g = inLabel(l);
          return (
            <button key={l} aria-pressed={active === l} onClick={() => onSelect(active === l ? null : l)} className={pill(active === l)} title={`${g.filter((s) => s.config.enabled).length} of ${g.length} on`}>
              {l} <span className={active === l ? "text-white/80" : "text-muted/80"}>{g.length}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{onCount} of {group.length} on</span>
        <Button size="sm" disabled={onCount === group.length} onClick={() => onApply(active, "on")}><Power className="size-3.5" /> Turn all on</Button>
        <Button size="sm" disabled={onCount === 0} onClick={() => onApply(active, "off")}><PowerOff className="size-3.5" /> Turn all off</Button>
        {active && <Button size="sm" variant="primary" disabled={onCount === group.length && !othersOn} onClick={() => onApply(active, "only")} title="Turn these on and every other server off"><Shuffle className="size-3.5" /> Use only these</Button>}
      </div>
    </div>
  );
}

/** A "+" chip after a card's labels: opens a box to tick the labels already in use, or type a new one. Saves on each change. */
function QuickLabel({ name, current, known, onChange }: { name: string; current: string[]; known: string[]; onChange: (labels: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // The box is drawn on the page itself (not inside the card), so no card or menu can cover it.
  const toggleOpen = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 232)), top: r.bottom + 4 });
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !boxRef.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", h);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const has = (l: string) => current.some((x) => same(x, l));
  const q = draft.trim().replace(/\s+/g, " ").slice(0, 40);
  // Labels on this card are listed too (ticked), so one list is all there is to pick from.
  const all = [...new Set([...known, ...current])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const shown = all.filter((l) => l.toLowerCase().includes(q.toLowerCase()));
  const toggle = (l: string) => onChange(has(l) ? current.filter((x) => !same(x, l)) : [...current, l]);
  const addTyped = () => {
    if (!q) return;
    const existing = all.find((l) => same(l, q));
    if (!existing || !has(existing)) onChange([...current, existing ?? q]);
    setDraft("");
  };
  return (
    <div className="relative" ref={ref}>
      <button aria-label={`Add a label to ${name}`} aria-haspopup="dialog" aria-expanded={open} title="Add or choose labels" onClick={toggleOpen} className="inline-flex size-5 items-center justify-center rounded-md border border-dashed border-border text-muted hover:border-accent/50 hover:text-accent cursor-pointer">
        <Plus className="size-3" />
      </button>
      {open && pos && createPortal(
        <div ref={boxRef} role="dialog" aria-label={`Labels for ${name}`} style={{ position: "fixed", left: pos.left, top: pos.top }} className="z-30 w-56 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <input
            autoFocus
            aria-label="Find or add a label"
            value={draft}
            maxLength={40}
            placeholder="Find or add a label"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTyped();
              } else if (e.key === "Escape") setOpen(false);
            }}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
          <div className="mt-1.5 max-h-40 overflow-y-auto">
            {shown.map((l) => (
              <label key={l} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent/10">
                <input type="checkbox" checked={has(l)} onChange={() => toggle(l)} className="accent-accent" />
                <span className="truncate">{l}</span>
              </label>
            ))}
            {q && !all.some((l) => same(l, q)) && (
              <button onClick={addTyped} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-accent hover:bg-accent/10 cursor-pointer"><Plus className="size-3" /> Add “{q}”</button>
            )}
            {!shown.length && !q && <p className="px-1.5 py-1 text-xs text-muted">No labels yet. Type one to add it.</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- card

function ServerCard(props: {
  server: ServerStatus;
  snap: Snapshot;
  /** Drag-to-reorder state and handlers, plus the keyboard-friendly "Move earlier/later" menu items. */
  reorder: {
    draggable: boolean;
    dragging: boolean;
    dropTarget: boolean;
    onDragStart: () => void;
    onDragEnd: () => void;
    onDragOver: () => void;
    onDrop: () => void;
    onMove?: (by: -1 | 1) => void;
    canMoveEarlier: boolean;
    canMoveLater: boolean;
  };
  onOpen: () => void;
  onLabel: (label: string) => void;
  /** Every label in use, offered in the quick-label box. */
  knownLabels: string[];
  onSetLabels: (labels: string[]) => void;
  onToggle: (on: boolean) => void;
  onSignIn: () => void;
  onRestart: () => void;
  onConnectClient: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { server: s, snap } = props;
  const st = deriveStatus(s, snap);
  const now = useNow(15_000);
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
  // Only the content is dimmed when off: dimming the whole card would make its menu see-through.
  const dim = !on && "opacity-75";
  // The whole card opens the details; clicks on its own controls and on selected text are left alone.
  const openFromCard = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, label, [role='menu'], [role='switch']")) return;
    if (window.getSelection()?.toString()) return;
    props.onOpen();
  };

  const r = props.reorder;
  return (
    <Card
      onClick={openFromCard}
      draggable={r.draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox won't start a drag without some data.
        e.dataTransfer.setData("text/plain", s.id);
        r.onDragStart();
      }}
      onDragEnd={r.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        r.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        r.onDrop();
      }}
      className={cx("fade-in group relative cursor-pointer p-4 transition hover:border-accent/50", menu && "z-20", r.dragging && "opacity-40", r.dropTarget && "border-accent ring-2 ring-accent/40")}
    >
      <div className="flex flex-col gap-3">
      <div className={cx("flex items-start gap-3", dim)}>
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

      <div className={cx("-mt-1 flex flex-wrap items-center gap-1 pl-12", dim)}>
        {(s.config.labels ?? []).map((l) => (
          <span key={l} className="inline-flex items-center rounded-md bg-accent/10 text-[11px] font-medium text-accent">
            <button onClick={() => props.onLabel(l)} title={`Show servers labeled “${l}”`} className="inline-flex items-center gap-1 rounded-l-md py-0.5 pl-1.5 pr-1 hover:bg-accent/20 cursor-pointer">
              <Tag className="size-2.5" aria-hidden />{l}
            </button>
            <button aria-label={`Remove label ${l} from ${s.config.name}`} title="Remove label" onClick={() => props.onSetLabels((s.config.labels ?? []).filter((x) => x !== l))} className="rounded-r-md px-1 py-0.5 hover:bg-accent/20 cursor-pointer"><X className="size-2.5" /></button>
          </span>
        ))}
        <QuickLabel name={s.config.name} current={s.config.labels ?? []} known={props.knownLabels} onChange={props.onSetLabels} />
      </div>

      <div className="flex items-center gap-2">
        <div className={cx("flex min-w-0 flex-1 flex-wrap items-center gap-2", dim)}>
          <StatusBadge status={st} server={s} />
          {(st.key === "credentials" || st.key === "connecting") && <Spinner label={st.label} />}
          {s.state === "needs-auth" && <Button size="sm" variant="primary" onClick={props.onSignIn}><LogIn className="size-3.5" /> Sign in</Button>}
          {s.state === "error" && <Button size="sm" onClick={props.onRestart}><RefreshCw className="size-3.5" /> Retry</Button>}
        </div>
        <div className="relative shrink-0" ref={menuRef}>
          <Button size="sm" aria-label={`Options for ${s.config.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            Options <ChevronDown className={cx("size-3.5 transition-transform", menu && "rotate-180")} />
          </Button>
          {menu && (
            <div role="menu" className="fade-in absolute right-0 top-full z-10 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl">
              {[
                ["Open details", props.onOpen],
                ["Connect a client…", props.onConnectClient],
                ["Edit", props.onEdit],
                ["Restart", props.onRestart],
              ].map(([label, fn]) => (
                <button key={label as string} role="menuitem" onClick={() => { setMenu(false); (fn as () => void)(); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 cursor-pointer">{label as string}</button>
              ))}
              {r.onMove && (r.canMoveEarlier || r.canMoveLater) && (
                <div className="my-1 border-t border-border pt-1">
                  {r.canMoveEarlier && <button role="menuitem" onClick={() => { setMenu(false); r.onMove?.(-1); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 cursor-pointer">Move earlier</button>}
                  {r.canMoveLater && <button role="menuitem" onClick={() => { setMenu(false); r.onMove?.(1); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 cursor-pointer">Move later</button>}
                </div>
              )}
              <div className="mx-2 my-1 flex items-center justify-between px-1 text-xs text-muted">
                <span className="truncate">{s.mcpUrl}</span>
                <CopyButton text={s.mcpUrl} label="" />
              </div>
              <button role="menuitem" onClick={() => { setMenu(false); props.onRemove(); }} className="block w-full px-3 py-1.5 text-left text-sm text-bad hover:bg-bad/10 cursor-pointer">Remove…</button>
            </div>
          )}
        </div>
      </div>
      {st.key === "credentials" && <p className={cx("-mt-1 text-xs text-muted", dim)}>Approve the prompt on your device so it can start.</p>}
      {st.detail && (
        // The padding lives on this wrapper: line-clamp on an element that has its own padding lets the clipped lines show in it.
        <div className={cx("rounded-lg bg-bad/8 px-2.5 py-1.5 text-xs text-bad", dim)}>
          <p className="line-clamp-3 break-words" title={st.detail}>{st.detail}</p>
          {st.detail.length > 140 && <button onClick={props.onOpen} className="mt-1 cursor-pointer font-medium underline underline-offset-2">Show full error</button>}
        </div>
      )}

      <dl className={cx("mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs", dim)}>
        <Stat icon={<Plug className="size-3" />} label="Tools" value={s.toolCount != null ? String(s.toolCount) : "–"} />
        <Stat icon={<ArrowDownUp className="size-3" />} label="Traffic" value={formatBytes(s.bytesIn + s.bytesOut)} />
        <Stat icon={<Activity className="size-3" />} label="Last used" value={timeAgo(s.lastActivityAt, now)} />
      </dl>
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

function ServerDrawer({ server: s, snap, onClose, onEdit, onConnectClient, onSignIn }: { server: ServerStatus; snap: Snapshot; onClose: () => void; onEdit: () => void; onConnectClient: () => void; onSignIn: () => void }) {
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
        {tab === "overview" && <Overview s={s} onEdit={onEdit} onConnectClient={onConnectClient} onSignIn={onSignIn} />}
        {tab === "logs" && <Logs serverId={s.id} />}
        {tab === "tools" && <Tools server={s} />}
      </div>
    </Drawer>
  );
}

function Overview({ s, onEdit, onConnectClient, onSignIn }: { s: ServerStatus; onEdit: () => void; onConnectClient: () => void; onSignIn: () => void }) {
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
      {s.error && (
        <div className="space-y-2 rounded-lg bg-bad/10 p-3 text-sm text-bad">
          <p className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-words">{s.error}</p>
          <CopyButton text={s.error} label="Copy error" />
        </div>
      )}
      <dl className="divide-y divide-border rounded-xl border border-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2.5 text-sm"><dt className="text-muted">{k}</dt><dd className="truncate text-right font-medium">{v}</dd></div>
        ))}
      </dl>
      {s.config.notes?.trim() && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted"><StickyNote className="size-3.5" /> Notes</h3>
          <p className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-words text-sm">{s.config.notes}</p>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onConnectClient}><Cable className="size-4" /> Connect a client</Button>
        <Button onClick={onEdit}>Edit</Button>
        {s.state === "needs-auth" && <Button onClick={onSignIn}><LogIn className="size-4" /> Sign in</Button>}
        {s.config.auth === "oauth" && s.state === "connected" && <Button onClick={() => api("POST", `/api/servers/${s.id}/signout`)}>Sign out</Button>}
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
