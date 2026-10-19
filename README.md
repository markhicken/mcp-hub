# MCP Hub

A private persistent local app that runs and proxies **every MCP server on your machine**, keeps their credentials **encrypted and out of plain sight**, shows what each server is doing, and tracks how much data flows through each one. No telemetry/analytics and nothing is sent outside your machine (except MCPs you configure).

Instead of every AI app (Claude Desktop, Claude Code, Copilot CLI, Cursor, VS Code, Augment, ChatGPT / Codex…) launching its own copy of every MCP server and fetching its own secrets, they all connect to MCP Hub:

![MCP Hub: servers](screenshots/MCP%20Hub%20-%20Servers.png)

![MCP Hub: usage dashboard](screenshots/MCP%20Hub%20-%20Usage.png)

For the data-flow diagram, see [`ARCHITECTURE.md`](ARCHITECTURE.md#1-what-it-is).

## Download

**[Download the latest release](https://github.com/markhicken/mcp-hub/releases/latest)** for macOS: open the `.dmg` for your Mac (`aarch64` is Apple silicon, `x64` is Intel) and drag MCP Hub to Applications. Builds aren't signed yet, so the first time, right-click the app and choose **Open**. Check a download against `SHA256SUMS.txt` on the release page. Windows and Linux installers aren't published yet; you can [run it from source](#develop).

## What it does

- **Proxies every MCP server.** Many clients can share one running server; request ids and progress notifications are routed back to the right client.
- **Apps connect through a private local socket, with one approval per app.** Each app launches the bridge (`mcp-hub-stdio <server-id>`), which finds the hub by itself and talks to it over a Unix socket in the hub's data directory. The first time an app connects, MCP Hub asks you to allow it; the answer covers every server that app opens until it quits. No tokens to store or pass around. The bridge transparently starts a new session if the hub restarts.
- **Unauthenticated HTTP connections are optional, not recommended** and off by default (Settings → Security → "Allow unauthenticated HTTP connections"): `http://127.0.0.1:47615/mcp/<server-id>` for apps that cannot use the bridge. Those connections are not approved per app.
- **Credentials are encrypted.** Server definitions contain references like `{{op://Vault/Item/field}}`, never secrets, and those references are themselves encrypted (AES-256-GCM) in the config file and in memory, decrypted only to show them in the app or to use them. The hub resolves them on demand and holds the results **encrypted in memory** for a time you choose (Settings, or the Credentials page: 1 minute to 24 hours, or until you forget them) before forgetting them, plus a "Forget all" button and a Forget button on each secret (handy after rotating one). The encryption key is a random 256-bit key kept in your OS keychain (macOS Keychain; Linux Secret Service), never in MCP Hub's own files. Concurrent lookups are de-duplicated and serialized so you see one 1Password prompt at a time, with a cooldown after a denied prompt.
  - **Set up automatically:** on first run MCP Hub adds the 1Password and OS keychain sources and quietly checks that their tools are installed, without reading anything or triggering a prompt. You only see something if a tool is missing. For the 1Password CLI (`op`) on macOS and Windows, **Install for me** downloads 1Password's official signed CLI into MCP Hub's own folder (nothing else on your computer changes); it is used only after its signature is confirmed to be 1Password's and it reports the expected version. Manual steps (`brew install --cask 1password-cli`, `winget`, the install guide) are one click away, and Linux shows the libsecret and 1Password instructions. An `op` found outside the PATH the app sees is remembered. After installing, turn on Settings → Developer → "Integrate with 1Password CLI" in the 1Password app.
  - **Vault:** if `VAULT_ADDR` is set in your shell, a Vault source is added for you (address from the environment, token from `~/.vault-token`). Nothing about Vault is shown otherwise. Vault is read over its HTTP API with a token, so the CLI is only needed to get one: when there's no token you see a **Sign in** button (it runs `vault login`, which opens your browser for OIDC; other methods can be set per source), and if the Vault CLI is missing, **Install for me** downloads HashiCorp's official CLI into MCP Hub's own folder after checking its SHA-256 against HashiCorp's published checksums and its reported version.
  - Sources: **1Password** (CLI), **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret), **HashiCorp Vault**, **environment variables**, and **local secrets** you add to the app (encrypted with AES-256-GCM and saved on your computer; the key stays in your OS keychain).
- **Credential sources are editable.** Every source card has Edit (address, mount, namespace, token source, sign-in method, CLI path), including the ones MCP Hub set up for you. A failing Vault test says why, in Vault's own words (for example `HTTP 403: permission denied`), what usually causes it, and offers Sign in when the token comes from `~/.vault-token`.
- **Remote servers**: static headers/tokens (from any credential source) or full **OAuth** sign-in. Upstream failures such as an expired token are turned into clear JSON-RPC errors for the client instead of crashing it.
- **Live status** per server: Authenticated · In use · Idle · Connecting · Waiting for credentials · Needs sign-in · Error · Off. Connect or disconnect any server at any time.
- **Usage dashboard**: bytes in/out, requests, errors, latency (avg/p95) and top tools per server over 1h/24h/7d/30d, filterable by server and by the app that made the requests, stored locally in SQLite (sizes, timings and app names only, never payloads). Connecting to a server or testing it isn't counted, and "Clear history" gives you a fresh slate. CSV export. Hover a server's "In use" badge to see which apps are using it.
- **Export and import your MCP configuration** (Settings → Backup & sharing). Export saves your servers (including notes) and any extra credential sources to one JSON file that **you choose the location of** (a native Save As dialog on macOS; afterwards the dialog shows the exact path, with a Show in Finder button, and the file is readable only by you). Credential references such as `{{op://…}}` are saved as references; secret values are never included (not local secrets, not cached values), and machine-specific tool paths are left out. Before saving, the dialog warns about values typed straight into a server's env or headers (they go into the file as written) and lists the local secrets to add again. Import accepts that file, or a plain `mcpServers` file, and shows a preview before changing anything: which servers are new, which already exist (skip, replace or keep both) and which credential sources would be added (existing ones are never touched). Encrypted values from another computer are refused with an explanation.
- **Install** a server into other apps: Install in an app adds MCP Hub's bridge entry for that server to the config files of Claude Desktop, Claude Code, Copilot CLI, Cursor, Augment (Auggie CLI, `~/.augment/settings.json`), VS Code and ChatGPT / Codex. It edits the file text in place: your formatting, comments and other servers are untouched, nothing is added if it is already there. If an app already has an entry for the same MCP (same name), Install first runs a pre-flight check and shows a review step: which apps and which entries (key and command or URL, never arguments or headers) would be replaced, and nothing is written until you press "Back up and replace". It then replaces those entries with MCP Hub's under the same key, so tool names don't change. Config files are only opened for the apps you tick, when you press Install, and each file is first copied next to the original as `<file>.mcp-hub-backup-<time>` (same permissions, newest 10 kept per file), so you can restore it by copying it back. The same works from the other side: after scanning an app in Settings, its **Install…** button lets you tick several of MCP Hub's servers and add them all to that app in one go, with the same review step and a single backup for the whole batch.
- **Import** servers from Claude Desktop, Claude Code, Copilot CLI, Cursor, Augment, VS Code and **ChatGPT / Codex** configs. (The ChatGPT desktop app, the Codex CLI and the Codex IDE extension all read `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`, so they share one entry. It is TOML: `[mcp_servers.<name>]` tables are read, `bearer_token_env_var` and `env_http_headers` become `{{env://…}}` references, and Install and Migrate edit only the text of the tables involved, keeping comments and everything else, with the same backup and safety checks as the JSON apps.) MCP Hub only reads another app's config when you press Scan for that app, and it lists entries that already go through MCP Hub as "Already uses MCP Hub" without offering to import them. After scanning an app you can **Migrate to MCP Hub**: it backs up the file, adds the app's servers to MCP Hub (secrets like `op://…` become references) and changes each of the app's entries to run through MCP Hub *under the same name*, so the tool names the app shows don't change. Configs may contain comments and trailing commas. Standard local (`command`/`args`/`env`) and remote (`url`/`headers`) entries import as they are. An `mcp-remote` entry (how Claude Desktop reaches an HTTP server, e.g. `npx mcp-remote https://… --header "Authorization: Bearer ${TOKEN}"` with `TOKEN` in its `env`) is recognised, including when run through the 1Password injector, and imported as the HTTP server it really is: its URL and headers, with `${VAR}` filled in from the entry's own `env` and secret references kept as references. In a command entry, a `${VAR}` that the entry's own `env` sets is left for the program to expand; any other `${VAR}` or `${env:VAR}` becomes a `{{env://VAR}}` reference (turn on the Environment source for those), and servers marked `disabled` are imported switched off. `${input:…}` prompts aren't supported. If a server can't be set up in MCP Hub (for example a reference can't be resolved), Migrate leaves that entry in the app as it was and says why.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | The daemon (TypeScript, Node 24): proxy, credential broker, OAuth, metrics, REST + SSE API, tests |
| `packages/ui` | The web UI (React, Vite, Tailwind, Recharts), served by the daemon at `/` |
| `packages/shim` | `mcp-hub-stdio`, a zero-dependency stdio-to-HTTP bridge |
| `apps/desktop` | Tauri v2 tray app that starts the daemon with the GUI and stops it on quit |
| `scripts/` | Sidecar build (Node single-executable) and icon generation |

## Develop

```bash
npm install
npm test                  # core + UI + shim tests
npm run typecheck

# Run the daemon and the UI with hot reload
npm run dev               # daemon + UI hot reload; open http://localhost:5173/?token=devtoken
npm run dev:core          # prints "Open the UI: http://127.0.0.1:47615/?token=…"
MCP_HUB_DEV_ORIGIN=http://localhost:5173 npm run dev:core   # needed for the Vite dev server's Origin check
npm run dev:ui            # then open http://localhost:5173/?token=<token from the daemon>

# Seed a running hub with demo servers and traffic
cd packages/core && MCP_HUB_URL=http://127.0.0.1:47615 MCP_HUB_TOKEN=<token> node scripts/demo-traffic.mjs
```

Desktop app and installers: see [`apps/desktop/README.md`](apps/desktop/README.md). For how everything fits together (proxy internals, credential broker, API, testing, gotchas, roadmap), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Releasing

Releases are built and published by GitHub Actions (`.github/workflows/release.yml`), and only when you push or merge to `master`.

```bash
node scripts/version.mjs set 1.2.3     # writes 1.2.3 into every file that carries the version (8 of them)
git commit -am "Release 1.2.3"
git push origin master                 # or merge a pull request into master
```

Every push to master runs the tests (the build stops early if the version files disagree with each other) and builds the macOS installers (Apple silicon and Intel, each on its own runner because the hub and bridge are packaged with the Node that builds them), keeping them as workflow artifacts for 14 days. If the version has no GitHub Release yet, the installers are also published as release `v1.2.3` (the tag is created for you) with `SHA256SUMS.txt` and generated release notes. A version with a hyphen (`1.2.3-beta.1`) is published as a pre-release. Pushes that don't change the version publish nothing, so ordinary merges are safe.

- **No tags or manual runs:** nothing triggers the workflow except a push to master. Windows and Linux aren't built; add runners to the matrix to try them.
- **Signing is optional.** Without secrets the macOS builds are unsigned (people open them with right-click → Open the first time). To sign and notarize, add these repository secrets: `APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`. A signed build keeps the same Keychain key and macOS permissions across updates; an unsigned one may ask again.

## Environment variables (daemon)

| Variable | Purpose |
| --- | --- |
| `MCP_HUB_HOME` | Data directory (config, usage database, runtime file). Defaults to the OS app-data folder |
| `MCP_HUB_PORT` | Preferred port (default 47615; falls back to a free port if busy) |
| `MCP_HUB_TOKEN` | Per-run UI token chosen by the desktop shell (random otherwise) |
| `MCP_HUB_UI_DIR` | Folder with the built UI |
| `MCP_HUB_SHIM` | Path to the `mcp-hub-stdio` executable, for the "Connect a client" snippets |
| `MCP_HUB_DEV_ORIGIN` | Extra allowed browser origin (Vite dev server) |

## Security model

- The hub listens on `127.0.0.1` only. Requests with an unexpected `Host` (DNS rebinding) or a foreign browser `Origin` are rejected.
- The management API needs a random per-run token. The UI receives it in the URL the desktop shell opens, keeps it in `sessionStorage`, and removes it from the address bar.
- **Any process on your computer can use the `/mcp/…` endpoints**, and therefore the secrets behind them, unless you turn on **Require an access token** in Settings. Clients then must send `Authorization: Bearer <token>` (the "Connect a client" snippets include it).
- Secrets are never written to disk or to logs in readable form (resolved values are masked in server logs, and the masks are kept encrypted too). Local secrets and credential references are saved only as AES-256-GCM ciphertext. If your OS keychain can't be used, nothing is encrypted for saving, so nothing is saved: local secrets stay in memory and Settings says why. Remaining limits: a value handed to a running server (its environment, or request headers for a remote server) is plain while that server runs, OAuth tokens are held by the MCP SDK in memory unencrypted while in use, and malware running as you can still read the key from your keychain or the hub's memory. Servers that drive other Mac apps with AppleScript (Outlook, Mail, Calendar) run as children of MCP Hub, so macOS asks once to let **MCP Hub** control that app (System Settings → Privacy & Security → Automation). Server logs are kept per server under the data folder (`logs/`, readable only by you, 1 MB cap) so you can look back after a restart or a timeout; they include slow (5 s+) and failed requests, requests still running after 30 s, and apps that cancelled or disconnected while waiting. OAuth sign-ins are held in memory unless you choose to remember them: **Remember sign-ins** (Credentials page, off by default, with a per-server override in each OAuth server's settings) saves the tokens encrypted (AES-256-GCM, bound to the server) in `signins.json`, so a restart doesn't need a new browser sign-in. They are listed under "Remembered sign-ins", can be forgotten one by one, are forgotten automatically after a time you choose (**Forget after**: 1 day to 90 days, or until you forget them; 30 days by default, counted from the last sign-in or token renewal, so a sign-in you use keeps renewing itself), and are never saved without the keychain key. "Forget all" only clears fetched secrets, not remembered sign-ins.
- Config files contain references, not secrets (`config.json` is created with mode 0600).

## Known limitations

- **If the encryption key is lost** (the keychain item is deleted, or you move to a new computer), nothing is deleted: saved secrets stay on disk but are locked, and the Credentials page says so. Save a copy of your **recovery key** in a password manager: the welcome tour has a "Save your recovery key" step that shows it and asks you to confirm you've saved it (you can skip it, and the Credentials page keeps reminding you until you do; Credentials → Encryption → Show recovery key shows it any time). With it, **Restore key** unlocks everything again; MCP Hub checks the key really opens your saved secrets before accepting it. If there is no copy, **Start over** makes a new key, but whatever was encrypted with the old one is gone: local secrets are deleted, and servers that used encrypted references have those values emptied and are switched off so you can fill them in again.
- OAuth sign-ins are only saved across restarts if you turn on "Remember sign-ins" (globally or per server); otherwise you sign in again after a restart.
- Windows keychain access and Linux libsecret are implemented but only exercised on macOS so far.
- Server-initiated requests (sampling, roots, elicitation) are not forwarded to clients yet; the hub declares no client capabilities to upstream servers.
- The desktop installers (signing, notarization, auto-update) are not produced or verified yet; see the desktop README.
