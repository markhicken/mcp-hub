import { ArrowLeft, ClipboardPaste, Globe, KeyRound, Lock, Plus, Terminal, Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { api } from "./api";
import { isCredentialRef, parseServerJson, slugify, splitArgs } from "./lib";
import type { ServerConfig, ServerStatus } from "./types";
import { Button, Chip, Dialog, Field, Input, Segmented, Select, Textarea, cx, useToast } from "./ui";

interface Template {
  name: string;
  blurb: string;
  config: Partial<ServerConfig>;
}

const TEMPLATES: Template[] = [
  {
    name: "GitHub",
    blurb: "Issues, PRs and code search",
    config: { name: "GitHub", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } },
  },
  {
    name: "Filesystem",
    blurb: "Read and write files in a folder",
    config: { name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"] },
  },
  { name: "Fetch", blurb: "Fetch web pages as markdown", config: { name: "Fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] } },
  { name: "Playwright", blurb: "Browser automation", config: { name: "Playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] } },
  { name: "Remote (sign in)", blurb: "Hosted server with OAuth sign-in", config: { name: "Remote server", transport: "http", url: "https://", auth: "oauth" } },
  { name: "Remote (token)", blurb: "Hosted server with an API token", config: { name: "Remote server", transport: "http", url: "https://", auth: "none", headers: { Authorization: "" } } },
];

interface Props {
  existing?: ServerStatus;
  /** Labels already used on any server, offered as suggestions. */
  knownLabels?: string[];
  onClose: () => void;
}

type Step = "choose" | "paste" | "form";
type Pair = { k: string; v: string };

const toPairs = (r?: Record<string, string>): Pair[] => Object.entries(r ?? {}).map(([k, v]) => ({ k, v }));
// An empty list is sent as {} rather than left out: a missing field means "unchanged" to the hub, so the last row could never be removed.
const fromPairs = (p: Pair[]): Record<string, string> => Object.fromEntries(p.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));

export function AddServerDialog({ existing, knownLabels = [], onClose }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<Step>(existing ? "form" : "choose");
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [queue, setQueue] = useState<Array<Partial<ServerConfig>>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const c = existing?.config;
  const [name, setName] = useState(c?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(c?.transport ?? "stdio");
  const [command, setCommand] = useState(c?.command ?? "");
  const [args, setArgs] = useState((c?.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
  const [cwd, setCwd] = useState(c?.cwd ?? "");
  const [env, setEnv] = useState<Pair[]>(toPairs(c?.env));
  const [url, setUrl] = useState(c?.url ?? "");
  const [headers, setHeaders] = useState<Pair[]>(toPairs(c?.headers));
  const [auth, setAuth] = useState<"none" | "oauth">(c?.auth ?? "none");
  const [remember, setRemember] = useState<"default" | "yes" | "no">(c?.oauth?.remember === undefined ? "default" : c.oauth.remember ? "yes" : "no");
  const [lifecycle, setLifecycle] = useState<"keep-alive" | "on-demand">(c?.lifecycle ?? "keep-alive");
  const [idle, setIdle] = useState(String(c?.idleTimeoutMinutes ?? 15));
  const [notes, setNotes] = useState(c?.notes ?? "");
  const [labels, setLabels] = useState<string[]>(c?.labels ?? []);

  const fill = (t: Partial<ServerConfig>) => {
    setName(t.name ?? "");
    setNotes(t.notes ?? "");
    setLabels(t.labels ?? []);
    setTransport(t.transport ?? "stdio");
    setCommand(t.command ?? "");
    setArgs((t.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
    setEnv(toPairs(t.env));
    setUrl(t.url ?? "");
    setHeaders(toPairs(t.headers));
    setAuth(t.auth ?? "none");
    setRemember("default");
    setStep("form");
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    const body: Partial<ServerConfig> = {
      name: name.trim(),
      transport,
      enabled: existing?.config.enabled ?? true,
      lifecycle,
      notes: notes.trim(),
      labels,
      idleTimeoutMinutes: lifecycle === "on-demand" ? Number(idle) || 0 : undefined,
      ...(transport === "stdio"
        ? { command: command.trim(), args: splitArgs(args.replace(/\s*\r?\n\s*/g, " ")), cwd: cwd.trim() || undefined, env: fromPairs(env), url: undefined, headers: undefined, auth: undefined }
        : { url: url.trim(), headers: fromPairs(headers), auth, command: undefined, args: undefined, env: undefined, cwd: undefined }),
    };
    if (transport === "http" && auth === "oauth") {
      const { remember: _drop, ...rest } = c?.oauth ?? {};
      body.oauth = { ...rest, ...(remember === "default" ? {} : { remember: remember === "yes" }) };
    }
    try {
      if (existing) {
        await api("PUT", `/api/servers/${existing.id}`, body);
        toast(`Saved ${body.name}`);
      } else {
        await api("POST", "/api/servers", { ...body, id: slugify(body.name ?? "") });
        toast(`Added ${body.name}`);
      }
      if (queue.length) {
        const [next, ...rest] = queue;
        setQueue(rest);
        fill(next!);
      } else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = existing ? `Edit ${existing.config.name}` : step === "choose" ? "Add a server" : step === "paste" ? "Paste a config" : "Server details";

  return (
    <Dialog
      title={title}
      subtitle={step === "choose" ? "Pick a starting point. You can change everything afterwards." : queue.length ? `${queue.length} more to review after this one` : undefined}
      onClose={onClose}
      wide
      footer={
        step === "form" ? (
          <>
            {!existing && <Button variant="ghost" onClick={() => setStep("choose")}><ArrowLeft className="size-4" /> Back</Button>}
            <div className="flex-1" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving || !name.trim()} onClick={submit}>{existing ? "Save changes" : queue.length ? "Add and continue" : "Add server"}</Button>
          </>
        ) : step === "paste" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("choose")}><ArrowLeft className="size-4" /> Back</Button>
            <div className="flex-1" />
            <Button
              variant="primary"
              disabled={!paste.trim()}
              onClick={() => {
                try {
                  const [first, ...rest] = parseServerJson(paste);
                  setQueue(rest);
                  setPasteError("");
                  fill(first!);
                } catch (e) {
                  setPasteError((e as Error).message);
                }
              }}
            >
              Continue
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "choose" && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {TEMPLATES.map((t) => (
              <button key={t.name} onClick={() => fill(t.config)} className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 text-left transition hover:border-accent/60 hover:bg-surface-2 cursor-pointer">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">{t.config.transport === "http" ? <Globe className="size-4" /> : <Terminal className="size-4" />}</span>
                <span>
                  <span className="block text-sm font-semibold">{t.name}</span>
                  <span className="block text-xs text-muted">{t.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={() => fill({ name: "", transport: "stdio" })} className="flex items-center gap-3 rounded-xl border border-dashed border-border p-3.5 text-left hover:border-accent/60 cursor-pointer">
              <Plus className="size-4 text-muted" /> <span className="text-sm font-medium">Start from scratch</span>
            </button>
            <button onClick={() => setStep("paste")} className="flex items-center gap-3 rounded-xl border border-dashed border-border p-3.5 text-left hover:border-accent/60 cursor-pointer">
              <ClipboardPaste className="size-4 text-muted" /> <span className="text-sm font-medium">Paste a JSON config</span>
            </button>
          </div>
        </div>
      )}

      {step === "paste" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Paste a server entry or a whole <code className="font-mono text-xs">mcpServers</code> block from another app. Secrets can be swapped for credential references on the next screen.</p>
          <Textarea rows={12} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
          {pasteError && <p className="text-sm text-bad">{pasteError}</p>}
        </div>
      )}

      {step === "form" && (
        <div className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="server-name" className="block text-xs font-semibold text-fg">Name</label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <Input id="server-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub" autoFocus />
              <Segmented value={transport} onChange={setTransport} options={[{ value: "stdio", label: "Local command" }, { value: "http", label: "Remote URL" }]} />
            </div>
            {name && <p className="text-xs text-muted">Clients will connect at /mcp/{existing?.id ?? slugify(name)}</p>}
          </div>

          {transport === "stdio" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Command"><Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" /></Field>
                <Field label="Working directory" hint="Optional"><Input value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono" /></Field>
              </div>
              <Field label="Arguments" hint="Space separated; line breaks count as spaces. Use quotes for values that contain spaces.">
                <Textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={Math.min(8, Math.max(2, Math.ceil(args.length / 80) + (args.match(/\n/g)?.length ?? 0)))} placeholder="-y @modelcontextprotocol/server-github" className="resize-y whitespace-pre-wrap break-all" />
              </Field>
              <PairsEditor label="Environment variables" pairs={env} onChange={setEnv} keyPlaceholder="NAME" />
            </>
          ) : (
            <>
              <Field label="Server URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="font-mono" /></Field>
              <Field label="Authentication">
                <Segmented value={auth} onChange={setAuth} options={[{ value: "none", label: "None / headers" }, { value: "oauth", label: "Sign in (OAuth)" }]} />
              </Field>
              {auth === "oauth" && (
                <Field label="Remember sign-in" hint="Keep the sign-in, encrypted, so restarting MCP Hub doesn't need a new browser sign-in. Default follows the setting on the Credentials page.">
                  <Segmented value={remember} onChange={setRemember} options={[{ value: "default", label: "Default" }, { value: "yes", label: "Remember" }, { value: "no", label: "Don't remember" }]} />
                </Field>
              )}
              <PairsEditor label="Headers" pairs={headers} onChange={setHeaders} keyPlaceholder="Authorization" />
            </>
          )}

          <Field label="When should it run?">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented value={lifecycle} onChange={setLifecycle} options={[{ value: "keep-alive", label: "Always on" }, { value: "on-demand", label: "Start when needed" }]} />
              {lifecycle === "on-demand" && (
                <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                  Stop after <Input value={idle} onChange={(e) => setIdle(e.target.value.replace(/\D/g, ""))} className="h-8 px-2 text-center" style={{ width: "4rem" }} inputMode="numeric" maxLength={5} /> idle minutes
                </label>
              )}
            </div>
          </Field>
          <Field label="Labels" hint="Optional. Group servers (work, personal…) to filter them and turn a group on or off together.">
            <LabelsInput value={labels} onChange={setLabels} suggestions={knownLabels} />
          </Field>
          <Field label="Notes" hint="Optional. For you only: where the token comes from, who to ask, anything worth remembering.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="e.g. Token comes from the team vault. Expires monthly." className="resize-y font-sans text-sm" />
          </Field>
          {error && <p className="rounded-lg bg-bad/10 p-3 text-sm text-bad">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- labels

/** Labels as removable chips, plus a box that adds one on Enter or comma and suggests labels already in use. */
function LabelsInput({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const has = (l: string) => value.some((x) => x.toLowerCase() === l.toLowerCase());
  const add = (raw: string) => {
    const l = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (l && !has(l)) onChange([...value, suggestions.find((s) => s.toLowerCase() === l.toLowerCase()) ?? l]);
    setDraft("");
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
      {value.map((l) => (
        <span key={l} className="inline-flex items-center gap-1 rounded-md bg-accent/12 py-0.5 pl-2 pr-1 text-xs font-medium text-accent">
          {l}
          <button type="button" aria-label={`Remove label ${l}`} onClick={() => onChange(value.filter((x) => x !== l))} className="rounded p-0.5 hover:bg-accent/20 cursor-pointer"><X className="size-3" /></button>
        </span>
      ))}
      <input
        aria-label="Add a label"
        list={listId}
        value={draft}
        maxLength={40}
        onChange={(e) => (e.target.value.includes(",") ? e.target.value.split(",").forEach(add) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(draft)}
        placeholder={value.length ? "" : "e.g. work"}
        className="h-7 min-w-24 flex-1 bg-transparent text-sm text-fg placeholder:text-muted/70 focus:outline-none focus-visible:outline-none"
      />
      <datalist id={listId}>{suggestions.filter((s) => !has(s)).map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  );
}

// ---------------------------------------------------------------------------- key/value + credential picker

function PairsEditor({ label, pairs, onChange, keyPlaceholder }: { label: string; pairs: Pair[]; onChange: (p: Pair[]) => void; keyPlaceholder: string }) {
  const update = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => onChange([...pairs, { k: "", v: "" }])}><Plus className="size-3.5" /> Add</Button>
      </div>
      {pairs.length === 0 && <p className="text-xs text-muted">None.</p>}
      {pairs.map((p, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="w-2/5 shrink-0"><Input value={p.k} onChange={(e) => update(i, { k: e.target.value })} placeholder={keyPlaceholder} className="font-mono" aria-label={`${label} name`} /></div>
          <CredentialValue value={p.v} onChange={(v) => update(i, { v })} />
          <button aria-label="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))} className="mt-2 text-muted hover:text-bad cursor-pointer"><Trash2 className="size-4" /></button>
        </div>
      ))}
    </div>
  );
}

const SOURCE_HELP: Record<string, { label: string; placeholder: string; wrap: (v: string) => string }> = {
  "1password": { label: "1Password", placeholder: "op://Vault/Item/field", wrap: (v) => `{{${v}}}` },
  keychain: { label: "OS keychain", placeholder: "keychain://service/account", wrap: (v) => `{{${v}}}` },
  vault: { label: "Vault", placeholder: "vault://path/to/secret#field", wrap: (v) => `{{${v}}}` },
  env: { label: "Environment variable", placeholder: "env://NAME", wrap: (v) => `{{${v}}}` },
  secret: { label: "Type a secret", placeholder: "", wrap: (v) => `{{secret://${v}}}` },
};

function CredentialValue({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const isRef = isCredentialRef(value);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          {isRef && <Lock className="absolute left-2.5 top-2.5 size-3.5 text-good" aria-label="Credential reference" />}
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="value or credential" className={cx("font-mono", isRef && "pl-8 text-good")} aria-label="Value" />
        </div>
        <Button size="sm" className="h-9" onClick={() => setOpen((o) => !o)} aria-label="Pick a credential" aria-expanded={open}><KeyRound className="size-4" /></Button>
      </div>
      {open && <CredentialPicker onPick={(v) => { onChange(v); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CredentialPicker({ onPick, onClose }: { onPick: (v: string) => void; onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState("1password");
  const [ref, setRef] = useState("");
  const [secret, setSecret] = useState("");
  const help = SOURCE_HELP[type]!;
  const use = async () => {
    if (type === "secret") {
      try {
        await api("PUT", `/api/secrets/${encodeURIComponent(ref)}`, { value: secret });
      } catch (e) {
        toast((e as Error).message, "error");
        return;
      }
    }
    onPick(help.wrap(ref.trim()));
  };
  return (
    <div className="fade-in mt-2 space-y-3 rounded-xl border border-border bg-surface-2 p-3.5">
      <Select value={type} onChange={(e) => { setType(e.target.value); setRef(""); }} aria-label="Credential source">
        {Object.entries(SOURCE_HELP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </Select>
      {type === "secret" ? (
        <>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Name, e.g. github-token" aria-label="Secret name" />
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Secret value" aria-label="Secret value" autoComplete="off" />
          <p className="text-xs text-muted">Encrypted with AES-256-GCM and saved on this computer, with the key kept in your OS keychain.</p>
        </>
      ) : (
        <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={help.placeholder} className="font-mono" aria-label="Reference" />
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!ref.trim() || (type === "secret" && !secret)} onClick={use}>Use</Button>
      </div>
      <Chip>The value is fetched when the server starts. It is never shown here.</Chip>
    </div>
  );
}
