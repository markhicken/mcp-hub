import { AlertTriangle, CheckCircle2, Download, ExternalLink, LogIn, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { SetupStatus, Snapshot } from "./types";
import { Button, CodeBlock, cx } from "./ui";

export interface Setup {
  /** What is missing for this source, or undefined when it is off or ready: only sources that are on are ever shown. */
  problem: (sourceId: string) => SetupStatus | undefined;
  /** A finished install or sign-in to tell the user about, for this source. */
  done: (sourceId: string) => { title: string; body: string } | undefined;
  dismiss: () => void;
  check: () => void;
  checking: boolean;
  busy: string | null;
  error: { id: string; text: string } | null;
  act: (s: SetupStatus, action: "install" | "sign-in") => Promise<void>;
}

/**
 * Looks for the tools the credential sources that are switched on need (1Password's CLI, the Vault CLI and a token).
 * Everything is configured automatically; a source that is off is never checked or mentioned. The check runs again
 * whenever a source is switched on or off or its options change (installing a CLI sets its path), so it never goes stale.
 */
export function useSetup(snap: Snapshot): Setup {
  const [statuses, setStatuses] = useState<SetupStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [done, setDone] = useState<{ sourceId: string; title: string; body: string } | null>(null);

  const check = useCallback(() => {
    setChecking(true);
    api<{ statuses: SetupStatus[] }>("GET", "/api/credentials/setup")
      .then((r) => setStatuses(r.statuses), () => setStatuses([]))
      .finally(() => setChecking(false));
  }, []);
  const key = snap.sources.map((s) => `${s.id}:${s.enabled}:${JSON.stringify(s.options)}`).join("|");
  useEffect(check, [check, key]);

  const act = async (s: SetupStatus, action: "install" | "sign-in") => {
    setBusy(`${s.sourceId}:${action}`);
    setError(null);
    try {
      const r = await api<{ version?: string }>("POST", `/api/credentials/setup/${encodeURIComponent(s.sourceId)}/${action}`);
      const text =
        action === "sign-in"
          ? { title: "Signed in to Vault.", body: "MCP Hub can now read secrets from Vault." }
          : s.type === "vault"
            ? { title: `Vault CLI ${r.version} installed.`, body: "Next, press Sign in to get a Vault token." }
            : { title: `1Password CLI ${r.version} installed.`, body: "One last step: in the 1Password app, open Settings → Developer and turn on “Integrate with 1Password CLI”, so secrets only need an approval in the app." };
      setDone({ sourceId: s.sourceId, ...text });
      check();
    } catch (e) {
      setError({ id: s.sourceId, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const enabled = (id: string) => snap.sources.find((x) => x.id === id)?.enabled === true;
  return {
    problem: (id) => (enabled(id) ? statuses.find((s) => s.sourceId === id && !s.ready) : undefined),
    done: (id) => (enabled(id) && done?.sourceId === id ? done : undefined),
    dismiss: () => setDone(null),
    check,
    checking,
    busy,
    error,
    act,
  };
}

/** What a source that is on still needs, shown inside that source's own card with the quickest fix first. */
export function SetupNotice({ source, setup }: { source: { id: string; type: string }; setup: Setup }) {
  const s = setup.problem(source.id);
  const done = setup.done(source.id);
  if (!s && !done) return null;
  const tool = source.type === "vault" ? "HashiCorp's official Vault CLI" : "1Password's official, signed CLI";
  const { busy, act } = setup;

  return (
    <div className="space-y-3">
      {done && (
        <div className="fade-in flex items-start gap-3 rounded-lg border border-good/40 bg-good/10 px-3 py-2.5 text-xs">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" />
          <div className="flex-1">
            <strong>{done.title}</strong>
            <p className="mt-0.5 text-muted">{done.body}</p>
          </div>
          <button aria-label="Dismiss" onClick={setup.dismiss} className="cursor-pointer text-muted hover:text-fg"><X className="size-4" /></button>
        </div>
      )}

      {s && (
        <div className="space-y-3 rounded-lg border border-warn/50 bg-warn/10 p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <h4 className="text-xs font-semibold">Needs setup</h4>
              <p className="mt-0.5 text-xs text-muted">{s.detail}</p>
            </div>
            <Button size="sm" variant="ghost" disabled={setup.checking} onClick={setup.check}><RefreshCw className={cx("size-3.5", setup.checking && "animate-spin")} /> Check again</Button>
          </div>

          {s.canInstall && (
            <div className="space-y-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => act(s, "install")}>
                <Download className="size-4" /> {busy === `${s.sourceId}:install` ? "Installing…" : "Install for me"}
              </Button>
              <p className="text-xs text-muted">Downloads {tool} into MCP Hub's own folder. Nothing else on your computer changes.</p>
            </div>
          )}
          {s.canSignIn && (
            <div className="space-y-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => act(s, "sign-in")}>
                <LogIn className="size-4" /> {busy === `${s.sourceId}:sign-in` ? "Waiting for sign-in…" : "Sign in"}
              </Button>
              <p className="text-xs text-muted">{s.signInMethod === "oidc" || !s.signInMethod ? "Opens your browser so you can sign in to Vault." : `Signs in with the “${s.signInMethod}” method.`}</p>
            </div>
          )}
          {setup.error?.id === s.sourceId && <p role="alert" className="text-xs text-bad">{setup.error.text}</p>}

          {s.help && (
            <details open={!s.canInstall && !s.canSignIn} className="group text-xs">
              {(s.canInstall || s.canSignIn) && <summary className="cursor-pointer text-muted hover:text-fg">{s.canSignIn ? "Sign in from a terminal instead" : "Install it yourself instead"}</summary>}
              <div className="mt-2 space-y-3">
                {!s.canInstall && !s.canSignIn && <div className="font-semibold">{s.help.title}</div>}
                <ol className="list-decimal space-y-1.5 pl-5 text-muted">{s.help.steps.map((t) => <li key={t}>{t}</li>)}</ol>
                {s.help.commands.map((c) => <CodeBlock key={c} code={c} />)}
                <div className="flex flex-wrap gap-3">
                  {s.help.links.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                      {l.label} <ExternalLink className="size-3" />
                    </a>
                  ))}
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
