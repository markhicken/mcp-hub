import { AlertTriangle, CheckCircle2, Eraser, KeyRound, LogIn, Pencil, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { EncryptionCard } from "../Encryption";
import { ForgetAfterSelect, SignInTtlSelect } from "../ForgetAfter";
import { timeAgo, timeUntil } from "../lib";
import { SetupSection } from "../Setup";
import type { SourceConfig, SourceType, Snapshot } from "../types";
import { Badge, Button, Card, Chip, Confirm, Dialog, EmptyState, Field, Input, PageHeader, Select, Switch, cx, useToast } from "../ui";

const TYPE_INFO: Record<SourceType, { label: string; scheme: string; example: string; blurb: string }> = {
  "1password": { label: "1Password", scheme: "op://", example: "{{op://Vault/Item/field}}", blurb: "Reads secrets through the 1Password CLI. Approve the prompt in the 1Password app when asked." },
  keychain: { label: "OS keychain", scheme: "keychain://", example: "{{keychain://service/account}}", blurb: "macOS Keychain, Windows Credential Manager or Linux libsecret." },
  vault: { label: "HashiCorp Vault", scheme: "vault://", example: "{{vault://path/to/secret#field}}", blurb: "Reads KV secrets from a Vault server using a token." },
  env: { label: "Environment", scheme: "env://", example: "{{env://NAME}}", blurb: "Reads variables from the hub's environment, including your shell profile. Off by default: when on, any server definition can read any variable the hub can see." },
  manual: { label: "Local secrets", scheme: "secret://", example: "{{secret://name}}", blurb: "Secrets you add to MCP Hub. Encrypted with AES-256-GCM and saved on this computer, with the key kept in your OS keychain." },
};

export function CredentialsPage({ snap }: { snap: Snapshot }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SourceConfig | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [addSecret, setAddSecret] = useState(false);
  const cached = snap.credentials.cached;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Credentials"
        subtitle="Where secrets come from, and what MCP Hub is holding in memory right now."
        actions={<Button variant="danger" onClick={() => setForgetting(true)} disabled={!cached.length}><Eraser className="size-4" /> Forget all</Button>}
      />

      {snap.credentials.reading.length > 0 && (
        <div className="fade-in flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <span className="size-2 rounded-full bg-warn pulse-dot" />
          <span><strong>Waiting for {snap.credentials.reading[0]!.sourceName}.</strong> Approve the prompt on your device.</span>
        </div>
      )}

      <SetupSection snap={snap} />

      <section className="space-y-4">
        {!snap.credentials.encryption.persistent && !snap.credentials.encryption.locked && (
          <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              <strong>Secrets can't be saved to disk right now.</strong> {snap.credentials.encryption.problem ?? "No OS key store is available."}
              <span className="mt-0.5 block text-xs text-muted">Local secrets you add stay in memory (still encrypted) and are forgotten when MCP Hub quits.</span>
            </div>
          </div>
        )}

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-good" /> In memory now</h2>
            <div className="flex items-center gap-3">
              <Chip>{cached.length} secret{cached.length === 1 ? "" : "s"}</Chip>
              <label className="flex items-center gap-2 text-xs text-muted">
                Forget after
                <ForgetAfterSelect className="w-40" value={snap.settings.cacheTtlSeconds} onChange={(v) => api("PUT", "/api/settings", { cacheTtlSeconds: v }).then(() => toast(v ? "Saved. Secrets already held follow the new time." : "Saved. Secrets are kept until you forget them."), (e) => toast((e as Error).message, "error"))} />
              </label>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted">Held encrypted ({snap.credentials.encryption.algorithm}) and decrypted only for the moment a server starts or a request needs them.</p>
          {cached.length === 0 ? (
            <p className="text-sm text-muted">Nothing cached. Secrets are fetched the first time a server needs them and forgotten after the time above, when you forget all, or when you quit.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {cached.map((c) => (
                <li key={c.sourceId + c.ref} className="flex items-center justify-between gap-3 py-2">
                  <span className="truncate font-mono text-xs" title={c.ref}>{c.ref}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{c.expiresAt ? `forgotten ${timeUntil(c.expiresAt)}` : "until forgotten"}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Forget ${c.ref}`}
                    onClick={() => api("DELETE", "/api/credentials/cached", { sourceId: c.sourceId, ref: c.ref }).then(() => toast("Forgotten. It is read again the next time a server needs it."), (e) => toast((e as Error).message, "error"))}
                  >
                    <Eraser className="size-3.5" /> Forget
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <RememberedSignIns snap={snap} />

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4 text-accent" /> Local secrets</h2>
            <Button size="sm" onClick={() => setAddSecret(true)}><Plus className="size-3.5" /> Add</Button>
          </div>
          <p className="mb-3 text-xs text-muted">
            {snap.credentials.encryption.persistent
              ? `Encrypted with ${snap.credentials.encryption.algorithm} and saved on this computer. The key is kept in ${snap.credentials.encryption.keyStore}, never in MCP Hub's own files.`
              : `Encrypted with ${snap.credentials.encryption.algorithm}, in memory only.`}
          </p>
          {snap.credentials.manualSecrets.length === 0 ? (
            <p className="text-sm text-muted">Secrets you add here are encrypted. Reference them as <code className="font-mono text-xs">{"{{secret://name}}"}</code>.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {snap.credentials.manualSecrets.map((n) => (
                <li key={n} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs">{`{{secret://${n}}}`} <span className="ml-2 text-muted">••••••••</span></span>
                  <button aria-label={`Delete ${n}`} onClick={() => api("DELETE", `/api/secrets/${encodeURIComponent(n)}`).catch((e) => toast((e as Error).message, "error"))} className="text-muted hover:text-bad cursor-pointer"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <EncryptionCard encryption={snap.credentials.encryption} recoveryKeySaved={snap.settings.recoveryKeySaved} />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Sources</h2>
          <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" /> Add source</Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {snap.sources.map((s) => <SourceCard key={s.id} source={s} vaultAddress={snap.environment.vaultAddress} onEdit={() => setEditing(s)} />)}
        </div>
        {snap.sources.length === 0 && <EmptyState icon={<KeyRound className="size-6" />} title="No sources" body="Add a credential source to start." />}
      </section>

      {adding && <SourceDialog vaultAddress={snap.environment.vaultAddress} onClose={() => setAdding(false)} />}
      {editing && <SourceDialog existing={editing} vaultAddress={snap.environment.vaultAddress} onClose={() => setEditing(null)} />}
      {addSecret && <AddSecretDialog onClose={() => setAddSecret(false)} />}
      {forgetting && (
        <Confirm title="Forget everything in memory?" body="MCP Hub forgets every secret it has fetched from 1Password, the keychain and other sources. Connected servers keep running, but anything that restarts will ask the source again. Local secrets and remembered sign-ins stay encrypted on disk." confirmLabel="Forget all" onClose={() => setForgetting(false)} onConfirm={() => api("POST", "/api/credentials/lock").then(() => toast("Secrets cleared from memory"))} />
      )}
    </div>
  );
}

function RememberedSignIns({ snap }: { snap: Snapshot }) {
  const toast = useToast();
  const [forgetting, setForgetting] = useState<{ id: string; name: string } | null>(null);
  const { available, remembered } = snap.credentials.signIns;
  const remember = snap.settings.rememberSignIns;
  const nameOf = (id: string) => snap.servers.find((s) => s.id === id)?.config.name ?? id;

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><LogIn className="size-4 text-accent" /> Remembered sign-ins</h2>
        <div className="flex items-center gap-3">
          <Chip>{remembered.length} saved</Chip>
          <label className="flex items-center gap-2 text-xs text-muted">
            Forget after
            <SignInTtlSelect className="w-40" value={snap.settings.signInTtlSeconds} onChange={(v) => api("PUT", "/api/settings", { signInTtlSeconds: v }).then(() => toast(v ? "Saved. Sign-ins older than that were forgotten." : "Saved. Sign-ins are kept until you forget them."), (e) => toast((e as Error).message, "error"))} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            Remember sign-ins by default
            <Switch checked={remember} label="Remember sign-ins by default" onChange={(v) => api("PUT", "/api/settings", { rememberSignIns: v }).then(() => toast(v ? "Sign-ins will be remembered" : "Saved. Servers that follow the default forgot their sign-ins"), (e) => toast((e as Error).message, "error"))} />
          </label>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted">
        {available
          ? `Sign-ins to servers that use OAuth, encrypted (${snap.credentials.encryption.algorithm}) and saved on this computer, so a restart doesn't need a new browser sign-in. Each server can override this default in its settings.`
          : "Sign-ins can't be saved right now because encryption isn't available (see below). They are kept in memory and you sign in again after a restart."}
      </p>
      {remembered.length === 0 ? (
        <p className="text-sm text-muted">{remember ? "Nothing saved yet. A sign-in is saved the next time you sign in to a server." : "Nothing saved. Turn on the default above, or turn it on for a single server in its settings."}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {remembered.map((r) => (
            <li key={r.serverId} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{nameOf(r.serverId)}</span>
                <span className="block text-xs text-muted">
                  saved {timeAgo(r.savedAt)} ·{" "}
                  {snap.settings.signInTtlSeconds > 0 && `forgotten ${timeUntil(r.savedAt + snap.settings.signInTtlSeconds * 1000)} unless renewed · `}
                  {r.refreshable ? "renews itself" : r.accessExpiresAt ? (r.accessExpiresAt > Date.now() ? `expires ${timeUntil(r.accessExpiresAt)}` : "expired") : "no expiry given"}
                </span>
              </span>
              <Button size="sm" onClick={() => setForgetting({ id: r.serverId, name: nameOf(r.serverId) })}>Forget</Button>
            </li>
          ))}
        </ul>
      )}
      {forgetting && (
        <Confirm
          title={`Forget the sign-in to ${forgetting.name}?`}
          body="MCP Hub deletes the saved sign-in and signs out of this server, so it disconnects. You'll need to sign in again in your browser."
          confirmLabel="Forget sign-in"
          onClose={() => setForgetting(null)}
          onConfirm={() => api("POST", `/api/servers/${forgetting.id}/signout`).then(() => toast("Sign-in forgotten"), (e) => toast((e as Error).message, "error"))}
        />
      )}
    </Card>
  );
}

function SourceCard({ source: s, vaultAddress, onEdit }: { source: SourceConfig; vaultAddress: string | null; onEdit: () => void }) {
  const toast = useToast();
  const info = TYPE_INFO[s.type];
  const [result, setResult] = useState<{ ok: boolean; message: string; hint?: "sign-in" } | null>(null);
  const [testing, setTesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [token, setToken] = useState("");
  const builtin = s.type === "env" || s.type === "manual";

  const test = async () => {
    setTesting(true);
    try {
      setResult(await api("POST", `/api/sources/${s.id}/test`));
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };
  const signIn = async () => {
    setSigningIn(true);
    try {
      await api("POST", `/api/credentials/setup/${s.id}/sign-in`);
      await test();
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message, hint: "sign-in" });
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{s.name}</h3>
          <p className="mt-0.5 text-xs text-muted">{info.blurb}</p>
        </div>
        <Switch checked={s.enabled} label={`Enable ${s.name}`} onChange={(v) => api("PUT", `/api/sources/${s.id}`, { enabled: v }).catch((e) => toast((e as Error).message, "error"))} />
      </div>
      <p className="font-mono text-xs text-muted">Use as <span className="text-fg">{info.example}</span></p>
      {(Object.keys(s.options).length > 0 || (s.type === "vault" && vaultAddress)) && (
        <div className="flex flex-wrap gap-1.5">
          {s.type === "vault" && !s.options.address && vaultAddress && <Chip>address: {vaultAddress} (VAULT_ADDR)</Chip>}
          {Object.entries(s.options).filter(([, v]) => v).map(([k, v]) => <Chip key={k}>{k}: {v}</Chip>)}
        </div>
      )}
      {s.type === "vault" && s.options.tokenSource === "manual" && (
        <div className="flex gap-2">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Vault token (encrypted)" autoComplete="off" aria-label="Vault token" />
          <Button disabled={!token} onClick={async () => { await api("PUT", `/api/sources/${s.id}/token`, { value: token }); setToken(""); toast("Token stored in memory"); }}>Set</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={testing} onClick={test}>{testing ? "Testing…" : "Test connection"}</Button>
        {!builtin && <Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="size-3.5" /> Edit</Button>}
        {!builtin && <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>Remove</Button>}
      </div>
      {result && (
        <div className="space-y-2">
          <p className={cx("flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs", result.ok ? "bg-good/10 text-good" : "bg-bad/10 text-bad")}>
            {result.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
            <span className="min-w-0 break-words">{result.message}</span>
          </p>
          {result.hint === "sign-in" && (
            <Button size="sm" variant="primary" disabled={signingIn} onClick={signIn}><LogIn className="size-3.5" /> {signingIn ? "Waiting for sign-in…" : "Sign in"}</Button>
          )}
        </div>
      )}
      {removing && <Confirm title={`Remove ${s.name}?`} body="Servers that use this source's references will fail to start until you add it again." confirmLabel="Remove" onClose={() => setRemoving(false)} onConfirm={() => api("DELETE", `/api/sources/${s.id}`).then(() => undefined)} />}
    </Card>
  );
}

function SourceDialog({ existing, vaultAddress, onClose }: { existing?: SourceConfig; vaultAddress: string | null; onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<SourceType>(existing?.type ?? "1password");
  const [name, setName] = useState(existing?.name ?? "");
  // Editing keeps every option the form doesn't show (for example the path of an installed CLI).
  const [opts, setOpts] = useState<Record<string, string>>({ mount: "secret", kvVersion: "2", tokenSource: "env", ...(existing?.options ?? {}) });
  const [error, setError] = useState("");
  const set = (k: string, v: string) => setOpts((o) => ({ ...o, [k]: v }));
  const types = (Object.keys(TYPE_INFO) as SourceType[]).filter((t) => t !== "env" && t !== "manual");

  const save = async () => {
    try {
      const options = type === "vault" ? opts : type === "1password" ? { ...(existing?.options ?? {}), opPath: opts.opPath ?? "", account: opts.account ?? "", allowedVaults: opts.allowedVaults ?? "" } : (existing?.options ?? {});
      const label = name.trim() || TYPE_INFO[type].label;
      if (existing) await api("PUT", `/api/sources/${existing.id}`, { name: label, options });
      else await api("POST", "/api/sources", { type, name: label, options });
      toast(existing ? "Saved" : "Source added");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title={existing ? `Edit ${existing.name}` : "Add a credential source"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{existing ? "Save" : "Add source"}</Button></>}>
      <div className="space-y-4">
        {!existing && <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as SourceType)}>{types.map((t) => <option key={t} value={t}>{TYPE_INFO[t].label}</option>)}</Select></Field>}
        <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">{TYPE_INFO[type].blurb} Reference it like <code className="font-mono text-fg">{TYPE_INFO[type].example}</code>.</p>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPE_INFO[type].label} /></Field>
        {type === "1password" && (
          <>
            <Field label="Account" hint="Optional. Only needed if you use several 1Password accounts."><Input value={opts.account ?? ""} onChange={(e) => set("account", e.target.value)} /></Field>
            <Field label="Allowed vaults" hint="Optional, comma separated. Anything outside this list is refused."><Input value={opts.allowedVaults ?? ""} onChange={(e) => set("allowedVaults", e.target.value)} placeholder="Work, Private" /></Field>
            <Field label="Path to the op CLI" hint="Optional. Leave blank to use the one on your PATH."><Input value={opts.opPath ?? ""} onChange={(e) => set("opPath", e.target.value)} className="font-mono" /></Field>
          </>
        )}
        {type === "vault" && (
          <>
            <Field label="Address" hint={vaultAddress && !opts.address ? `Blank: uses VAULT_ADDR from your shell (${vaultAddress}).` : "Leave blank to use VAULT_ADDR from your shell."}><Input value={opts.address ?? ""} onChange={(e) => set("address", e.target.value)} placeholder={vaultAddress ?? "https://vault.example.com"} className="font-mono" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mount"><Input value={opts.mount ?? ""} onChange={(e) => set("mount", e.target.value)} /></Field>
              <Field label="KV version"><Select value={opts.kvVersion} onChange={(e) => set("kvVersion", e.target.value)}><option value="2">2</option><option value="1">1</option></Select></Field>
            </div>
            <Field label="Namespace" hint="Optional (Vault Enterprise)."><Input value={opts.namespace ?? ""} onChange={(e) => set("namespace", e.target.value)} /></Field>
            <Field label="Token comes from" hint="With “typed in the app” you enter it on the source card after saving."><Select value={opts.tokenSource} onChange={(e) => set("tokenSource", e.target.value)}><option value="env">VAULT_TOKEN environment variable</option><option value="file">~/.vault-token</option><option value="manual">Typed in the app (encrypted)</option></Select></Field>
            {opts.tokenSource === "file" && <Field label="Sign-in method" hint="Used by the Sign in button (vault login -method=…). Leave as oidc for browser sign-in."><Input value={opts.loginMethod ?? ""} onChange={(e) => set("loginMethod", e.target.value)} placeholder="oidc" className="font-mono" /></Field>}
          </>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function AddSecretDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <Dialog title="Add a local secret" subtitle="Encrypted, then saved on this computer when your OS keychain is available." onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !value} onClick={async () => { try { await api("PUT", `/api/secrets/${encodeURIComponent(name.trim())}`, { value }); toast("Local secret saved (encrypted)"); onClose(); } catch (e) { toast((e as Error).message, "error"); } }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Name" hint={name ? `Use it as {{secret://${name.trim()}}}` : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-token" /></Field>
        <Field label="Value"><Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></Field>
      </div>
    </Dialog>
  );
}
