import { ArrowDown, ArrowUp, BarChart3, Download, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, download } from "../api";
import { colorFor, formatBytes, formatMs, formatNumber, timeAgo } from "../lib";
import type { Snapshot, UsageRange, UsageResult } from "../types";
import { Badge, Button, Card, Confirm, EmptyState, PageHeader, Segmented, Select, Skeleton, cx, useToast } from "../ui";

type Metric = "bytes" | "requests";
type SortKey = "bytes" | "requests" | "errors" | "avg" | "p95";

const REFRESH_MS = 5_000;
const RECENT_MS = 10_000;

/** Like `timeAgo`, but counts from "1s ago" so the label never switches to a wider "just now". */
function sinceLabel(t: number, now: number): string {
  const s = Math.max(1, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : timeAgo(t, now);
}

/**
 * Every app that is allowed in and still running, plus any app attached to a server (direct HTTP
 * connections never go through approval). An approved app counts even before it has a session, for
 * example when it gave up waiting for approval and hasn't retried. Refreshes itself on the page's cadence.
 */
function ConnectedApps({ snap }: { snap: Snapshot }) {
  const [live, setLive] = useState<Pick<Snapshot, "servers" | "clients"> | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const poll = () => api<Snapshot>("GET", "/api/state").then((s) => setLive({ servers: s.servers, clients: s.clients }), () => {});
    poll();
    const refresh = setInterval(poll, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  const apps = useMemo(() => {
    const { servers, clients } = live ?? snap;
    const serverName = (id: string) => servers.find((s) => s.id === id)?.config.name ?? id;
    const byId = new Map<string, { id: string; name: string; active: boolean; lastActivityAt: number | null; servers: Set<string> }>();
    const entry = (id: string, name: string) => {
      const a = byId.get(id) ?? { id, name, active: false, lastActivityAt: null, servers: new Set<string>() };
      byId.set(id, a);
      return a;
    };
    const seen = (a: { lastActivityAt: number | null }, t: number | null) => {
      if (t !== null && (a.lastActivityAt === null || t > a.lastActivityAt)) a.lastActivityAt = t;
    };
    for (const c of clients) {
      if (c.status !== "allowed" || !c.running) continue;
      const a = entry(c.id, c.name);
      seen(a, c.lastSeen);
      a.active ||= now - c.lastSeen < RECENT_MS;
      c.servers.forEach((id) => a.servers.add(serverName(id)));
    }
    for (const s of servers) {
      for (const c of s.clients) {
        const a = entry(c.id, c.name);
        a.active ||= c.active;
        seen(a, c.lastActivityAt);
        a.servers.add(s.config.name);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [live, snap, now]);

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold">Connected apps</h2>
      {apps.length === 0 ? (
        <p className="text-sm text-muted">No apps are connected right now.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {apps.map((a) => (
            <li key={a.id} title={a.servers.size ? `Using ${[...a.servers].join(", ")}` : undefined}>
              <Badge tone={a.active ? "good" : "neutral"} pulse={a.active}>{a.name}{a.lastActivityAt !== null && <span className="font-normal opacity-70"> · <span className="inline-block min-w-[7ch] tabular-nums">{sinceLabel(a.lastActivityAt, now)}</span></span>}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function UsagePage({ snap }: { snap: Snapshot }) {
  const [range, setRange] = useState<UsageRange>("24h");
  const [metric, setMetric] = useState<Metric>("bytes");
  const [server, setServer] = useState("");
  // undefined = every app; "" = traffic recorded before apps were tracked
  const [client, setClient] = useState<string | undefined>(undefined);
  const [data, setData] = useState<UsageResult | null>(null);
  const [sort, setSort] = useState<SortKey>("bytes");
  const [clearing, setClearing] = useState(false);
  const toast = useToast();
  const query = useCallback(
    () => `range=${range}${server ? `&server=${encodeURIComponent(server)}` : ""}${client !== undefined ? `&client=${encodeURIComponent(client)}` : ""}`,
    [range, server, client],
  );

  const load = useCallback(() => {
    api<UsageResult>("GET", `/api/usage?${query()}`).then(setData, () => {});
  }, [query]);

  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const name = (id: string) => snap.servers.find((s) => s.id === id)?.config.name ?? id;
  const clientName = (c: string) => c || "Not attributed";

  const totals = useMemo(() => {
    const t = data?.totals ?? [];
    const bytes = t.reduce((a, x) => a + x.bytesIn + x.bytesOut, 0);
    const requests = t.reduce((a, x) => a + x.requests, 0);
    const errors = t.reduce((a, x) => a + x.errors, 0);
    const weighted = t.reduce((a, x) => a + x.avgLatencyMs * x.requests, 0);
    return { bytes, requests, errors, avg: requests ? weighted / requests : 0, p95: Math.max(0, ...t.map((x) => x.p95LatencyMs)) };
  }, [data]);

  const { chart, ids } = useMemo(() => {
    const byT = new Map<number, Record<string, number>>();
    const ids = new Set<string>();
    for (const p of data?.points ?? []) {
      ids.add(p.serverId);
      const row = byT.get(p.t) ?? { t: p.t };
      row[p.serverId] = (row[p.serverId] ?? 0) + (metric === "bytes" ? p.bytesIn + p.bytesOut : p.requests);
      byT.set(p.t, row);
    }
    return { chart: [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number)), ids: [...ids] };
  }, [data, metric]);

  const rows = useMemo(() => {
    const v = (r: UsageResult["totals"][number]) => ({ bytes: r.bytesIn + r.bytesOut, requests: r.requests, errors: r.errors, avg: r.avgLatencyMs, p95: r.p95LatencyMs })[sort];
    return [...(data?.totals ?? [])].sort((a, b) => v(b) - v(a));
  }, [data, sort]);
  const maxBytes = Math.max(1, ...rows.map((r) => r.bytesIn + r.bytesOut));

  const fmtTick = (t: number) => {
    const d = new Date(t);
    return range === "1h" || range === "24h" ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const empty = data && data.points.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        subtitle="How much data is flowing through each server, and which app is using it. Only sizes, timings and app names are recorded, never content."
        actions={
          <>
            <Select aria-label="Server" value={server} onChange={(e) => setServer(e.target.value)} className="w-44">
              <option value="">All servers</option>
              {snap.servers.map((s) => <option key={s.id} value={s.id}>{s.config.name}</option>)}
            </Select>
            <Select aria-label="App" value={client === undefined ? "*" : client} onChange={(e) => setClient(e.target.value === "*" ? undefined : e.target.value)} className="w-44">
              <option value="*">All apps</option>
              {(data?.clients ?? []).map((c) => <option key={c.client} value={c.client}>{clientName(c.client)}</option>)}
              {client !== undefined && !(data?.clients ?? []).some((c) => c.client === client) && <option value={client}>{clientName(client)}</option>}
            </Select>
            <Segmented value={range} onChange={setRange} options={[{ value: "1h", label: "1h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }]} />
            <Button onClick={() => download(`/api/usage.csv?${query()}`, `mcp-hub-usage-${range}.csv`)}><Download className="size-4" /> CSV</Button>
            <Button onClick={() => setClearing(true)}><Trash2 className="size-4" /> Clear history</Button>
          </>
        }
      />

      {clearing && (
        <Confirm
          title={server ? `Clear usage for ${name(server)}?` : "Clear all usage history?"}
          body={`Starts ${server ? "this server" : "every server"} from a fresh slate: past traffic and request counts are deleted. This can't be undone. Servers, settings and logs are not affected.`}
          confirmLabel="Clear history"
          onClose={() => setClearing(false)}
          onConfirm={async () => {
            await api("DELETE", `/api/usage${server ? `?server=${encodeURIComponent(server)}` : ""}`);
            toast("Usage history cleared");
            setClient(undefined);
            load();
          }}
        />
      )}

      <ConnectedApps snap={snap} />

      {!data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : empty ? (
        <EmptyState icon={<BarChart3 className="size-6" />} title="No traffic yet" body={client !== undefined || server ? "Nothing matches these filters in this period." : "Once an AI app uses one of your servers through MCP Hub, its data flow shows up here."} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Data transferred" value={formatBytes(totals.bytes)} />
            <Stat label="Requests" value={formatNumber(totals.requests)} />
            <Stat label="Error rate" value={totals.requests ? `${((totals.errors / totals.requests) * 100).toFixed(1)}%` : "0%"} tone={totals.errors ? "warn" : undefined} />
            <Stat label="Latency (avg / p95)" value={`${formatMs(totals.avg)} / ${formatMs(totals.p95)}`} />
          </div>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{metric === "bytes" ? "Data over time" : "Requests over time"}</h2>
              <Segmented value={metric} onChange={setMetric} options={[{ value: "bytes", label: "Data" }, { value: "requests", label: "Requests" }]} />
            </div>
            <div className="h-64" aria-label="Usage chart" role="img">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ left: 0, right: 8, top: 4, bottom: 0 }} barCategoryGap="22%">
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="t" tickFormatter={fmtTick} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis tickFormatter={(v: number) => (metric === "bytes" ? formatBytes(v) : formatNumber(v))} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={64} />
                  <Tooltip
                    cursor={{ fill: "var(--surface-2)" }}
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
                    labelFormatter={(t) => new Date(t as number).toLocaleString()}
                    formatter={(v: number, k: string) => [metric === "bytes" ? formatBytes(v) : formatNumber(v), name(k)]}
                  />
                  {ids.map((id, i) => <Bar key={id} dataKey={id} stackId="1" fill={colorFor(id)} radius={i === ids.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={48} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
              {ids.map((id) => <span key={id} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: colorFor(id) }} />{name(id)}</span>)}
            </div>
          </Card>

          {data.clients.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">By app</h2>
              <ul className="space-y-2.5">
                {data.clients.map((c) => {
                  const maxApp = Math.max(1, ...data.clients.map((x) => x.requests));
                  const selected = client === c.client;
                  return (
                    <li key={c.client}>
                      <button onClick={() => setClient(selected ? undefined : c.client)} aria-pressed={selected} className={cx("flex w-full items-center gap-4 rounded-lg px-2 py-1.5 text-left text-sm cursor-pointer hover:bg-surface-2/60", selected && "bg-accent/10")}>
                        <span className="w-40 shrink-0 truncate font-medium">{clientName(c.client)}</span>
                        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-accent" style={{ width: `${(c.requests / maxApp) * 100}%` }} /></span>
                        <span className="w-24 shrink-0 text-right tabular-nums">{formatNumber(c.requests)} req</span>
                        <span className="w-20 shrink-0 text-right tabular-nums text-muted">{formatBytes(c.bytesIn + c.bytesOut)}</span>
                        <span className={cx("w-16 shrink-0 text-right tabular-nums", c.errors > 0 ? "text-bad" : "text-muted")}>{c.errors > 0 ? `${c.errors} err` : "no errors"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-3 font-medium">Server</th>
                    {([["bytes", "Data"], ["requests", "Requests"], ["errors", "Errors"], ["avg", "Avg"], ["p95", "p95"]] as Array<[SortKey, string]>).map(([k, label]) => (
                      <th key={k} className="px-3 py-3 text-right font-medium">
                        <button onClick={() => setSort(k)} className={cx("inline-flex items-center gap-1 cursor-pointer hover:text-fg", sort === k && "text-fg")}>{label}{sort === k && <ArrowDown className="size-3" />}</button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.serverId} className="border-b border-border last:border-0 hover:bg-surface-2/60">
                      <td className="px-4 py-3">
                        <button onClick={() => setServer(r.serverId)} className="flex items-center gap-2 font-medium cursor-pointer"><span className="size-2.5 rounded-sm" style={{ background: colorFor(r.serverId) }} />{name(r.serverId)}</button>
                        <div className="mt-1.5 h-1 w-full max-w-48 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full" style={{ width: `${((r.bytesIn + r.bytesOut) / maxBytes) * 100}%`, background: colorFor(r.serverId) }} /></div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums"><span className="inline-flex items-center gap-1"><ArrowDown className="size-3 text-muted" />{formatBytes(r.bytesIn)}</span> <span className="inline-flex items-center gap-1"><ArrowUp className="size-3 text-muted" />{formatBytes(r.bytesOut)}</span></td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatNumber(r.requests)}</td>
                      <td className={cx("px-3 py-3 text-right tabular-nums", r.errors > 0 && "text-bad")}>{formatNumber(r.errors)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatMs(r.avgLatencyMs)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatMs(r.p95LatencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Top tools</h2>
              {data.tools.length === 0 ? <p className="text-sm text-muted">No tool calls in this period.</p> : (
                <ul className="space-y-2.5">
                  {data.tools.slice(0, 8).map((t) => (
                    <li key={t.serverId + t.tool} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0"><span className="block truncate font-mono text-xs">{t.tool}</span><span className="text-xs text-muted">{name(t.serverId)}</span></span>
                      <span className="shrink-0 text-right tabular-nums">{formatNumber(t.calls)}{t.errors > 0 && <span className="ml-1 text-xs text-bad">({t.errors} err)</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx("mt-1.5 text-2xl font-semibold tracking-tight tabular-nums", tone === "warn" && "text-warn")}>{value}</div>
    </Card>
  );
}
