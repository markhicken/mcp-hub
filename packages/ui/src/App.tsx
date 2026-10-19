import { BarChart3, KeyRound, Server, Settings as SettingsIcon, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { api, initToken, startEvents, useStore } from "./api";
import { ClientApproval } from "./Clients";
import { ImportDialog, Welcome } from "./Onboarding";
import { CredentialsPage } from "./pages/Credentials";
import { ServersPage } from "./pages/Servers";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";
import { useTheme } from "./theme";
import { EmptyState, Skeleton, ToastProvider, cx } from "./ui";

type Page = "servers" | "credentials" | "usage" | "settings";

const NAV: Array<{ id: Page; label: string; icon: typeof Server }> = [
  { id: "servers", label: "Servers", icon: Server },
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function pageFromHash(): Page {
  const h = window.location.hash.replace("#/", "") as Page;
  return NAV.some((n) => n.id === h) ? h : "servers";
}

export function App() {
  const [token] = useState(initToken);
  const { snapshot: snap, connected, unauthorized } = useStore();
  const [page, setPage] = useState<Page>(pageFromHash);
  const [theme, setTheme] = useTheme();
  const [importing, setImporting] = useState(false);
  const [intro, setIntro] = useState(false);
  const [introDismissed, setIntroDismissed] = useState(false);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [later, setLater] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (token) startEvents();
  }, [token]);
  useEffect(() => {
    const h = () => setPage(pageFromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const go = (p: Page) => {
    window.location.hash = `#/${p}`;
    setPage(p);
  };

  if (!token || unauthorized) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState icon={<KeyRound className="size-6" />} title="Open MCP Hub from the app" body="This page needs the secure link that MCP Hub generates each time it starts. Open it from the MCP Hub window or menu-bar icon." />
      </div>
    );
  }

  const connectedCount = snap?.servers.filter((s) => s.state === "connected").length ?? 0;
  const problemServer = snap?.servers.find((s) => s.state === "error" || s.state === "needs-auth");
  const problem = !!problemServer;
  const problemCount = snap?.servers.filter((s) => s.state === "error" || s.state === "needs-auth").length ?? 0;
  const showProblem = () => {
    if (!problemServer) return;
    setFocus((f) => ({ id: problemServer.id, n: (f?.n ?? 0) + 1 }));
    go("servers");
  };
  const showWelcome = snap && ((!snap.settings.onboarded && !introDismissed) || intro);
  const askAbout = snap?.clients.find((c) => c.status === "pending" && !later.has(c.id));

  return (
    <ToastProvider>
      <div className="flex h-full">
        <nav aria-label="Main" className="flex w-56 shrink-0 flex-col border-r border-border bg-surface/60 p-3 max-sm:w-14">
          <div className="mb-4 flex items-center gap-2.5 px-2 pt-1">
            <span className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-accent to-purple-500 text-white shadow-sm">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="2.5" /><circle cx="5" cy="6" r="1.5" /><circle cx="19" cy="6" r="1.5" /><circle cx="5" cy="18" r="1.5" /><circle cx="19" cy="18" r="1.5" /><path d="M10 10.5 6 7M14 10.5 18 7M10 13.5 6 17M14 13.5 18 17" /></svg>
            </span>
            <span className="text-sm font-semibold max-sm:hidden">MCP Hub</span>
          </div>
          <ul className="space-y-0.5">
            {NAV.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button onClick={() => go(id)} aria-current={page === id ? "page" : undefined} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition cursor-pointer", page === id ? "bg-accent/12 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                  <Icon className="size-4 shrink-0" />
                  <span className="max-sm:hidden">{label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-auto space-y-2 px-2 pb-1 text-xs text-muted max-sm:hidden">
            <div className="flex items-start gap-2">
              <span className={cx("mt-1 size-2 shrink-0 rounded-full", !connected ? "bg-bad" : problem ? "bg-warn" : "bg-good")} />
              {!connected ? (
                "Reconnecting…"
              ) : (
                <div className="min-w-0">
                  <div>{connectedCount} connected</div>
                  {problem && (
                    <button onClick={showProblem} title={`Open ${problemServer?.config.name}`} className="cursor-pointer text-left font-medium text-warn underline-offset-2 hover:underline">
                      {problemCount} need{problemCount === 1 ? "s" : ""} attention
                    </button>
                  )}
                </div>
              )}
            </div>
            {snap && <div>v{snap.version}</div>}
          </div>
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {!connected && snap && (
            <div className="flex items-center justify-center gap-2 bg-warn/15 px-4 py-1.5 text-xs text-warn" role="alert"><WifiOff className="size-3.5" /> Lost connection to MCP Hub. Trying to reconnect…</div>
          )}
          <div className="mx-auto max-w-6xl p-6 sm:p-8">
            {!snap ? (
              <div className="space-y-4"><Skeleton className="h-8 w-48" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}</div></div>
            ) : (
              <div key={page} className="fade-in">
                {page === "servers" && <ServersPage snap={snap} onImport={() => setImporting(true)} focus={focus} />}
                {page === "credentials" && <CredentialsPage snap={snap} />}
                {page === "usage" && <UsagePage snap={snap} />}
                {page === "settings" && <SettingsPage snap={snap} theme={theme} setTheme={setTheme} onIntro={() => setIntro(true)} />}
              </div>
            )}
          </div>
        </main>
      </div>
      {snap && importing && <ImportDialog snap={snap} onClose={() => setImporting(false)} />}
      {snap && askAbout && !showWelcome && <ClientApproval client={askAbout} onLater={() => setLater((s) => new Set(s).add(askAbout.id))} />}
      {snap && showWelcome && (
        <Welcome
          snap={snap}
          onClose={() => {
            setIntro(false);
            setIntroDismissed(true);
            void api("PUT", "/api/settings", { onboarded: true });
          }}
        />
      )}
    </ToastProvider>
  );
}
