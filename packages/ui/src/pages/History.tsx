import { History as HistoryIcon, KeyRound, Lock, Search, Server, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, onHistory } from "../api";
import type { HistoryEvent, HistoryKind, HistoryResult, Snapshot } from "../types";
import { Button, Card, Confirm, EmptyState, Input, PageHeader, Segmented, Skeleton, cx, useToast } from "../ui";

type Filter = "all" | "secrets" | "apps" | "servers";

const FILTER_KINDS: Record<Filter, HistoryKind[] | null> = {
  all: null,
  secrets: ["secret", "preload", "vault"],
  apps: ["app"],
  servers: ["server", "config"],
};

const PAGE = 100;

const dayLabel = (t: number): string => {
  const d = new Date(t);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

const timeLabel = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

function look(e: HistoryEvent): { icon: typeof KeyRound; tone: string } {
  const problem = e.kind === "secret" && e.outcome !== "read" && e.outcome !== "memory";
  const icon = e.kind === "secret" || e.kind === "preload" ? KeyRound : e.kind === "app" ? ShieldCheck : e.kind === "server" ? Server : e.kind === "vault" ? Lock : Wrench;
  const tone = problem || (e.kind === "server" && (e.action === "failed" || e.action === "needs-sign-in")) ? "bg-warn/15 text-warn" : e.kind === "secret" && e.outcome === "read" ? "bg-accent/12 text-accent" : "bg-surface-2 text-muted";
  return { icon, tone };
}

export function HistoryPage({ snap }: { snap: Snapshot }) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<HistoryResult | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const fetchPage = useCallback(
    (before?: number): Promise<HistoryResult> => {
      const kinds = FILTER_KINDS[filter];
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (query) params.set("q", query);
      if (kinds) params.set("kind", kinds.join(","));
      if (before) params.set("before", String(before));
      return api<HistoryResult>("GET", `/api/history?${params}`);
    },
    [filter, query],
  );

  const reload = useCallback(() => {
    const mine = ++seq.current;
    fetchPage().then(
      (r) => mine === seq.current && setData(r),
      (e) => toast((e as Error).message, "error"),
    );
  }, [fetchPage, toast]);

  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);
  useEffect(() => onHistory(reload), [reload]);

  const more = async () => {
    const last = data?.events.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const next = await fetchPage(last.id);
      setData((d) => (d ? { ...d, events: [...d.events, ...next.events], more: next.more } : next));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const days: Array<{ label: string; events: HistoryEvent[] }> = [];
  for (const e of data?.events ?? []) {
    const label = dayLabel(e.t);
    const g = days.at(-1);
    if (g && g.label === label) g.events.push(e);
    else days.push({ label, events: [e] });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="History"
        subtitle={`Everything MCP Hub did that you'd want to know about: secrets read, apps let in, servers started. Kept for ${snap.settings.retentionDays} days (change this in Settings). Secret values and commands are never recorded.`}
        actions={<Button size="sm" disabled={!data?.events.length} onClick={() => setConfirmClear(true)}><Trash2 className="size-3.5" /> Clear</Button>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by server, app, source or reason" aria-label="Search history" className="pl-9" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[{ value: "all", label: "All" }, { value: "secrets", label: "Secrets" }, { value: "apps", label: "Apps" }, { value: "servers", label: "Servers" }]}
        />
      </div>

      {!data ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : !data.events.length ? (
        <EmptyState icon={<HistoryIcon className="size-6" />} title={query || filter !== "all" ? "Nothing matches" : "Nothing yet"} body={query || filter !== "all" ? "Try a different search or filter." : "Reads of your secrets, apps asking for access and servers starting or stopping show up here as they happen."} />
      ) : (
        <div className="space-y-5">
          {days.map((g) => (
            <section key={g.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{g.label}</h2>
              <Card className="divide-y divide-border">
                {g.events.map((e) => {
                  const { icon: Icon, tone } = look(e);
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                      <span className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", tone)}><Icon className="size-3.5" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{e.title}</div>
                        {e.trigger && <div className="mt-0.5 text-xs text-muted">{e.trigger}</div>}
                      </div>
                      <time dateTime={new Date(e.t).toISOString()} title={new Date(e.t).toLocaleString()} className="shrink-0 pt-0.5 text-xs tabular-nums text-muted">{timeLabel(e.t)}</time>
                    </div>
                  );
                })}
              </Card>
            </section>
          ))}
          {data.more && <div className="text-center"><Button disabled={loadingMore} onClick={more}>{loadingMore ? "Loading…" : "Show older"}</Button></div>}
        </div>
      )}

      {confirmClear && (
        <Confirm
          title="Clear the history?"
          body="This forgets every entry shown here. It doesn't change any setting, server or secret."
          confirmLabel="Clear history"
          onConfirm={async () => {
            await api("DELETE", "/api/history");
            toast("History cleared");
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
