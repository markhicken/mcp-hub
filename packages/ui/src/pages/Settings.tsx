import { Download, Eye, EyeOff, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { ClientList } from "../Clients";
import { ConfigImportDialog, ExportDialog } from "../ConfigTransfer";
import { ForgetAfterSelect } from "../ForgetAfter";
import { ImportPanel } from "../Onboarding";
import type { Settings, Snapshot } from "../types";
import { Button, Card, CopyButton, Input, PageHeader, Segmented, Select, Switch, useToast } from "../ui";
import type { Theme } from "../theme";

interface Props {
  snap: Snapshot;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onIntro: () => void;
}

export function SettingsPage({ snap, theme, setTheme, onIntro }: Props) {
  const toast = useToast();
  const s = snap.settings;
  const [reveal, setReveal] = useState(false);
  const [port, setPort] = useState(String(s.port));
  const [transfer, setTransfer] = useState<"export" | "import" | null>(null);

  const save = async (patch: Partial<Settings>, ok = "Saved") => {
    try {
      const r = await api<{ restartRequired?: boolean }>("PUT", "/api/settings", patch);
      toast(r.restartRequired ? "Saved. Restart MCP Hub for the new port to take effect." : ok);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />

      <Section title="Appearance">
        <Row label="Theme" hint="Follows your system by default.">
          <Segmented value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Row>
      </Section>

      <Section title="Server">
        <Row label="Address" hint="Clients connect to servers under this address.">
          <code className="font-mono text-xs">{snap.baseUrl}</code>
        </Row>
        <Row label="Preferred port" hint="If the port is busy, MCP Hub falls back to a free one. Takes effect after a restart.">
          <div className="flex gap-2"><Input value={port} onChange={(e) => setPort(e.target.value)} className="w-24" inputMode="numeric" aria-label="Port" /><Button disabled={Number(port) === s.port} onClick={() => save({ port: Number(port) })}>Save</Button></div>
        </Row>
      </Section>

      <Section title="Apps using MCP Hub">
        <ClientList clients={snap.clients} servers={snap.servers} />
      </Section>

      <Section title="Security">
        <Row label="Allow unauthenticated HTTP connections (not recommended)" hint="Off by default. Apps normally connect through the MCP Hub bridge, which asks you once per app. Turn this on only for apps that can't use the bridge: any program on this Mac can then reach every server over HTTP with no approval.">
          <Switch checked={s.allowTcpMcp} onChange={(v) => save({ allowTcpMcp: v })} label="Allow unauthenticated HTTP connections (not recommended)" />
        </Row>
        {s.allowTcpMcp && (
          <Row label="Require an access token" hint="Make HTTP clients present a token (they need it in their config).">
            <Switch checked={s.requireClientToken} onChange={(v) => save({ requireClientToken: v })} label="Require an access token" />
          </Row>
        )}
        {s.allowTcpMcp && s.requireClientToken && (
          <Row label="Access token" hint="Included automatically in the snippets under Connect a client.">
            <div className="flex items-center gap-2">
              <code style={{ width: `calc(${s.clientToken.length}ch + 1rem)` }} className="inline-block max-w-full shrink-0 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">{reveal ? s.clientToken : "•".repeat(s.clientToken.length)}</code>
              <Button size="sm" variant="ghost" aria-label={reveal ? "Hide token" : "Reveal token"} onClick={() => setReveal((r) => !r)}>{reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
              <CopyButton text={s.clientToken} />
              <Button size="sm" onClick={async () => { await api("POST", "/api/settings/rotate-client-token"); toast("New token generated. Update your clients."); }}><RefreshCw className="size-3.5" /> Rotate</Button>
            </div>
          </Row>
        )}
      </Section>

      <Section title="Credentials">
        <Row label="Forget secrets after" hint="Secrets fetched from 1Password, the keychain and other sources are kept encrypted in memory, then forgotten after this long. The next use asks the source again.">
          <ForgetAfterSelect value={s.cacheTtlSeconds} onChange={(v) => save({ cacheTtlSeconds: v })} />
        </Row>
        <Row label="Pause after a denied prompt" hint="Avoids a flood of prompts if you dismiss one.">
          <Select aria-label="Cooldown" className="w-44" value={String(s.denialCooldownSeconds)} onChange={(e) => save({ denialCooldownSeconds: Number(e.target.value) })}>
            <option value="0">Don't pause</option><option value="10">10 seconds</option><option value="60">1 minute</option><option value="300">5 minutes</option>
          </Select>
        </Row>
        <Row label="Notify when a secret is requested" hint="Shows which server triggered a 1Password or keychain prompt.">
          <Switch checked={s.notifyOnCredentialPrompt} onChange={(v) => save({ notifyOnCredentialPrompt: v })} label="Notify on credential prompts" />
        </Row>
      </Section>

      <Section title="Data">
        <Row label="Keep usage history for" hint="Only sizes and timings are stored.">
          <Select aria-label="Retention" className="w-44" value={String(s.retentionDays)} onChange={(e) => save({ retentionDays: Number(e.target.value) })}>
            <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
          </Select>
        </Row>
      </Section>

      <Section title="Import from other apps">
        <ImportPanel snap={snap} />
      </Section>

      <Section title="Backup & sharing">
        <Row label="Export your configuration" hint="Saves your servers and credential sources to a file. Credential references are kept; secret values never are.">
          <Button size="sm" onClick={() => setTransfer("export")}><Download className="size-3.5" /> Export…</Button>
        </Row>
        <Row label="Import a configuration" hint="Brings servers in from an exported file or a standard mcpServers file. You see what will happen before anything changes.">
          <Button size="sm" onClick={() => setTransfer("import")}><Upload className="size-3.5" /> Import…</Button>
        </Row>
      </Section>
      {transfer === "export" && <ExportDialog onClose={() => setTransfer(null)} />}
      {transfer === "import" && <ConfigImportDialog onClose={() => setTransfer(null)} />}

      <Section title="About">
        <Row label="MCP Hub" hint={`Version ${snap.version} · ${snap.platform}`}>
          <Button size="sm" onClick={onIntro}><Download className="size-3.5 rotate-180" /> Show intro</Button>
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <Card className="divide-y divide-border">{children}</Card>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="max-w-md"><div className="text-sm font-medium">{label}</div>{hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}</div>
      <div>{children}</div>
    </div>
  );
}
