import { AlertTriangle, Download, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { fileManager } from "./lib";
import { Button, Chip, Dialog, PathLink, Textarea, cx, useToast } from "./ui";

interface ExportDoc {
  servers: Array<{ name: string }>;
  sources: Array<{ name: string }>;
  localSecrets: string[];
  warnings: string[];
}

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * Used only when the hub can't show a native Save dialog (not macOS, or running in a plain browser): asks the
 * browser to save, with its own file picker where it has one.
 */
async function saveWithBrowser(filename: string, text: string): Promise<"picked" | "downloaded" | "cancelled"> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (t: string) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: filename, types: [{ description: "JSON", accept: { "application/json": [".json"] } }] });
      const out = await handle.createWritable();
      await out.write(text);
      await out.close();
      return "picked";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return "downloaded";
}

/** Saves the servers and extra credential sources to a file the user chooses. Shows what to watch out for first. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [doc, setDoc] = useState<ExportDoc | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [browserNote, setBrowserNote] = useState("");

  useEffect(() => {
    api<ExportDoc>("GET", "/api/config/export").then(setDoc, (e) => setError((e as Error).message));
  }, []);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const r = await api<{ path?: string; cancelled?: boolean; unsupported?: boolean }>("POST", "/api/config/export/save");
      if (r.path) {
        setSavedTo(r.path);
        toast("Configuration exported");
      } else if (r.unsupported && doc) {
        const how = await saveWithBrowser(`mcp-hub-config-${stamp()}.json`, JSON.stringify(doc, null, 2));
        if (how === "picked") setBrowserNote("Saved where you chose.");
        if (how === "downloaded") setBrowserNote("Your browser saved it, usually to your Downloads folder.");
      }
      // Cancelled in the dialog: nothing to do, the person can try again.
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const done = savedTo !== null || browserNote !== "";

  return (
    <Dialog
      title="Export your MCP configuration"
      subtitle="Your servers and credential sources, as one file you can keep or move to another computer."
      onClose={onClose}
      footer={
        done ? (
          <>
            {savedTo && <Button onClick={() => api("POST", "/api/config/export/reveal").catch((e) => toast((e as Error).message, "error"))}>Show in {fileManager}</Button>}
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!doc || saving} onClick={save}>
              <Download className="size-4" /> {saving ? "Choose where to save…" : "Save as…"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm">
        {error && <p className="rounded-lg bg-bad/10 p-3 text-bad">{error}</p>}
        {savedTo && (
          <div className="rounded-xl border border-good/40 bg-good/10 p-3">
            <div className="font-medium text-good">Saved</div>
            <span data-testid="saved-path"><PathLink exported wrap path={savedTo} className="mt-1 font-mono text-xs" /></span>
            <p className="mt-2 text-xs text-muted">Only you can read the file. Keep it somewhere private: it names your servers and the credentials they use.</p>
          </div>
        )}
        {browserNote && <p className="rounded-xl border border-good/40 bg-good/10 p-3 text-good">{browserNote}</p>}
        {!doc && !error && <p className="text-muted">Preparing…</p>}
        {doc && !done && (
          <>
            <div className="flex flex-wrap gap-2">
              <Chip>{doc.servers.length} server{doc.servers.length === 1 ? "" : "s"}</Chip>
              <Chip>{doc.sources.length} credential source{doc.sources.length === 1 ? "" : "s"}</Chip>
            </div>
            <p className="text-xs text-muted">
              Credential references such as <code className="font-mono">{"{{op://Vault/Item/field}}"}</code> are saved as references. Secret values are never included: not local secrets, and not anything MCP Hub has fetched.
            </p>
            {doc.warnings.length > 0 && (
              <ul className="space-y-2 rounded-xl bg-warn/10 p-3 text-xs text-warn">
                {doc.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> <span>{w}</span></li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

type Clash = "skip" | "replace" | "copy";
interface Preview {
  servers: Array<{ name: string; id: string; action: "add" | "replace" | "copy" | "skip"; reason?: string }>;
  problems: Array<{ name: string; reason: string }>;
  sources: { add: string[]; skip: Array<{ name: string; reason: string }> };
  missingLocalSecrets: string[];
}
interface Result extends Preview {
  added: string[];
  replaced: string[];
  skipped: string[];
  sourcesAdded?: string[];
  failed: Array<{ name: string; reason: string }>;
}

const ACTION: Record<Preview["servers"][number]["action"], { label: string; tone: string }> = {
  add: { label: "New", tone: "bg-good/12 text-good" },
  replace: { label: "Replaces", tone: "bg-warn/15 text-warn" },
  copy: { label: "Kept alongside", tone: "bg-accent/14 text-accent" },
  skip: { label: "Skipped", tone: "bg-surface-2 text-muted" },
};

/** Brings servers in from an exported file (or a plain mcpServers file). Always previews before changing anything. */
export function ConfigImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [data, setData] = useState<unknown>(undefined);
  const [parseError, setParseError] = useState("");
  const [onClash, setOnClash] = useState<Clash>("skip");
  const [includeSources, setIncludeSources] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (raw: string) => {
    setText(raw);
    setResult(null);
    try {
      setData(raw.trim() ? JSON.parse(raw) : undefined);
      setParseError("");
    } catch {
      setData(undefined);
      setPreview(null);
      setParseError("That isn't valid JSON.");
    }
  };

  const refresh = useCallback(async () => {
    if (data === undefined) return;
    try {
      setPreview(await api<Preview>("POST", "/api/config/import", { data, onClash, includeSources, dryRun: true }));
    } catch (e) {
      setParseError((e as Error).message);
    }
  }, [data, onClash, includeSources]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const todo = (preview?.servers.filter((s) => s.action !== "skip").length ?? 0) + (preview?.sources.add.length ?? 0);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<Result>("POST", "/api/config/import", { data, onClash, includeSources });
      setResult(r);
      toast(`Imported ${r.added.length + r.replaced.length} server${r.added.length + r.replaced.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Import a configuration"
      subtitle="From a file exported by MCP Hub, or a standard mcpServers file."
      onClose={onClose}
      wide
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!todo || busy} onClick={run}><Upload className="size-4" /> {busy ? "Importing…" : "Import"}</Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm">
        {!result && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Choose a file"
                className="text-xs file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-xs file:font-medium"
                onChange={(e) => e.target.files?.[0]?.text().then(load)}
              />
              <span className="text-xs text-muted">or paste it below</span>
            </div>
            <Textarea rows={5} value={text} onChange={(e) => load(e.target.value)} placeholder={'{ "format": "mcp-hub-config", … }'} aria-label="Configuration JSON" />
            {parseError && <p className="rounded-lg bg-bad/10 p-3 text-bad">{parseError}</p>}

            {preview && (
              <>
                <fieldset className="space-y-1 rounded-xl border border-border p-3">
                  <legend className="px-1 text-xs font-semibold text-muted">If a server is already in MCP Hub</legend>
                  {([["skip", "Skip it"], ["replace", "Replace it with the file's version"], ["copy", "Keep both"]] as const).map(([v, label]) => (
                    <label key={v} className={cx("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2", onClash === v && "bg-accent/8")}>
                      <input type="radio" name="clash" checked={onClash === v} onChange={() => setOnClash(v)} /> {label}
                    </label>
                  ))}
                  <label className="mt-1 flex cursor-pointer items-center gap-2 px-2 pt-1 text-xs text-muted">
                    <input type="checkbox" checked={includeSources} onChange={(e) => setIncludeSources(e.target.checked)} /> Also add credential sources that aren't here yet
                  </label>
                </fieldset>

                <ul className="divide-y divide-border rounded-xl border border-border">
                  {preview.servers.map((s) => (
                    <li key={s.id + s.action} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0"><span className="font-medium">{s.name}</span>{s.reason && <span className="ml-2 text-xs text-muted">{s.reason}</span>}</span>
                      <span className={cx("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium", ACTION[s.action].tone)}>{ACTION[s.action].label}</span>
                    </li>
                  ))}
                  {preview.servers.length === 0 && <li className="px-3 py-2 text-muted">No servers found in this file.</li>}
                </ul>
                {preview.sources.add.length > 0 && <p className="text-xs text-muted">Credential sources to add: {preview.sources.add.join(", ")}.</p>}
                {preview.problems.length > 0 && (
                  <ul className="space-y-1 rounded-xl bg-warn/10 p-3 text-xs text-warn">{preview.problems.map((p) => <li key={p.name + p.reason}><strong>{p.name}:</strong> {p.reason}</li>)}</ul>
                )}
                {preview.missingLocalSecrets.length > 0 && (
                  <p className="rounded-xl bg-warn/10 p-3 text-xs text-warn">These servers use local secrets that aren't in this MCP Hub yet. Add them on the Credentials page after importing: <span className="font-mono">{preview.missingLocalSecrets.join(", ")}</span>.</p>
                )}
              </>
            )}
          </>
        )}

        {result && (
          <div className="space-y-3">
            <p>
              Added {result.added.length}, replaced {result.replaced.length}, skipped {result.skipped.length}
              {result.sourcesAdded?.length ? `, and added ${result.sourcesAdded.length} credential source${result.sourcesAdded.length === 1 ? "" : "s"}` : ""}.
            </p>
            {result.failed.length > 0 && <ul className="space-y-1 rounded-xl bg-bad/10 p-3 text-xs text-bad">{result.failed.map((f) => <li key={f.name}><strong>{f.name}:</strong> {f.reason}</li>)}</ul>}
            {result.missingLocalSecrets.length > 0 && <p className="rounded-xl bg-warn/10 p-3 text-xs text-warn">Add these local secrets on the Credentials page: <span className="font-mono">{result.missingLocalSecrets.join(", ")}</span>.</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
