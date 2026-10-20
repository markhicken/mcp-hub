import { AlertTriangle, Check, Replace } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import type { ImportSource, MigrateResponse, Snapshot } from "./types";
import { Button, Dialog, PathLink, cx, useToast } from "./ui";

const MODE: Record<string, string> = { added: "Added to MCP Hub", replaced: "Replaced in MCP Hub", reused: "Using the copy already in MCP Hub" };

/**
 * After a scan: brings an app's servers into MCP Hub and changes that app's own entries to run through it.
 * Each entry keeps its name, so the tool names the app shows don't change. The file is backed up first.
 */
export function MigrateDialog({ source, snap, preselected, onClose, onDone }: { source: ImportSource; snap: Snapshot; preselected?: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const items = source.servers.filter((s) => s.config && !s.viaHub);
  // Start from what was ticked in the scan list; if nothing was ticked for this app, start with everything.
  const [picked, setPicked] = useState<Set<string>>(() => {
    const ticked = items.filter((s) => preselected?.includes(s.name));
    return new Set((ticked.length ? ticked : items).map((s) => s.name));
  });
  const [onClash, setOnClash] = useState<"keep" | "replace">("keep");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MigrateResponse | null>(null);

  const existing = new Map(snap.servers.map((s) => [s.config.name.toLowerCase(), s]));
  const clashes = items.filter((s) => picked.has(s.name) && existing.has(s.name.toLowerCase()));

  const run = async () => {
    setBusy(true);
    try {
      setResult(await api<MigrateResponse>("POST", "/api/migrate", { client: source.client, names: [...picked], onClash }));
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const ok = result?.config.status === "added";

  return (
    <Dialog
      title={result ? (ok ? `Migrated to MCP Hub` : `Nothing was changed in ${source.client}`) : `Migrate ${source.client} to MCP Hub`}
      subtitle={result ? undefined : "Move these servers into MCP Hub and have the app use them from there."}
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!picked.size || busy} onClick={run}><Replace className="size-4" /> {busy ? "Migrating…" : `Migrate ${picked.size} server${picked.size === 1 ? "" : "s"}`}</Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-2.5 rounded-xl border border-border p-3">
            {ok ? <Check className="mt-0.5 size-4 shrink-0 text-good" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />}
            <div className="min-w-0">
              <div className="font-medium">{source.client}</div>
              <p className="mt-0.5 text-xs text-muted">{result.config.message}</p>
              <PathLink app={source.client} path={result.config.path} className="mt-1 font-mono text-[11px] text-muted" />
            </div>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {result.servers.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted">{MODE[s.mode]}</span>
              </li>
            ))}
          </ul>
          {(result.problems ?? []).length > 0 && (
            <ul className="space-y-1.5 rounded-xl bg-warn/10 p-3 text-xs text-warn">
              {result.problems!.map((p) => (
                <li key={p.name}>
                  <span className="font-medium">{p.name}</span>: {p.reason}
                  <span className="block text-muted">{p.blocked ? `${source.client}'s own entry was left unchanged. Fix this in MCP Hub, then migrate it again.` : "It was migrated, but MCP Hub could not connect to it yet."}</span>
                </li>
              ))}
            </ul>
          )}
          {result.config.skipped.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-warn/10 p-3 text-xs text-warn">{result.config.skipped.map((k) => <li key={k.name}>{k.reason}</li>)}</ul>
          )}
          {result.config.backup && (
            <p className="text-xs text-muted">
              The original file was copied to <span className="break-all font-mono">{result.config.backup}</span> first. To undo, copy it back over the config file.
            </p>
          )}
          {ok && <p className="text-xs text-muted">Restart {source.client} so it picks up the change. MCP Hub has to be running for these servers to work in it.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-border rounded-xl border border-border">
            {items.map((s) => (
              <li key={s.name}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
                  <input type="checkbox" checked={picked.has(s.name)} onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(s.name) : n.delete(s.name); return n; })} />
                  <span className="flex-1 text-sm font-medium">{s.name}{existing.has(s.name.toLowerCase()) && <span className="ml-2 text-xs font-normal text-muted">already in MCP Hub</span>}</span>
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{s.config!.transport}</span>
                </label>
              </li>
            ))}
          </ul>

          {clashes.length > 0 && (
            <fieldset className="space-y-2 rounded-xl border border-border p-3 text-sm">
              <legend className="px-1 text-xs font-semibold text-muted">{clashes.length === 1 ? "This one is already in MCP Hub" : `${clashes.length} of these are already in MCP Hub`}</legend>
              {([["keep", "Keep the copy in MCP Hub", "Point the app at the one MCP Hub already has."], ["replace", "Replace it with this app's version", "Overwrite MCP Hub's copy with the settings from this app."]] as const).map(([v, title, hint]) => (
                <label key={v} className={cx("flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2", onClash === v && "bg-accent/8")}>
                  <input type="radio" name="clash" className="mt-1" checked={onClash === v} onChange={() => setOnClash(v)} />
                  <span><span className="block font-medium">{title}</span><span className="block text-xs text-muted">{hint}</span></span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="space-y-1.5 text-xs text-muted">
            <p>MCP Hub will:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Back up <span className="font-mono">{source.path}</span> next to the original (the copy is named <span className="font-mono">…mcp-hub-backup-&lt;time&gt;</span>).</li>
              <li>Add the selected servers to MCP Hub, with secrets like <span className="font-mono">op://…</span> kept as references.</li>
              <li>Change each selected entry in that file so it runs through MCP Hub. The entry keeps its name, so tool names don't change. Everything else in the file stays as it is.</li>
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}
