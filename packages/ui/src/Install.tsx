import { AlertTriangle, Check, CircleSlash, FilePlus, Minus, PackagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { AppInstallPreview, AppInstallResult, InstallPreview as Preview, InstallResult as Result, ServerStatus, Snapshot } from "./types";
import { Button, Dialog, PathLink, Segmented, cx, useToast } from "./ui";


const LOOK: Record<Result["status"], { icon: typeof Check; tone: string; label: string }> = {
  added: { icon: Check, tone: "text-good", label: "Added" },
  replaced: { icon: Check, tone: "text-good", label: "Replaced" },
  already: { icon: Check, tone: "text-good", label: "Already set up" },
  conflict: { icon: AlertTriangle, tone: "text-warn", label: "Name in use" },
  "no-file": { icon: Minus, tone: "text-muted", label: "No config file" },
  error: { icon: CircleSlash, tone: "text-bad", label: "Not changed" },
};

const PLAN: Record<Preview["status"], string> = {
  add: "Will be added",
  replace: "Will be replaced",
  already: "No change: already set up",
  conflict: "Name in use",
  "no-file": "No config file yet",
  error: "Can't be changed",
};

/**
 * Adds this server's MCP Hub entry to one app's config file (the app whose tab "Connect a client" is on). Opening
 * this only reads that one file, to say what would change; nothing is written until the confirm button is pressed.
 * If the app already has an entry for the same MCP, the dialog lists it and says it will be replaced; the file is
 * backed up first either way.
 */
export function InstallDialog({ server, client, snap, onClose }: { server: ServerStatus; client: string; snap: Snapshot; onClose: () => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const canBridge = !!snap.shim;
  const canHttp = snap.settings.allowTcpMcp;
  const [transport, setTransport] = useState<"bridge" | "http">(canBridge ? "bridge" : "http");
  const url = `/api/servers/${encodeURIComponent(server.id)}/install`;

  useEffect(() => {
    let current = true;
    setPlan(null);
    api<{ preview: Preview[] }>("POST", url, { clients: [client], dryRun: true, transport }).then(
      (r) => current && setPlan(r.preview[0] ?? null),
      (e) => toast((e as Error).message, "error"),
    );
    return () => { current = false; };
  }, [transport]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: Result[] }>("POST", url, { clients: [client], replace: plan?.status === "replace", create: plan?.status === "no-file", transport });
      setResult(r.results[0] ?? null);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const go = plan?.status === "add" || plan?.status === "replace";
  // A missing config file is only created after the user agrees, here: the button says so and the file is named above it.
  const canCreate = plan?.status === "no-file";
  const look = result ? LOOK[result.status] : null;
  const Icon = look?.icon;

  return (
    <Dialog
      title={`Install ${server.config.name} in ${client}`}
      subtitle="Adds the MCP Hub version of this server to the app's config, so the app uses it through MCP Hub."
      onClose={onClose}
      footer={
        result || (plan && !go && !canCreate) ? (
          <Button variant="primary" onClick={onClose}>{result ? "Done" : "Close"}</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={(!go && !canCreate) || busy} onClick={run}><PackagePlus className="size-4" /> {busy ? "Installing…" : canCreate ? "Create the file and install" : plan?.status === "replace" ? "Back up and replace" : "Back up and install"}</Button>
          </>
        )
      }
    >
      {canBridge && canHttp && !result && (
        <div className="mb-3 space-y-1.5">
          <Segmented value={transport} onChange={setTransport} options={[{ value: "bridge", label: "Local bridge (recommended)" }, { value: "http", label: "Direct HTTP" }]} />
          <p className="text-xs text-muted">
            {transport === "bridge"
              ? "The app launches the MCP Hub bridge, and MCP Hub asks you once before letting it in."
              : `The app connects straight to the hub's HTTP address with no approval step${snap.settings.requireClientToken ? "; the access token is written into the app's config file" : ""}. Any program on this Mac can do the same.`}
          </p>
        </div>
      )}
      {!plan ? (
        <p className="text-sm text-muted">Checking {client}'s config…</p>
      ) : result && look && Icon ? (
        <div className="flex items-start gap-3">
          <Icon className={cx("mt-0.5 size-4 shrink-0", look.tone)} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-sm font-medium">{client} <span className={cx("ml-1 text-xs font-normal", look.tone)}>{look.label}</span></div>
            <p className="text-xs text-muted">{result.message}</p>
            <PathLink app={client} path={result.path} className="font-mono text-[11px] text-muted" />
            {result.backup && <p className="pt-1 text-[11px] text-muted">Backup of the original: <PathLink app={client} backup wrap path={result.backup} className="font-mono" /></p>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">{client} <span className={cx("ml-1 text-xs font-normal", plan.status === "replace" || plan.status === "conflict" ? "text-warn" : plan.status === "error" ? "text-bad" : "text-muted")}>{PLAN[plan.status]}</span></div>
            {plan.path && <PathLink app={client} path={plan.path} className="mt-0.5 font-mono text-[11px] text-muted" />}
          </div>
          {plan.status === "replace" && (
            <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="space-y-1.5">
                <p>{client} already has this MCP in its config. Continuing replaces it with the MCP Hub version.</p>
                <ul className="space-y-1">
                  {plan.existing.map((e) => (
                    <li key={e.key}><span className="font-mono font-medium">{e.key}</span> <span className="text-muted">runs {e.summary}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {(plan.status === "conflict" || plan.status === "error" || plan.status === "no-file" || plan.status === "already") && <p className="text-xs text-muted">{plan.message}</p>}
          {canCreate && (
            <p className="text-xs text-muted">
              MCP Hub can create the file at the path above, with just this server in it. Nothing else on your computer is touched, and the app will find the file the next time it starts.
            </p>
          )}
          {go && (
            <p className="text-xs text-muted">
              Only {plan.status === "replace" ? "that entry changes" : "a new entry is added"}. The rest of the file (formatting, comments, your other servers) is left exactly as it is, and the file is copied to a backup before it changes.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The other direction: pick an app (after scanning it), then pick several of MCP Hub's servers to add to it.
 * Same safeguards as installing one server: a review step lists any same-named entries that would be
 * replaced, nothing changes until confirmed, and the app's config is backed up first (once for the batch).
 */
export function InstallInAppDialog({ client, snap, onClose, onDone }: { client: string; snap: Snapshot; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<AppInstallPreview | null>(null);
  const [result, setResult] = useState<AppInstallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (id: string) => snap.servers.find((s) => s.id === id)?.config.name ?? id;

  const check = async () => {
    setBusy(true);
    try {
      const r = await api<{ preview: AppInstallPreview }>("POST", "/api/install", { client, servers: [...picked], dryRun: true });
      // A missing config file or a same-named entry needs the user's say-so first; anything else installs straight away.
      if (r.preview.servers.some((s) => s.status === "replace") || r.preview.servers.every((s) => s.status === "no-file")) setReview(r.preview);
      else await run(false, false);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const run = async (replace: boolean, create: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ result: AppInstallResult }>("POST", "/api/install", { client, servers: [...picked], replace, create });
      setResult(r.result);
      setReview(null);
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });
  // The app has no config file yet: creating it is offered, never done silently.
  const creating = !!review && review.servers.length > 0 && review.servers.every((s) => s.status === "no-file");

  return (
    <Dialog
      title={`Install MCP Hub servers in ${client}`}
      subtitle="Adds the MCP Hub version of each server you pick to this app's config, so the app uses them through MCP Hub."
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : review ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
            <Button variant="primary" disabled={busy} onClick={() => (creating ? run(false, true) : run(true, false))}><PackagePlus className="size-4" /> {busy ? "Installing…" : creating ? "Create the file and install" : "Back up and replace"}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!picked.size || busy} onClick={check}><PackagePlus className="size-4" /> {busy ? "Checking…" : `Install${picked.size ? ` ${picked.size}` : ""}`}</Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <ul className="divide-y divide-border rounded-xl border border-border">
            {result.servers.map((s) => {
              const look = LOOK[s.status];
              const Icon = look.icon;
              return (
                <li key={s.serverId} className="flex items-start gap-3 px-3 py-3">
                  <Icon className={cx("mt-0.5 size-4 shrink-0", look.tone)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{name(s.serverId)} <span className={cx("ml-1 text-xs font-normal", look.tone)}>{look.label}</span></div>
                    <p className="mt-0.5 text-xs text-muted">{s.message}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <PathLink app={result.client} path={result.path} className="font-mono text-[11px] text-muted" />
          {result.created && <p className="text-[11px] text-muted">The config file didn't exist, so it was created (there is no backup because there was nothing to back up).</p>}
          {result.backup && <p className="text-[11px] text-muted">Backup of the original: <PathLink app={result.client} backup wrap path={result.backup} className="font-mono" /></p>}
        </div>
      ) : review && creating ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-xs">
            <FilePlus className="mt-0.5 size-4 shrink-0 text-accent" />
            <div className="space-y-1">
              <p>{client} has no config file yet. MCP Hub can create it at the path below, with just {review.servers.length === 1 ? "this server" : "these servers"} in it. Nothing else on your computer is touched, and the app will find the file the next time it starts.</p>
              {review.servers[0]?.message.includes("may not be installed") && <p className="text-muted">The app's folder doesn't exist either, so {client} may not be installed on this computer.</p>}
            </div>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {review.servers.map((s) => <li key={s.serverId} className="px-3 py-2.5 text-sm font-medium">{name(s.serverId)}</li>)}
          </ul>
          <PathLink app={review.client} path={review.path} className="font-mono text-[11px] text-muted" />
        </div>
      ) : review ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <p>
              {client} already has {review.servers.filter((s) => s.status === "replace").length === 1 ? "an entry for one of these MCPs" : "entries for some of these MCPs"}. Continuing replaces them with the MCP Hub version. The file is copied to a backup first, so the original can be restored.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {review.servers.map((s) => (
              <li key={s.serverId} className="px-3 py-3">
                <div className="text-sm font-medium">{name(s.serverId)} <span className={cx("ml-1 text-xs font-normal", s.status === "replace" || s.status === "conflict" ? "text-warn" : s.status === "error" ? "text-bad" : "text-muted")}>{PLAN[s.status]}</span></div>
                {s.status === "replace" ? (
                  <ul className="mt-1.5 space-y-1">
                    {s.existing.map((e) => (
                      <li key={e.key} className="text-xs"><span className="font-mono font-medium">{e.key}</span> <span className="text-muted">runs {e.summary}</span></li>
                    ))}
                  </ul>
                ) : s.status === "conflict" || s.status === "error" ? (
                  <p className="mt-0.5 text-xs text-muted">{s.message}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <PathLink app={review.client} path={review.path} className="font-mono text-[11px] text-muted" />
        </div>
      ) : snap.servers.length === 0 ? (
        <p className="text-sm text-muted">There are no servers in MCP Hub yet. Add or import one first.</p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-border rounded-xl border border-border">
            {snap.servers.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
                  <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                  <span className="flex-1 text-sm font-medium">{s.config.name}</span>
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{s.config.transport}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Only new entries are added. The rest of the file (formatting, comments, your other servers) is left exactly as it is. If {client} already has one of these MCPs, you'll see what would be replaced and confirm first. The file is copied to a backup before it changes.
          </p>
        </div>
      )}
    </Dialog>
  );
}
