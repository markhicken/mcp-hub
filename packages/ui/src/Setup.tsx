import { AlertTriangle, CheckCircle2, Download, ExternalLink, LogIn, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { SetupStatus, Snapshot } from "./types";
import { Button, Card, CodeBlock, cx } from "./ui";

/**
 * Appears only when 1Password or the keychain can't be used yet, with the quickest fix first. Everything is
 * configured automatically; when nothing is wrong this renders nothing.
 */
export function SetupSection({ snap }: { snap: Snapshot }) {
  const [statuses, setStatuses] = useState<SetupStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [done, setDone] = useState<{ title: string; body: string } | null>(null);

  const check = useCallback(() => {
    setChecking(true);
    api<{ statuses: SetupStatus[] }>("GET", "/api/credentials/setup")
      .then((r) => setStatuses(r.statuses), () => setStatuses([]))
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check, snap.sources.length]);

  const act = async (s: SetupStatus, action: "install" | "sign-in") => {
    setBusy(`${s.sourceId}:${action}`);
    setError(null);
    try {
      const r = await api<{ version?: string }>("POST", `/api/credentials/setup/${encodeURIComponent(s.sourceId)}/${action}`);
      if (action === "sign-in") setDone({ title: "Signed in to Vault.", body: "MCP Hub can now read secrets from Vault." });
      else if (s.type === "vault") setDone({ title: `Vault CLI ${r.version} installed.`, body: "Next, press Sign in to get a Vault token." });
      else setDone({ title: `1Password CLI ${r.version} installed.`, body: "One last step: in the 1Password app, open Settings → Developer and turn on “Integrate with 1Password CLI”, so secrets only need an approval in the app." });
      check();
    } catch (e) {
      setError({ id: s.sourceId, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const name = (s: SetupStatus) => snap.sources.find((x) => x.id === s.sourceId)?.name ?? s.type;
  const tool = (s: SetupStatus) => (s.type === "vault" ? "HashiCorp's official Vault CLI" : "1Password's official, signed CLI");
  const needs = statuses.filter((s) => !s.ready);
  if (!needs.length && !done) return null;

  return (
    <section className="space-y-3">
      {done && (
        <div className="fade-in flex items-start gap-3 rounded-xl border border-good/40 bg-good/10 px-4 py-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" />
          <div className="flex-1">
            <strong>{done.title}</strong>
            <p className="mt-0.5 text-xs text-muted">{done.body}</p>
          </div>
          <button aria-label="Dismiss" onClick={() => setDone(null)} className="text-muted hover:text-fg cursor-pointer"><X className="size-4" /></button>
        </div>
      )}

      {needs.length > 0 && (
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Needs setup</h2>
          <Button size="sm" variant="ghost" disabled={checking} onClick={check}><RefreshCw className={cx("size-3.5", checking && "animate-spin")} /> Check again</Button>
        </div>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {needs.map((s) => (
          <Card key={s.sourceId} className="space-y-3 border-warn/50 p-5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{name(s)}</h3>
                <p className="mt-0.5 text-xs text-muted">{s.detail}</p>
              </div>
            </div>

            {s.canInstall && (
              <div className="space-y-2">
                <Button variant="primary" disabled={busy !== null} onClick={() => act(s, "install")}>
                  <Download className="size-4" /> {busy === `${s.sourceId}:install` ? "Installing…" : "Install for me"}
                </Button>
                <p className="text-xs text-muted">Downloads {tool(s)} into MCP Hub's own folder. Nothing else on your computer changes.</p>
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
            {error?.id === s.sourceId && <p role="alert" className="text-xs text-bad">{error.text}</p>}

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
          </Card>
        ))}
      </div>
    </section>
  );
}
