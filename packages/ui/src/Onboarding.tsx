import { Cable, Check, Download, KeyRound, LifeBuoy, PackagePlus, Replace, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { RecoveryKeyPanel } from "./Encryption";
import { InstallInAppDialog } from "./Install";
import type { ImportApp, ImportSource, ServerConfig, Snapshot } from "./types";
import { MigrateDialog } from "./Migrate";
import { Button, Dialog, useToast } from "./ui";

/**
 * Brings in servers configured in other apps. Nothing is read from another app until the user
 * presses Scan for it, so the list below starts out as plain names and paths.
 */
export function ImportPanel({ snap, onDone }: { snap: Snapshot; onDone?: () => void }) {
  const toast = useToast();
  const [apps, setApps] = useState<ImportApp[] | null>(null);
  // undefined = not scanned yet, null = scanned and nothing usable found
  const [found, setFound] = useState<Record<string, ImportSource | null>>({});
  const [scanning, setScanning] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState<ImportSource | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [asking, setAsking] = useState<Array<{ name: string; id: string; config: ServerConfig }> | null>(null);
  const existingByName = new Map(snap.servers.map((s) => [s.config.name.toLowerCase(), s]));
  const existing = new Set(existingByName.keys());

  useEffect(() => {
    api<{ apps: ImportApp[] }>("GET", "/api/import/apps").then((r) => setApps(r.apps), (e) => toast((e as Error).message, "error"));
  }, []);

  const scan = async (client?: string) => {
    setScanning(client ?? "*");
    try {
      const r = await api<{ sources: ImportSource[] }>("GET", `/api/import/scan${client ? `?client=${encodeURIComponent(client)}` : ""}`);
      setFound((f) => {
        const next = { ...f };
        for (const a of client ? [client] : (apps ?? []).map((x) => x.client)) next[a] = r.sources.find((s) => s.client === a) ?? null;
        return next;
      });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setScanning(null);
    }
  };

  const key = (c: string, n: string) => `${c}::${n}`;
  const all = Object.values(found).flatMap((s) => (s ? s.servers.flatMap((x) => (x.config ? [{ name: x.name, config: x.config, client: s.client }] : [])) : []));

  /** Same-named servers need a decision first; everything else imports straight away. */
  const startImport = () => {
    const chosen = all.filter((x) => picked.has(key(x.client, x.name)));
    const clashes = chosen.flatMap((x) => {
      const cur = existingByName.get(x.name.toLowerCase());
      return cur ? [{ name: x.name, id: cur.id, config: x.config }] : [];
    });
    if (clashes.length) setAsking(clashes);
    else void doImport("copy");
  };

  const doImport = async (mode: "replace" | "copy") => {
    setAsking(null);
    setBusy(true);
    const servers = all
      .filter((x) => picked.has(key(x.client, x.name)))
      .map((x) => {
        const cur = existingByName.get(x.name.toLowerCase());
        return mode === "replace" && cur ? { ...x.config, replaceId: cur.id } : x.config;
      });
    try {
      await api("POST", "/api/import", { servers });
      toast(`Imported ${servers.length} server${servers.length === 1 ? "" : "s"}`);
      setPicked(new Set());
      for (const c of Object.keys(found)) if (found[c]) await scan(c);
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!apps) return <p className="px-5 py-4 text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-muted">MCP Hub only reads another app's config file when you ask. Pick an app to look at, or scan all of them. Originals are never changed.</p>
        <Button size="sm" disabled={scanning !== null} onClick={() => scan()}><Search className="size-3.5" /> {scanning === "*" ? "Scanning…" : "Scan all"}</Button>
      </div>
      <ul className="space-y-3">
        {apps.map((app) => {
          const src = found[app.client];
          return (
            <li key={app.client} className="rounded-xl border border-border">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{app.client}</div>
                  <div className="truncate font-mono text-[11px] text-muted" title={app.path}>{app.path}</div>
                </div>
                {src !== undefined && snap.servers.length > 0 && <Button size="sm" onClick={() => setInstalling(app.client)}><PackagePlus className="size-3.5" /> Install…</Button>}
                {src && src.servers.some((x) => x.config && !x.viaHub) && <Button size="sm" variant="primary" onClick={() => setMigrating(src)}><Replace className="size-3.5" /> Migrate to MCP Hub…</Button>}
                <Button size="sm" disabled={scanning !== null} onClick={() => scan(app.client)}>{scanning === app.client ? "Scanning…" : src === undefined ? "Scan" : "Rescan"}</Button>
              </div>
              {src === null && <p className="border-t border-border px-3 py-2.5 text-xs text-muted">No MCP servers found here.</p>}
              {src && (
                <ul className="divide-y divide-border border-t border-border">
                  {src.servers.map((s) => {
                    const k = key(src.client, s.name);
                    const dup = existing.has(s.name.toLowerCase());
                    if (s.viaHub || !s.config) {
                      return (
                        <li key={k} className="flex items-center gap-3 px-3 py-2.5 text-muted">
                          <input type="checkbox" disabled aria-label={`${s.name} already uses MCP Hub`} />
                          <span className="flex-1 text-sm font-medium">{s.name}</span>
                          <span className="inline-flex items-center gap-1 rounded-md bg-good/12 px-1.5 py-0.5 text-[11px] font-medium text-good"><Check className="size-3" /> Already uses MCP Hub</span>
                        </li>
                      );
                    }
                    return (
                      <li key={k}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
                          <input type="checkbox" checked={picked.has(k)} onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(k) : n.delete(k); return n; })} />
                          <span className="flex-1 text-sm font-medium">{s.name}{dup && <span className="ml-2 text-xs font-normal text-muted">already added</span>}</span>
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{s.config.transport}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {all.length > 0 && (
        <div className="flex justify-end">
          <Button variant="primary" disabled={!picked.size || busy} onClick={startImport}><Download className="size-4" /> Import {picked.size || ""}</Button>
        </div>
      )}
      {migrating && <MigrateDialog source={migrating} snap={snap} preselected={[...picked].filter((k) => k.startsWith(`${migrating.client}::`)).map((k) => k.slice(migrating.client.length + 2))} onClose={() => setMigrating(null)} onDone={() => { setPicked((p) => new Set([...p].filter((k) => !k.startsWith(`${migrating.client}::`)))); void scan(migrating.client); }} />}
      {installing && <InstallInAppDialog client={installing} snap={snap} onClose={() => setInstalling(null)} onDone={() => void scan(installing)} />}
      {asking && (
        <Dialog
          title={asking.length === 1 ? `Replace “${asking[0]!.name}”?` : `Replace ${asking.length} servers you already have?`}
          onClose={() => setAsking(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
              <Button onClick={() => doImport("copy")}>Add as copies</Button>
              <Button variant="primary" onClick={() => doImport("replace")}>Replace</Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>{asking.length === 1 ? "A server with this name is already in MCP Hub." : "These servers are already in MCP Hub:"}</p>
            {asking.length > 1 && <ul className="list-disc pl-5">{asking.map((a) => <li key={a.id}>{a.name}</li>)}</ul>}
            <p className="text-muted"><strong>Replace</strong> swaps in the imported settings and keeps the existing server's address, so apps already pointing at it keep working. Its on/off state is kept. <strong>Add as copies</strong> keeps both, and the copy gets a new address.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function ImportDialog({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  return (
    <Dialog title="Import from other apps" subtitle="Pick the servers you want MCP Hub to manage." onClose={onClose} wide>
      <div className="-m-5"><ImportPanel snap={snap} onDone={onClose} /></div>
    </Dialog>
  );
}

const STEPS: Array<{ icon: typeof Sparkles; title: string; body: string; kind?: "recovery" }> = [
  { icon: Sparkles, title: "One hub for every MCP server", body: "MCP Hub runs your MCP servers in one place and gives every AI app a single, stable address to use. You can see what's connected and how much each one is doing." },
  { icon: KeyRound, title: "Credentials are encrypted", body: "Tokens come from 1Password, your keychain or Vault when a server needs them. They're held encrypted in memory, never written to disk, and forgotten after a time you choose. Secrets you add yourself are encrypted before they're saved." },
  { icon: LifeBuoy, title: "Save your recovery key", body: "Your secrets are locked with a key kept in your computer's keychain. If that is ever deleted, or you move to a new computer, this copy is the only way to get them back. Keep it in a password manager.", kind: "recovery" },
  { icon: Cable, title: "Bring in what you already have", body: "Import servers from Claude, Cursor, Copilot or ChatGPT / Codex, then point those apps at MCP Hub using the “Connect a client” snippets." },
];

export function Welcome({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const Icon = step.icon;
  const last = i === STEPS.length - 1;
  const { encryption } = snap.credentials;
  // Nobody is stuck here: with no usable keychain there is no key to save, and "Skip for now" is always offered.
  const mustSave = step.kind === "recovery" && encryption.persistent && !snap.settings.recoveryKeySaved;
  return (
    <Dialog
      title="Welcome to MCP Hub"
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto flex gap-1.5" aria-hidden>{STEPS.map((_, j) => <span key={j} className={`size-1.5 rounded-full ${j === i ? "bg-accent" : "bg-border"}`} />)}</div>
          {i > 0 && <Button variant="ghost" onClick={() => setI(i - 1)}>Back</Button>}
          {mustSave && <Button variant="ghost" onClick={() => setI(i + 1)}>Skip for now</Button>}
          <Button variant="primary" disabled={mustSave} onClick={() => (last ? onClose() : setI(i + 1))}>{last ? "Get started" : "Next"}</Button>
        </>
      }
    >
      <div className="fade-in flex flex-col items-center py-4 text-center" key={i}>
        <div className="mb-5 grid size-16 place-items-center rounded-2xl bg-accent/12 text-accent"><Icon className="size-8" /></div>
        <h3 className="text-lg font-semibold">{step.title}</h3>
        <p className="mt-2 max-w-sm text-sm text-muted">{step.body}</p>
        {step.kind === "recovery" && (
          <div className="mt-4 w-full max-w-md text-left">
            <RecoveryKeyPanel encryption={encryption} saved={snap.settings.recoveryKeySaved} />
          </div>
        )}
        {last && snap.servers.length === 0 && <p className="mt-4 text-xs text-muted">You can import servers from the Servers page or Settings.</p>}
      </div>
    </Dialog>
  );
}
