import { Copy, Eye, EyeOff, LifeBuoy, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import type { Snapshot } from "./types";
import { Button, Card, Confirm, Dialog, Input, useToast } from "./ui";

type Encryption = Snapshot["credentials"]["encryption"];

/** How secrets are protected, and how to get back in if the key is lost. */
export function EncryptionCard({ encryption: e, recoveryKeySaved }: { encryption: Encryption; recoveryKeySaved: boolean }) {
  const toast = useToast();
  const [showKey, setShowKey] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [resetting, setResetting] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="size-4 text-accent" /> Encryption</h2>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!e.persistent} onClick={() => setShowKey(true)}><LifeBuoy className="size-3.5" /> Show recovery key</Button>
          <Button size="sm" onClick={() => setRestoring(true)}>Restore key…</Button>
        </div>
      </div>
      <p className="text-xs text-muted">
        {e.persistent
          ? `${e.algorithm}. The key is kept in ${e.keyStore}. If it's ever deleted, or you move to a new computer, a copy of the recovery key brings everything back. Without one, saved secrets can't be recovered.`
          : `${e.algorithm}, with a key that exists only while MCP Hub runs.`}
      </p>

      {e.persistent && !recoveryKeySaved && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <span><strong>You haven't saved your recovery key yet.</strong> If your keychain item is ever deleted, you'd lose access to your saved secrets.</span>
          <Button size="sm" variant="primary" onClick={() => setShowKey(true)}>Save it now</Button>
        </div>
      )}

      {e.locked && (
        <div className="mt-4 space-y-3 rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm" role="alert">
          <div>
            <strong>Your saved secrets are locked.</strong> {e.problem}
            <span className="mt-1 block text-xs text-muted">Nothing has been deleted or changed. Servers that use encrypted secrets can't start until the key is back.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => setRestoring(true)}>Restore with recovery key</Button>
            <Button size="sm" variant="danger" onClick={() => setResetting(true)}>No key? Start over…</Button>
          </div>
        </div>
      )}

      {showKey && <RecoveryKeyDialog encryption={e} saved={recoveryKeySaved} onClose={() => setShowKey(false)} />}
      {restoring && <RestoreKeyDialog onClose={() => setRestoring(false)} />}
      {resetting && (
        <Confirm
          title="Start over with a new key?"
          body="This can't be undone. Secrets that were encrypted with the lost key can never be read again, so: every local secret is deleted, and any server that used an encrypted reference has that value emptied and is switched off, so you can fill it in again. Your other settings are kept. Only do this if you don't have a recovery key."
          confirmLabel="Start over"
          onClose={() => setResetting(false)}
          onConfirm={async () => {
            try {
              const r = await api<{ affected: Array<{ name: string }>; localSecretsRemoved: number }>("POST", "/api/credentials/reset-encryption");
              toast(r.affected.length ? `New key created. Fill in the secrets again for: ${r.affected.map((a) => a.name).join(", ")}` : "New key created.");
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        />
      )}
    </Card>
  );
}

/**
 * Shows the recovery key masked, until the user clicks the eye. Has a Copy button and an "I've saved it"
 * box that is remembered in settings. Used in the first-run intro and in the Encryption card.
 */
export function RecoveryKeyPanel({ encryption, saved }: { encryption: Encryption; saved: boolean }) {
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (visible) return setVisible(false);
    try {
      if (key === null) setKey((await api<{ key: string }>("GET", "/api/credentials/recovery-key")).key);
      setError("");
      setVisible(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!encryption.persistent) {
    return (
      <p className="rounded-lg bg-warn/10 p-3 text-xs text-warn" role="alert">
        There's no saved key to show right now. {encryption.problem ?? "Your OS keychain isn't available."} Secrets stay in memory until that is fixed.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <code className="block min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs" data-testid="recovery-key">
            {visible && key ? key : "•".repeat(44)}
          </code>
          <Button size="sm" variant="ghost" aria-label={visible ? "Hide recovery key" : "Reveal recovery key"} onClick={toggle}>
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
        {visible && key && (
          <Button size="sm" onClick={() => navigator.clipboard.writeText(key).then(() => toast("Recovery key copied"), () => toast("Couldn't copy. Select the key and copy it.", "error"))}><Copy className="size-3.5" /> Copy</Button>
        )}
      </div>
      {error && <p className="rounded-lg bg-bad/10 p-3 text-sm text-bad">{error}</p>}
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" checked={saved} onChange={(e) => api("PUT", "/api/settings", { recoveryKeySaved: e.target.checked }).catch((err) => toast((err as Error).message, "error"))} />
        I've saved my recovery key somewhere safe
      </label>
    </div>
  );
}

function RecoveryKeyDialog({ encryption, saved, onClose }: { encryption: Encryption; saved: boolean; onClose: () => void }) {
  return (
    <Dialog title="Recovery key" subtitle="Keep a copy somewhere safe, such as a password manager." onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          This is the key that unlocks your saved secrets. If it's deleted from your keychain, <strong>Restore key</strong> puts it back. Anyone who has both this key and your MCP Hub files can read your secrets, so don't share it or leave it in plain notes.
        </p>
        <RecoveryKeyPanel encryption={encryption} saved={saved} />
      </div>
    </Dialog>
  );
}

function RestoreKeyDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const restore = async () => {
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/credentials/restore-key", { key: value.trim() });
      toast("Key restored. Your saved secrets are unlocked.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Restore the key"
      subtitle="Paste the recovery key you saved."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!value.trim() || busy} onClick={restore}>{busy ? "Checking…" : "Restore"}</Button></>}
    >
      <div className="space-y-3">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="44-character recovery key" className="font-mono" autoComplete="off" spellCheck={false} aria-label="Recovery key" autoFocus />
        <p className="text-xs text-muted">MCP Hub checks that the key really opens your saved secrets before it saves it to your keychain, so a wrong key changes nothing.</p>
        {error && <p className="rounded-lg bg-bad/10 p-3 text-sm text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}
