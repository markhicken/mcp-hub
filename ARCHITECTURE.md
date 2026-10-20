# MCP Hub: architecture and developer guide

This document explains how MCP Hub is put together, why it is built that way, and what to know before changing it. For a product overview and quick start, see [`README.md`](README.md). For the desktop shell and installers, see [`apps/desktop/README.md`](apps/desktop/README.md).

> **Platform status:** macOS is the only supported platform today. Windows and Linux are not finished: some code paths exist, but they are untested and no installers are built for them. See §13.

## 1. What it is

MCP Hub is a private persistent local app that sits between AI clients (Claude Desktop, Claude Code, Copilot CLI, Cursor, VS Code, Augment, ChatGPT / Codex…) and the MCP servers they use. No telemetry/analytics and nothing is sent outside your machine (except MCPs you configure).

- It **runs or connects to every MCP server once** (local stdio programs, remote HTTP servers, OAuth remotes) and exposes each one at a stable local URL.
- It **resolves credentials on demand** from 1Password, the OS keychain, Vault, environment variables, or secrets typed into the app, and keeps them **encrypted in memory** (AES-256-GCM, see §4.2).
- It shows **live status** for every server and a **usage dashboard** (bytes, requests, errors, latency, top tools).

```
 Claude Desktop ───(mcp-hub-stdio)──┐
 Claude Code ──────(mcp-hub-stdio)──┤
 Copilot CLI ──────(mcp-hub-stdio)──┤                      ┌── stdio MCP servers (spawned by the hub)
 Cursor ───────────(mcp-hub-stdio)──┼──▶  MCP Hub  ────────┼── remote HTTP MCP servers (header injection)
 VS Code ──────────(mcp-hub-stdio)──┤   │        │         └── OAuth remote servers (browser sign-in)
 Augment (Auggie) ─(mcp-hub-stdio)──┤   │        └─ credentials: 1Password · Keychain · Vault · env · local (encrypted)
 ChatGPT / Codex ──(mcp-hub-stdio)──┘   └─ UI: status · logs · usage dashboard
```

The hub daemon listens on `127.0.0.1:47615`: `/mcp/<id>` is the downstream Streamable HTTP endpoint (one `UpstreamConnection` per server behind it), `/api/*` is REST + SSE for the UI, and `/` serves the static UI bundle. Usage metrics go to SQLite (sizes and timings only). Apps normally reach `/mcp/<id>` through the `mcp-hub-stdio` bridge (§8); direct HTTP is optional and off by default.

## 2. Repository layout

| Path | Role |
| --- | --- |
| `packages/core` | The daemon (TypeScript, ESM, Node 24). Everything that matters lives here. |
| `packages/ui` | React 18 + Vite + Tailwind v4 + Recharts web UI. Built to `packages/ui/dist`, served by the daemon at `/`. |
| `packages/shim` | `mcp-hub-stdio`: zero-dependency stdio-to-HTTP bridge (`src/shim.mjs`). |
| `apps/desktop` | Tauri v2 tray app (Rust). Owns the daemon's lifecycle and shows the UI in a window. |
| `scripts/` | `build-sidecars.mjs` (Node single-executable builds of the daemon and shim), `gen-desktop-icons.py`. |
| `packages/core/scripts/` | `build.mjs` (esbuild bundle to `dist/core.mjs`), `demo-traffic.mjs` (seed a running hub with demo data). |
| `packages/core/test/` | Vitest suites and fixtures (mock MCP server, fake `op` CLI). |

Tooling: npm workspaces (`packages/*`, `apps/*`), `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `moduleResolution: Bundler`). Run workspace scripts with `npm run <script> -w <package>`.

## 3. Processes and lifecycle

1. **Tauri shell** (`apps/desktop/src-tauri/src/lib.rs`, `daemon.rs`) generates a random token and spawns the daemon with `MCP_HUB_TOKEN`, `MCP_HUB_UI_DIR`, optionally `MCP_HUB_SHIM`, and `--exit-on-stdin-close`. It keeps the child's stdin open, so the daemon exits if the GUI dies.
2. The **daemon** (`packages/core/src/main.ts`, entry `cli.ts`) prints one JSON line on stdout, `{"event":"ready","port":…,"token":…,"url":…}`, and logs to stderr. Exit code 3 plus `{"event":"already-running"}` means another instance owns the data directory.
3. The shell opens a window at the `url` (`http://127.0.0.1:<port>/?token=…`). The UI reads the token, keeps it in `sessionStorage` and removes it from the address bar.
4. Closing the window only hides it. **Quit** stops the daemon (SIGTERM, 3 s grace, then a process-group kill).
5. The daemon writes `runtime.json` (`pid`, `port`, `socket`, `version`, and the client token if one is required) so the shim can find a running hub. It also removes it on shutdown.

Daemon startup order: load the login-shell environment (`system.ts: loadShellEnv`, so GUI-launched apps get your `PATH`) → `Hub` → listen (preferred port, fallback to a random free port) → `manager.start()` connects every enabled keep-alive server.

Run modes: dev (`tsx src/cli.ts`), bundled (`dist/core.mjs`), or a Node single-executable (SEA) sidecar of about 117 MB (embeds Node).

## 4. Core daemon modules (`packages/core/src`)

| File | Responsibility |
| --- | --- |
| `main.ts` / `cli.ts` | Startup, single-instance check, runtime file, signals, stdin-close watcher, and the start-up sweep of leftover servers (below). |
| `children.ts` | Keeps MCP servers from outliving the hub. `ChildRegistry`: `children.json` lists the stdio servers the hub started (pid and program name only); if the hub is killed without stopping them, the next start stops any that still run the recorded program, plus their child processes (SIGTERM, 1.5 s, SIGKILL). `descendantsOf`/`stopLeftovers`: when a server is stopped, what it started (an `npx` wrapper's real server) is found first and stopped after it. These need `ps`, so macOS/Linux only. On Windows the desktop app puts the daemon in a job object with kill-on-close (`daemon.rs`), so the daemon and every server die with the app, however it dies. An uncaught exception in the daemon stops the servers and exits (the app offers a restart). |
| `hub.ts` | `Hub` class: HTTP server, routing, security checks, REST API, SSE, static files, OAuth callback page. Composes everything below. |
| `manager.ts` | `HubManager`: owns one `UpstreamConnection` per server, add/update/remove/enable/restart, OAuth sign-in orchestration, debounced `change` events. Also exports `HttpError`. |
| `upstream.ts` | `UpstreamConnection`: connection lifecycle, handshake, request multiplexing, reconnects, idle shutdown, per-server counters. The core of the proxy. |
| `mcp-endpoint.ts` | `McpEndpoint`: the downstream `/mcp/<id>` Streamable HTTP endpoint and its sessions. |
| `oauth.ts` | `HubOAuthProvider`: the SDK's `OAuthClientProvider`; in memory, plus saved and restored through `SignInStore` when the server remembers its sign-in. |
| `credentials/broker.ts` | `CredentialBroker`: cache, dedup, serialization, cooldown, templates, active-read tracking. |
| `credentials/*.ts` | Providers: `onepassword.ts`, `keychain.ts`, `vault.ts`, `simple.ts` (env and local), plus `types.ts` (error types, scheme map) and `exec.ts`. Encryption: `box.ts` (`SecretBox`, AES-256-GCM), `keystore.ts` (master key in the OS key store), `local-secrets.ts` (`LocalSecrets`, the `secret://` store), `signins.ts` (`SignInStore`, remembered OAuth sign-ins). |
| `metrics.ts` | `Metrics`: in-memory aggregation flushed to SQLite (`node:sqlite`), queries, CSV, pruning. |
| `store.ts` | `ConfigStore`: JSON config persistence, validation, `slugify`. |
| `logs.ts` | `LogBuffer`: per-server ring buffer with secret masking, mirrored to `<data>/logs/<id>.jsonl` (mode 0600, rolled at 1 MB to `.1`) so history survives restarts. |
| `codex.ts` | ChatGPT / Codex (`~/.codex/config.toml` or `$CODEX_HOME`, shared by the desktop app, CLI and IDE extension). `readCodexServers` (via `smol-toml`) maps `[mcp_servers.*]` to the generic entry shape (`bearer_token_env_var` and `env_http_headers` become `{{env://…}}` headers). `addCodexServer` appends one table; `migrateCodexText` replaces a server's tables and sub-tables under the same key. `scanHeaders` finds table headers only at the top level (not inside strings or multi-line arrays). Both re-parse the result and compare it with the expected data, otherwise the file is left alone. `ClientConfigFile.format = "toml"` routes `install.ts` and `import.ts` here. |
| `config-transfer.ts` | Export and import of MCP Hub's own configuration (`buildExport`, `parseImport`, `planImport`; routes `GET /api/config/export`, `POST /api/config/export/save` (the daemon shows the native Save As dialog through `system.pickSavePath`, an `osascript` `choose file name` on macOS with the name and prompt passed as arguments, writes the file mode 0600 where the user chose and returns the path; `{cancelled}` or `{unsupported}` otherwise, the latter making the UI fall back to the browser's own save picker/download; the path is never taken from the request), `POST /api/config/export/reveal` (shows only the file just saved) and `POST /api/config/import {data, onClash: skip\|replace\|copy, includeSources, dryRun}`). Format `{format: "mcp-hub-config", version: 1, servers, sources, localSecrets, warnings}`. References travel readable, secret values never; machine-specific source options (`opPath`, `vaultPath`) are dropped; sealed (`enc:v1:`) values are refused; existing sources are never changed. Also accepts a plain `mcpServers` file through `toServerConfig`. |
| `import.ts` | Converts other apps' MCP configs to `ServerConfig`. `unwrapInjector` undoes the 1Password injector wrapper; `unwrapRemoteBridge` turns an `mcp-remote` command (URL, `--header`s, `${VAR}` from the entry's env) into an HTTP server and refuses options it can't reproduce; `refVars(value, keep)` maps `${VAR}`/`${env:VAR}` to `{{env://…}}` except names the entry's own env defines. `knownApps()` is pure data; `scanClientConfigs(ids, only?)` reads files and only runs when the user asks. Entries that already point at the hub (bridge, `MCP Hub.app`, hub URL) are returned with `viaHub: true` and no `config`: the UI shows them as "Already uses MCP Hub" and never offers them for import. `/api/migrate` waits up to 10 s for the imported servers to settle and does not rewrite the app's entry for a server in `error` with failed credentials; it returns `problems[]` (with `blocked`) so the UI can say why. |
| `install.ts` | "Install in an app": `addServerToConfig` inserts the hub's bridge entry into an app's JSON/JSONC config as pure text insertions (matching indent, tabs/CRLF/BOM, trailing comments and commas), skips it if the hub's version is already there, refuses on a same-named different server, and verifies the result parses to the old content plus the new entry before writing (atomic replace, through symlinks, permissions kept). `installServer` runs it for the chosen apps. Every write is preceded by `backupFile`, which copies the file to a sibling `<file>.mcp-hub-backup-<time>-<seq>` (same permissions, next to the real file when it is a symlink, newest 10 kept per file); if the backup fails nothing is written. There is no restore UI: restoring means copying the backup back. `migrateConfigText` replaces existing entries' values with bridge entries while keeping their keys (apps name tools after the key), including identical per-project copies in Claude Code's file; a differing copy is left and reported. `jsonc-parser` is used only to locate nodes; its formatter is not used because it re-indents neighbours. |
| `clients.ts` | `ClientGate`: per-app approval for socket clients, and `resolveClient` (walks the bridge's parent processes with `ps`). |
| `system.ts` | Login-shell env loader, `openExternal`, desktop notifications. |
| `paths.ts` | Data directory and file locations. |
| `types.ts` | Shared types (`ServerConfig`, `SourceConfig`, `Settings`, `ServerStatus`, usage shapes) and `DEFAULT_SETTINGS`. `ServerConfig.notes` is the user's own free text (max 10,000 characters; blank is dropped), edited in the server dialog; the card only shows a small note icon whose tooltip holds the text. |

### 4.1 Proxying: the important part

The hub is a **JSON-RPC multiplexer**, not a transparent pipe. One upstream connection is shared by many downstream sessions.

**Upstream handshake.** `UpstreamConnection` uses the official MCP SDK transports as raw JSON-RPC pipes (`StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport` as a fallback). It performs `initialize` and `notifications/initialized` itself (declaring no client capabilities), caches the server's info, capabilities and protocol version, and fetches the tool count.

**Downstream sessions.** `McpEndpoint` answers a downstream `initialize` from that cache (no round trip), creates a session (`Mcp-Session-Id`), and then forwards everything else:

- **Id rewriting.** Each request gets a unique upstream id (`h<seq>`); the response is mapped back to the client's original id. Sessions can use colliding ids safely.
- **Progress.** `_meta.progressToken` is rewritten and routed back to the right request's stream.
- **Cancellation.** `notifications/cancelled` is translated to the upstream id.
- **Notifications.** Server notifications without a route (for example `list_changed`) are broadcast to all sessions' GET streams.
- **Server-initiated requests** (sampling, roots, elicitation) are not forwarded. `ping` is answered; others get `-32601`. The hub declares no client capabilities for this reason.
- **Responses.** POST returns SSE if the client accepts `text/event-stream` (so progress can stream), otherwise plain JSON. Notification-only posts return 202. GET opens a notification stream. DELETE ends a session.
- **Errors.** An unavailable upstream, a rejected credential or a dead child always becomes a **valid JSON-RPC error** for the request. (This is what fixes the old bridge's zod crash on HTTP 401.) Messages are written for end users ("needs sign-in", "turned off in MCP Hub").
- **Sessions** that are idle for 30 minutes with no open stream are swept (checked every minute). Clients that follow the spec re-initialize on 404; the shim does this transparently.

**Connection state machine** (`ConnectionState`): `disconnected → connecting → connected`, with `needs-auth` (OAuth pending) and `error` (retrying). Key behaviors:

- Keep-alive servers reconnect with exponential backoff (1 s → 60 s), but only `MAX_AUTO_RETRIES` (5) failed attempts in a row: then the connection stays in `error` ("stopped retrying…") until the user presses Retry (any manual connect, restart, enable or edit resets the count; so does a successful connect). Failures that retrying can't fix don't retry at all: the server refusing the token (HTTP 401/403, or an "invalid token / invalid_grant / refresh token / session expired" body), and for local servers the same kind of message on stderr during startup (e.g. `HTTP 401: ErrInvalidOauthToken`); the status shows the server's own reason. A connection only counts as healthy (and resets the count) after staying up for 60 s, so a server that connects and crashes immediately still runs out of retries. A denied credential prompt waits for the user too.
- On-demand servers start on the first client request and stop after `idleTimeoutMinutes`.
- `generation` counters discard events from stale transports after a reconnect.
- An upstream 404 on a streamable session triggers a restart (the session expired).
- Derived UI states (Authenticated / In use / Idle / Waiting for credentials…) are computed in `packages/ui/src/status.tsx` from `ServerStatus`; "in use" means an in-flight request or activity in the last 10 s.

### 4.2 Credentials

Server definitions hold **references**, never secrets. Any string field of a server (command, args, env values, header values, url, cwd, OAuth client secret) may contain `{{ref}}`. A bare value that starts with a known scheme is also treated as a reference.

| Scheme | Source type | Notes |
| --- | --- | --- |
| `op://vault/item/field` | `1password` | Runs `op read --no-newline`. Options: `opPath`, `account`, `allowedVaults`. |
| `keychain://service/account` | `keychain` | macOS `security` (supported). Linux `secret-tool` and Windows Credential Manager via PowerShell exist but are untested; those platforms are not finished. |
| `vault://path/to/secret#field` | `vault` | KV v1/v2 over HTTP. Token from env, `~/.vault-token`, or typed (encrypted local secret). |
| `env://NAME` | `env` | The hub's environment (includes your login-shell env). Disabled by default: it gives every server definition read access to every variable the hub can see. |
| `secret://name` | `manual` | Local secret: added in the app, encrypted, saved to `secrets.json` when the key store is available. |

`CredentialBroker.resolve(ref, requester)`:

1. Find the first **enabled** source of the matching type.
2. Return a cached value if present (sealed with the `SecretBox`, opened only to return it; expiry from `settings.cacheTtlSeconds`, 0 = until forgotten ("Forget all" / `lock()`, or one secret with `forget()`, e.g. after it was rotated); a background sweep every 15 s deletes expired entries, and changing the setting re-applies it to entries already held via `applyTtl()`).
3. Fail fast if the source is in a **denial cooldown** (`denialCooldownSeconds`).
4. **Deduplicate** concurrent requests for the same ref; **serialize** reads per source (one prompt at a time, with a re-check of the cache after queueing).
5. Call the provider, cache the result, emit `prompt` / `change` events. `denied` errors start the cooldown; `invalid`, `not-found` and `unavailable` do not.

`lock()` clears the cache and cooldowns (and, when there is nowhere to save them, local secrets; saved ones are only re-read from disk as ciphertext). Resolved values are registered with the server's `LogBuffer`, which keeps them sealed and masks them (and `Bearer`/`Basic`/`Token` payloads) in stored log lines. Notifications ("`<server>` is requesting a secret from 1Password") are rate-limited to one per 15 s.

#### Encryption of secrets and references (part of §4.2)

- **Cipher:** `SecretBox` (`credentials/box.ts`): AES-256-GCM, fresh 12-byte random IV per value, authenticated; values look like `enc:v1:<base64(iv‖tag‖ciphertext)>`. Local secrets and cache entries are bound to their name or cache key as associated data, so a ciphertext moved elsewhere fails to open.
- **Key:** one random 256-bit master key, created on the first run and kept in the OS key store (`keystore.ts`): macOS login keychain via `security` (service `MCP Hub`, account `master-key`; created through `add-generic-password`, so the key is on that command line for a moment, the one-time cost of using the system tool), Linux Secret Service via `secret-tool` (key passed on stdin). Other platforms have no key store yet, so nothing is saved encrypted there. The hub never creates a new key when sealed data already exists (it reports "key missing" and works memory-only instead, so nothing is orphaned), and any key-store failure falls back to a memory-only box with the reason shown in the UI (`credentials.encryption` in the snapshot).
- **What is sealed:** (1) credential references inside server definitions (`{{…}}` or bare `op://`-style values in `command`, `cwd`, `url`, `args`, `env`, `headers`, `oauth.clientSecret`), in `config.json` and in `ConfigStore`'s memory: `ConfigStore.reveal()` opens a copy only for the UI snapshot and for `UpstreamConnection.resolveConfig()`, and `upsertServer()` seals on the way in (existing plaintext configs are migrated on first start); (2) local secrets, in `secrets.json` (mode 0600) and in memory; (3) the broker's cache of fetched secrets; (4) the secret values a `LogBuffer` masks; (5) remembered OAuth sign-ins, in `signins.json` (see §4.3).
- **Limits (be honest in the UI and docs):** the master key is in the hub's memory while it runs and any process running as you can ask `security` for it, so this protects data at rest, in backups, in swap and in casual memory dumps, not against malware running as the same user. Values handed to a running server (child environment, request headers) and the OAuth tokens the SDK holds are plain in memory while in use (remembered ones are sealed only at rest).
- **Recovery when the key is lost** (keychain item deleted, new computer, keychain unavailable): the sealed data stays on disk untouched and the hub runs memory-only with `credentials.encryption.locked = true` and a reason. `SecretBox` is mutable (`adopt()`) so everything holding it follows a key change without a restart. `settings.recoveryKeySaved` records that the user confirmed saving a copy: the first-run tour (`Welcome` in `Onboarding.tsx`) has a "Save your recovery key" step (shows the key masked through the shared `RecoveryKeyPanel`, which only fetches and shows it after the user clicks the eye, here and in the Encryption card's dialog; with Next disabled until the box is ticked and an always-available "Skip for now"), and the Encryption card nags until it is set. `GET /api/credentials/recovery-key` shows the key (only when it is the real one, on explicit request; the UI's Encryption card has Show recovery key). `POST /api/credentials/restore-key {key}` validates it (32 bytes, and it must open at least one saved value, otherwise nothing changes), writes it back to the key store, re-seals anything saved readable meanwhile, reloads local secrets and retries servers that failed on credentials. `POST /api/credentials/reset-encryption` is the last resort and only works while encryption isn't working (409 otherwise): it makes a new key, deletes local secrets, empties the sealed values that can't be opened and switches off the servers that held them (the response lists them). There is deliberately no way to recover without the key or a recovery copy.

To add a provider: implement `ProviderFactory` (`credentials/types.ts`), register it in `FACTORIES` and `SCHEME_FOR_TYPE`/`TYPE_FOR_SCHEME`, add the type to `SourceType` (core and UI `types.ts`), and add UI copy in `pages/Credentials.tsx` and the picker in `AddServer.tsx`.

### 4.3 OAuth remotes

`HubOAuthProvider` keeps tokens, dynamic client registration info and the PKCE verifier **in memory**; tokens and registration info can also be **remembered** across restarts (below). When the SDK needs authorization, the provider records the URL and the connection enters `needs-auth`. The UI's **Sign in** button calls `POST /api/servers/:id/signin`, which opens the browser (`openExternal`). The redirect URI is the hub's own `/oauth/callback`; `HubManager.handleOAuthCallback` matches the `state` to the waiting connection, calls `finishAuth`, and reconnects. Optional pre-registered `clientId`/`clientSecret` can be set per server.

**Remembered sign-ins.** Off by default. `settings.rememberSignIns` is the default and `oauth.remember` (true/false, unset = follow the default) overrides it per server (the Remember sign-in control in the server dialog; `UpstreamConnection.remembersSignIn()`). When a server remembers, `HubOAuthProvider` writes `{tokens, client registration, origin}` to `SignInStore` (`credentials/signins.ts`) on every `saveTokens`/`saveClientInformation`/`invalidateCredentials`, and loads it when the provider is created on the next run, so the SDK refreshes silently with the saved refresh token instead of starting a browser sign-in. The PKCE verifier is never saved. `SignInStore` seals each entry with the `SecretBox`, bound to `signin:<serverId>` so it can't be moved to another server, in `signins.json` (mode 0600), and writes only while the key is in an OS key store (otherwise it keeps nothing and the snapshot says `credentials.signIns.available = false`). The non-secret facts (saved at, access-token expiry, whether a refresh token exists) sit next to the ciphertext for the "Remembered sign-ins" card. `settings.signInTtlSeconds` (default 30 days, 0 = until forgotten; its own setting because "Forget after" for fetched secrets tops out at 24 hours) limits how long an entry lives, counted from `savedAt`, which moves only when the tokens actually change (a refresh), not when the same value is saved again. `SignInStore.expire()` runs on read, on load, when the setting changes and from a 60 s sweep in `Hub`. An entry is ignored and deleted if the server's origin changed, and an expired one with no refresh token is dropped when read. Entries are deleted on sign-out (`POST /api/servers/:id/signout`, also the card's Forget button), when the SDK drops the tokens (rejected refresh token), when the server is deleted or stops remembering (`HubManager.update`, or `PUT /api/settings` via `syncRememberedSignIns()` for servers that follow the default), at startup for servers that no longer exist, and on "Reset encryption". "Forget all" (`POST /api/credentials/lock`) does not touch them. A recovery-key restore re-reads them (`reload()`) and counts them when checking that the key is right. They are not part of config export.

### 4.4 Usage metrics

`Metrics.record()` accumulates per minute in memory and flushes to SQLite every 5 s (WAL). Tables:

- `usage_minute(minute, server_id, client, bytes_in, bytes_out, requests, errors, lat_sum, lat_count, b0..b6)`: latency histogram buckets for p95. `client` is the app's name (the approved socket client, or "Direct HTTP"); "" means the row predates per-app tracking. Older databases are migrated in place on startup (`Metrics.migrate`).
- `tool_hour(hour, server_id, client, tool, calls, errors)`.
- Attribution: `McpEndpoint` stores the client on each session; `UpstreamConnection` records it with every sample and also reports the attached apps (`ServerStatus.clients`, with `active` and `inFlight`) for the UI's hover list. `/api/usage` and `/api/usage.csv` take an optional `client` (an empty value selects unattributed traffic).

Bytes are the JSON-RPC message sizes (client→server is `bytes_in`, server→client is `bytes_out`). **Only real work counts:** the MCP handshake (`initialize`, `notifications/initialized`), the hub's own connection check, tool counting and the UI's tool listing are not recorded, so connecting or validating a server adds nothing. `Metrics.clear(serverId?)` wipes the history for the "Clear history" button. A request counts as an error if the response has a JSON-RPC `error` **or** `result.isError === true`. Only sizes and timings are stored, never payloads. `query(range, server?)` returns buckets sized by range (1 m / 15 m / 2 h / 1 d), totals with avg and p95, and top tools. History is pruned by `retentionDays` at startup and removed when a server is deleted. `node:sqlite` is experimental in Node 24 (it prints a warning); there are no native dependencies.

## 5. Persistence

All paths come from `paths.ts`; override the directory with `MCP_HUB_HOME`.

| OS | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/MCP Hub` |
| Windows (not finished) | `%APPDATA%\MCP Hub` |
| Linux (not finished) | `$XDG_CONFIG_HOME/mcp-hub` (or `~/.config/mcp-hub`) |

Files: `config.json` (servers, credential sources, settings; written atomically, mode 0600; a corrupt file is renamed aside), `usage.sqlite`, `logs/<server>.jsonl` (masked), `secrets.json` (local secrets, AES-256-GCM ciphertext, mode 0600), `signins.json` (remembered OAuth sign-ins, only when enabled; same protection), `runtime.json`. **No secrets are ever written in readable form**: references in `config.json` are sealed too (see §4.2, "Encryption"). The 1Password and keychain sources are added once on first run (`settings.sourcesAutoConfigured`), so a removal stays removed. A client access token is generated into settings on first run (used only if "Require an access token" is on).

## 6. HTTP surface

Security checks run first on every request: the `Host` must be `127.0.0.1`/`localhost`/`[::1]` with the listening port (blocks DNS rebinding), and any `Origin` must be the hub itself (or `MCP_HUB_DEV_ORIGIN`).

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | `{ok, app:"mcp-hub", version}` |
| `/mcp/<id>` (POST, GET, DELETE) over `hub.sock` | the app must be approved (see 8.1) | Downstream MCP endpoint |
| `/mcp/<id>` over TCP | refused unless `allowTcpMcp`; then none, or client token if `requireClientToken` | Same endpoint, for apps that cannot use the bridge |
| `GET /oauth/callback` | none (validated by OAuth `state`) | OAuth redirect target |
| `/api/*` | UI token (`Authorization: Bearer` or `?token=`) | Management API |
| anything else | none | Static UI (SPA fallback), path-traversal safe |

`/api` endpoints: `GET /api/state` (full snapshot), `GET /api/events` (SSE: `state` snapshots, `log` lines); servers (`POST /api/servers`, `GET|PUT|DELETE /api/servers/:id`, `POST …/{enable|disable|restart|signin|signout}`, `GET|DELETE …/logs`, `GET …/tools`); sources (`POST /api/sources`, `PUT|DELETE /api/sources/:id`, `POST …/test`, `PUT …/token`); secrets (`PUT|DELETE /api/secrets/:name`, `POST /api/credentials/lock` ("Forget all": drops fetched secrets from memory), `DELETE /api/credentials/cached {sourceId, ref}` (forgets one fetched secret via `broker.forget()`; 404 if not held), `GET /api/credentials/setup` (installed-tool check for the 1Password and keychain sources; `credentials/setup.ts`; runs only `op --version` and similar, never a read; adopts an `op` found outside PATH as the source's `opPath`), `POST /api/credentials/setup/:sourceId/install` (`credentials/op-installer.ts`, `vault-installer.ts`: downloads the official CLI into `<data dir>/tools/<op|vault>/<version>/` and sets the source's `opPath`/`vaultPath`; newest release with a pinned fallback; 1Password's zip must carry a valid 1Password code signature (`codesign` Authority on macOS, Authenticode on Windows), Vault's must match HashiCorp's published SHA-256; both must report the downloaded version; fails closed; 1Password isn't offered on Linux), `POST /api/credentials/setup/:sourceId/sign-in` (Vault only: runs `vault login -no-print -address=… -method=<source.loginMethod|oidc>`)); usage (`GET /api/usage?range=1h|24h|7d|30d&server=`, `GET /api/usage.csv`, `DELETE /api/usage[?server=]` clears the history and the cards' running totals; logs are kept); settings (`GET|PUT /api/settings`, `POST /api/settings/rotate-client-token`); apps (`POST /api/clients/:id/decision {allow, servers?}`); import (`GET /api/import/apps`, `GET /api/import/scan[?client=]`, `GET /api/config/export`, `POST /api/config/import` (see `config-transfer.ts`), `POST /api/servers/:id/install {clients, dryRun?, replace?}` (edits only the named apps' config files, after a backup; `dryRun` returns `{preview}` per app: `add|replace|already|conflict|no-file|error` plus the same-named `existing` entries with a secret-free summary, and writes nothing; without `replace` a same-named different entry is refused as `conflict`, with `replace: true` it is swapped for the hub's entry under the same key and reported as `replaced`); `POST /api/install {client, servers, dryRun?, replace?}` (the same for several servers into one app, used by the Install… button after scanning an app in Settings: `installServers()` reads the file once, backs it up once and writes it once; `dryRun` returns `{preview: {client, path, servers: [...]}}`, otherwise `{result: {client, path, backup?, servers: [...]}}` with a status per server); `POST /api/migrate {client, names, onClash: keep|replace}` (imports the servers, then rewrites that app's entries under the same keys, after a backup); `POST /api/import`: each server may carry `replaceId` to replace that server in place, keeping its id, enabled state and lifecycle; the UI asks before doing so). Errors are `{error: string}`. The authoritative source is `Hub.api()` in `hub.ts`; the UI mirrors the shapes in `packages/ui/src/types.ts` (keep both in sync with `core/src/types.ts`).

## 7. UI (`packages/ui/src`)

- **State:** `api.ts` holds a single store fed by the SSE `state` events (`useStore()` via `useSyncExternalStore`), plus `api()` and `download()` helpers. The snapshot is the single source of truth; mutations call the REST API and the next event updates the UI.
- **Structure:** `App.tsx` (shell, hash routing `#/servers|credentials|usage|settings`, onboarding) → `pages/{Servers,Credentials,Usage,Settings}.tsx`; dialogs `AddServer.tsx`, `ConnectClient.tsx`, `Onboarding.tsx` (welcome and import); primitives in `ui.tsx`; theming in `theme.ts` and CSS variables in `index.css`; helpers in `lib.ts`.
- **Theming:** semantic color tokens (`--bg`, `--surface`, `--accent`, …) switch on a `.dark` class; Tailwind reads them through `@theme inline`. Follows the system by default.
- **Accessibility:** dialogs and drawers trap focus and close on Escape; status is never color-only.
- **Token handling:** `initToken()` moves `?token=` into `sessionStorage` and rewrites the URL.

## 8. Stdio shim (`packages/shim/src/shim.mjs`)

Reads JSON-RPC lines on stdin and POSTs them to `/mcp/<id>`. It handles JSON and SSE responses, holds the session id, opens the GET stream for notifications, and on a 404 **re-initializes and retries** once. It discovers the hub from `--url`/`MCP_HUB_URL`, then `runtime.json`, then port 47615, and re-discovers per request. If the hub is not running it returns a JSON-RPC error ("MCP Hub isn't running…"). A client token (only for direct HTTP) comes from `--token`/`MCP_HUB_CLIENT_TOKEN` or `runtime.json`. When `runtime.json` names a socket that exists, the shim uses it (`socketFetch`) and sends `X-MCP-Hub-Pid`; an explicit `--url` forces TCP. It must stay dependency-free so it starts fast and packages as a small executable.

### 8.1 Local socket and per-app approval

The hub listens on `<data dir>/hub.sock` (mode 0600; macOS and Linux) serving only `/mcp/<id>` and `/health`. Every request carries `X-MCP-Hub-Pid`, the bridge's pid. `ClientGate.authorize` resolves it to a client: the nearest ancestor that is not a shell or launcher (`sh`, `zsh`, `npx`, ...); for apps, the topmost process of the enclosing `.app`, so all helpers share one identity; for node/python CLIs, the script or package name. The key is `pid:start time` of that process. The first request creates a **pending** client and the UI (and a notification, and the desktop shell's window) asks the user; requests wait up to 50 s, then get a 403 JSON-RPC error with `data.approval = "pending"`, which the shim retries for up to five minutes. One decision covers every connection the app opens, and it also says which servers the app may use: the approval dialog ticks every server by default, and unticking some sets `ClientInfo.allowed` to that list (`null` = every server, including ones added later; choosing all of them stores `null`). `authorize` returns `denied` with a reason for a server outside the list, on every request, so changing the choice (Settings → Apps → Choose servers…, `decide(id, true, servers)`) applies at once. Entries are removed when the client's pid dies (checked every 5 s), so the next launch asks again. Nothing is persisted. The pid header is self-reported, so this is consent and visibility, not a defence against hostile same-user code.

## 9. Desktop shell (`apps/desktop`)

`lib.rs` (tray, window, polling `/api/state` every 5 s for the status line, "Forget all secrets", autostart toggle, navigation guard, quit handling) and `daemon.rs` (spawn, ready-line parsing with a 30 s timeout, stderr tail for error dialogs, graceful stop, process-group kill, `Drop`). `build.rs` stages `packages/ui/dist` into `src-tauri/resources/ui` and creates placeholder sidecars in debug builds. Release builds require `npm run build:sidecars` and a built UI.

## 10. Testing

Run `npm test` (core 43, UI 10) and `npm run typecheck`.

| Suite (`packages/core/test`) | Covers |
| --- | --- |
| `proxy.test.ts` | End to end with the **official SDK client** through the hub: tools, env credential injection, concurrent sessions with colliding ids, progress routing, tool errors, metrics, disable/enable, restart. |
| `http-upstream.test.ts` | Remote HTTP upstream with header credential injection, 401 → clear error, missing credentials. |
| `broker.test.ts` | Cache, dedup, serialization, TTL, denial cooldown, lock, forgetting one secret, allowed vaults, templates (uses `fixtures/fake-op.mjs`). `test/setup-hermetic.ts` (a vitest setup file) makes the real `op`, `vault`, `security` and `secret-tool` fail as "not found" in every test, so no test can prompt for 1Password or the keychain. |
| `encryption.test.ts` | `SecretBox` (round trip, tamper, wrong key/binding), master-key handling and fallbacks, local secrets on disk and across restarts, sealed references in `config.json` (and legacy migration), encrypted cache and log masks, "forget after" applied to held secrets. Uses `memoryKeyStore()`; `startHub` does too, so tests never touch the real keychain. |
| `signins.test.ts` | `SignInStore` (sealed on disk, bound to the server, wrong key, no key, expiry, prune), `HubOAuthProvider` saving/restoring/forgetting, and in the hub: a restart that signs in without the browser, the per-server opt-out and the default setting. |
| `codex.test.ts` | Codex TOML: reading tables, exact-output add and migrate (comments, CRLF, sub-tables, headers inside strings and arrays, layouts it won't touch), `CODEX_HOME`, and install/migrate through the API. |
| `config-transfer.test.ts` | Export contents and warnings, reading both file formats, import planning (skip/replace/copy, sources, missing local secrets), and a round trip between two hubs. |
| `metrics.test.ts`, `logs.test.ts`, `usage-reset.test.ts` | Aggregation, ranges, prune, CSV, percentiles, secret masking; handshake exclusion, clearing usage, slow/cancelled request logging, persisted logs. |
| `security.test.ts` | Host/Origin checks, token requirements, client-token mode, input validation, traversal, forged OAuth callbacks, JSON-RPC error shapes. |
| `shim.test.ts` | The shim end to end, session recovery, hub-not-running error. |

`test/helpers.ts` starts a throwaway `Hub` on a random port with an in-memory usage DB. Use `fixtures/mock-mcp.mjs` (tools `echo`, `env`, `slow`, `boom`) as a stand-in MCP server. The broker tests skip on Windows (the fake `op` is a shebang script).

**Not covered by automated tests yet:** the Tauri window and tray, real OAuth, Vault, Windows keychain and Linux libsecret, and the compiled sidecars end to end.

## 11. Development workflow

```bash
npm install
npm run dev                                    # daemon + Vite together (token defaults to "devtoken", Origin preset)
npm run dev:core                               # daemon; prints the UI URL with token
MCP_HUB_DEV_ORIGIN=http://localhost:5173 npm run dev:core   # when using the Vite dev server
npm run dev:ui                                 # http://localhost:5173/?token=<token>
npm run dev -w @mcp-hub/desktop                # desktop app (build the UI first)
```

Use an isolated instance (`MCP_HUB_HOME=$(mktemp -d) MCP_HUB_PORT=47999 MCP_HUB_TOKEN=devtoken`) so you do not touch your real config. `packages/core/scripts/demo-traffic.mjs` seeds demo servers and traffic.

Daemon environment variables: `MCP_HUB_HOME`, `MCP_HUB_PORT`, `MCP_HUB_TOKEN`, `MCP_HUB_UI_DIR`, `MCP_HUB_SHIM`, `MCP_HUB_DEV_ORIGIN`.

**Releases.** `.github/workflows/release.yml` runs only on a push or merge to `master` that changes something other than docs (`*.md`), screenshots, tests, `demo-traffic.mjs`, `scripts/dev.mjs`, `scripts/gen-desktop-icons.py` or `.gitignore` files (`paths-ignore`; a push that mixes those with app changes still runs): a `test` job (typecheck, tests, and `scripts/version.mjs check`, which fails unless all 8 version files agree) gates a `build` matrix that uploads the installers as artifacts, then a `release` job publishes them plus `SHA256SUMS.txt` with `softprops/action-gh-release` only when `gh release view v<package.json version>` finds no release (the tag is created at the pushed commit), so a release is a version bump merged to master. Each platform builds on its own runner because `build-sidecars.mjs` embeds the host's Node (macOS arm64 on `macos-latest`, Intel on `macos-15-intel`; Windows and Linux are not in the matrix). The build runs `npm run build:app`, which smoke-tests both sidecars before bundling. Spotlight is turned off on the macOS runners and a failed build is retried up to three times (detaching leftover `bundle/dmg` images first), because `hdiutil` sometimes fails to eject the installer image ("couldn't eject disk, Resource busy"). Signing and notarization are driven by `APPLE_*` secrets and skipped when absent; the entitlements needed by Node's JIT under the hardened runtime are in `Entitlements.plist`. `scripts/version.mjs set <x.y.z>` bumps every version file (root and package `package.json`s, `tauri.conf.json`, `Cargo.toml`, `core/src/version.ts`). **Not yet exercised on GitHub:** the workflow has only been checked against the workflow schema, and the signed/notarized path is untested.

## 12. Design decisions and gotchas

- **Why a TypeScript daemon (not Rust):** the official MCP SDK already implements the client transports and the OAuth client flow; the proxy is mostly JSON-RPC bookkeeping. The cost is a ~117 MB sidecar because it embeds Node. Revisit if size matters.
- **Why the hub does its own handshake:** it lets many clients share one upstream and gives instant `initialize` answers, but it means upstream capabilities are fixed at connect time and client capabilities are not passed through.
- **Why the bridge and a socket are the default:** a socket reachable only by your user plus a per-app approval removes the need for client tokens, and keeps credentials out of every client's config. Streamable HTTP is still implemented underneath (the socket carries the same HTTP) and can be exposed on localhost for apps that cannot use the bridge.
- **Stale sessions:** clients such as the SDK do not always send DELETE, so "clients attached" can be inflated until the 30-minute sweep.
- **TypeScript narrowing in `upstream.ts`:** `this.state` is re-read through `isConnected()` after awaits, because TS keeps a stale narrowing across them. Follow that pattern when editing.
- **Id prefixes:** upstream ids `hub-init-*`, `hub-tools-*` are internal (handled by `waiters`); `h<n>` are forwarded client requests. Do not reuse these prefixes.
- **Reconnect and generation:** always check `gen === this.generation` in async connection code so a stale transport cannot change state.
- **Denial semantics:** only user denials (`kind: "denied"`) start a cooldown. A config problem such as a disallowed vault must use `invalid`. (A test caught this once.)
- **Rust version:** Tauri's newest releases need rustc 1.90; the repo pins resolution for 1.86 via `src-tauri/.cargo/config.toml`. Delete that file after upgrading Rust.
- **SEA builds** are ad-hoc signed on macOS unless the `APPLE_*` release secrets are set (see §16 "Releasing"). `Entitlements.plist` already carries the JIT entitlements Node needs under the hardened runtime.
- **esbuild bundle** injects a `require` shim through a banner because some dependencies use CommonJS `require` inside an ESM bundle.
- **Windows and Linux** keychain paths exist but have only been exercised on macOS.
- **`npm audit`** reports dev-only findings in vitest's `tinypool` and `@vitest/mocker`; fixing them needs a major vitest bump.
- **Not verified end to end:** launching the Tauri window and tray (tray menu, status polling, close-to-tray, autostart, the restart/quit dialog); the compiled shim binary (its logic is covered by Node tests); real OAuth against a remote server, a real Vault, Windows Credential Manager and Linux libsecret; the Windows and Linux builds; signed/notarized installers and the release workflow on GitHub; UI end-to-end tests beyond helper unit tests.

## 13. Known limitations and roadmap

- Forward server-initiated requests (sampling, roots, elicitation) to a chosen client.
- Auto-update (`tauri-plugin-updater`) and a smaller sidecar. (Per-client usage attribution, one-click Install/Migrate into other apps, and a release workflow now exist.)
- Automated UI/E2E tests (Playwright) and CI for pull requests (today CI only runs on release).
- A `/api/events` snapshot is sent on every change; fine for tens of servers, but consider diffs if it grows.
- **Windows and Linux are not finished.** MCP Hub is built and tested on macOS only. The Windows Credential Manager and Linux libsecret key paths, the Windows/Linux installers and the per-app local-socket approval (macOS and Linux only) exist in code but have not been exercised, and no Windows or Linux build is published. You can run the daemon and UI from source on them, at your own risk.
- **If the encryption key is lost** (the keychain item is deleted, or you move to a new computer), nothing is deleted: saved secrets stay on disk but are locked, and the Credentials page says so. Save a copy of your **recovery key** in a password manager: the welcome tour has a "Save your recovery key" step that shows it (hidden until you click the eye) and asks you to confirm you've saved it (you can skip it, and the Credentials page keeps reminding you until you do; Credentials → Encryption → Show recovery key shows it any time). With it, **Restore key** unlocks everything again; MCP Hub checks the key really opens your saved secrets before accepting it. If there is no copy, **Start over** makes a new key, but whatever was encrypted with the old one is gone: local secrets are deleted, and servers that used encrypted references have those values emptied and are switched off so you can fill them in again.
- OAuth sign-ins are only saved across restarts if you turn on "Remember sign-ins" (globally or per server); otherwise you sign in again after a restart.
- Server-initiated requests (sampling, roots, elicitation) are not forwarded to clients yet; the hub declares no client capabilities to upstream servers.
- The desktop installers (signing, notarization, auto-update) are not produced or verified yet; see the desktop README.

## 14. Feature reference

What MCP Hub does, in detail. (The README is the short version.)

- **Proxies every MCP server.** Many clients can share one running server; request ids and progress notifications are routed back to the right client.
- **Apps connect through a private local socket, with one approval per app.** Each app launches the bridge (`mcp-hub-stdio <server-id>`), which finds the hub by itself and talks to it over a Unix socket in the hub's data directory. The first time an app connects, MCP Hub asks you to allow it and which of your servers it may use (all are ticked by default); the answer covers every connection that app opens until it quits, and you can change the server choice later in Settings. No tokens to store or pass around. The bridge transparently starts a new session if the hub restarts.
- **Unauthenticated HTTP connections are optional, not recommended** and off by default (Settings → Security → "Allow unauthenticated HTTP connections"): `http://127.0.0.1:47615/mcp/<server-id>` for apps that cannot use the bridge. Those connections are not approved per app.
- **Credentials are encrypted.** Server definitions contain references like `{{op://Vault/Item/field}}`, never secrets, and those references are themselves encrypted (AES-256-GCM) in the config file and in memory, decrypted only to show them in the app or to use them. The hub resolves them on demand and holds the results **encrypted in memory** for a time you choose (Settings, or the Credentials page: 1 minute to 24 hours, or until you forget them) before forgetting them, plus a "Forget all" button and a Forget button on each secret (handy after rotating one). The encryption key is a random 256-bit key kept in your OS keychain (macOS Keychain; Linux Secret Service), never in MCP Hub's own files. Concurrent lookups are de-duplicated and serialized so you see one 1Password prompt at a time, with a cooldown after a denied prompt.
  - **Set up automatically:** on first run MCP Hub adds the 1Password and OS keychain sources and quietly checks that their tools are installed, without reading anything or triggering a prompt. You only see something if a tool is missing. For the 1Password CLI (`op`) on macOS and Windows, **Install for me** downloads 1Password's official signed CLI into MCP Hub's own folder (nothing else on your computer changes); it is used only after its signature is confirmed to be 1Password's and it reports the expected version. Manual steps (`brew install --cask 1password-cli`, `winget`, the install guide) are one click away, and Linux shows the libsecret and 1Password instructions. An `op` found outside the PATH the app sees is remembered. After installing, turn on Settings → Developer → "Integrate with 1Password CLI" in the 1Password app.
  - **Vault:** if `VAULT_ADDR` is set in your shell, a Vault source is added for you (address from the environment, token from `~/.vault-token`). Nothing about Vault is shown otherwise. Vault is read over its HTTP API with a token, so the CLI is only needed to get one: when there's no token you see a **Sign in** button (it runs `vault login`, which opens your browser for OIDC; other methods can be set per source), and if the Vault CLI is missing, **Install for me** downloads HashiCorp's official CLI into MCP Hub's own folder after checking its SHA-256 against HashiCorp's published checksums and its reported version.
  - Sources: **1Password** (CLI), **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret), **HashiCorp Vault**, **environment variables**, and **local secrets** you add to the app (encrypted with AES-256-GCM and saved on your computer; the key stays in your OS keychain).
- **Credential sources are editable.** Every source card has Edit (address, mount, namespace, token source, sign-in method, CLI path), including the ones MCP Hub set up for you. A failing Vault test says why, in Vault's own words (for example `HTTP 403: permission denied`), what usually causes it, and offers Sign in when the token comes from `~/.vault-token`.
- **Remote servers**: static headers/tokens (from any credential source) or full **OAuth** sign-in. Upstream failures such as an expired token are turned into clear JSON-RPC errors for the client instead of crashing it.
- **Live status** per server: Authenticated · In use · Idle · Connecting · Waiting for credentials · Needs sign-in · Error · Off. Connect or disconnect any server at any time.
- **Usage dashboard**: bytes in/out, requests, errors, latency (avg/p95) and top tools per server over 1h/24h/7d/30d, filterable by server and by the app that made the requests, stored locally in SQLite (sizes, timings and app names only, never payloads). Connecting to a server or testing it isn't counted, and "Clear history" gives you a fresh slate. CSV export. Hover a server's "In use" badge to see which apps are using it. A **Connected apps** section lists every app that is allowed in and still running, alphabetically, each with a live "Ns ago" time since it last talked to the hub; it refreshes every 5 seconds.
- **Export and import your MCP configuration** (Settings → Backup & sharing). Export saves your servers (including notes) and any extra credential sources to one JSON file that **you choose the location of** (a native Save As dialog on macOS; afterwards the dialog shows the exact path, with a Show in Finder button, and the file is readable only by you). Credential references such as `{{op://…}}` are saved as references; secret values are never included (not local secrets, not cached values), and machine-specific tool paths are left out. Before saving, the dialog warns about values typed straight into a server's env or headers (they go into the file as written) and lists the local secrets to add again. Import accepts that file, or a plain `mcpServers` file, and shows a preview before changing anything: which servers are new, which already exist (skip, replace or keep both) and which credential sources would be added (existing ones are never touched). Encrypted values from another computer are refused with an explanation.
- **Install** a server into other apps: Install in an app adds MCP Hub's bridge entry for that server to the config files of Claude Desktop, Claude Code, Copilot CLI, Cursor, Augment (Auggie CLI, `~/.augment/settings.json`), VS Code and ChatGPT / Codex. It edits the file text in place: your formatting, comments and other servers are untouched, nothing is added if it is already there. If an app already has an entry for the same MCP (same name), Install first runs a pre-flight check and shows a review step: which apps and which entries (key and command or URL, never arguments or headers) would be replaced, and nothing is written until you press "Back up and replace". It then replaces those entries with MCP Hub's under the same key, so tool names don't change. Config files are only opened for the apps you tick, when you press Install, and each file is first copied next to the original as `<file>.mcp-hub-backup-<time>` (same permissions, newest 10 kept per file), so you can restore it by copying it back. The same works from the other side: after scanning an app in Settings, its **Install…** button lets you tick several of MCP Hub's servers and add them all to that app in one go, with the same review step and a single backup for the whole batch.
- **Import** servers from Claude Desktop, Claude Code, Copilot CLI, Cursor, Augment, VS Code and **ChatGPT / Codex** configs. (The ChatGPT desktop app, the Codex CLI and the Codex IDE extension all read `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`, so they share one entry. It is TOML: `[mcp_servers.<name>]` tables are read, `bearer_token_env_var` and `env_http_headers` become `{{env://…}}` references, and Install and Migrate edit only the text of the tables involved, keeping comments and everything else, with the same backup and safety checks as the JSON apps.) MCP Hub only reads another app's config when you press Scan for that app, and it lists entries that already go through MCP Hub as "Already uses MCP Hub" without offering to import them. After scanning an app you can **Migrate to MCP Hub**: it backs up the file, adds the app's servers to MCP Hub (secrets like `op://…` become references) and changes each of the app's entries to run through MCP Hub *under the same name*, so the tool names the app shows don't change. Configs may contain comments and trailing commas. Standard local (`command`/`args`/`env`) and remote (`url`/`headers`) entries import as they are. An `op run --env-file=app.env -- command args…` entry (`unwrapOpRun`) becomes the program it runs plus the file's variables as the server's env: `op://` values turn into hub references, plain values are kept as written (as `op run` passes them), several `--env-file` options apply in order (later wins, and the file wins over the entry's own env, as in `op run`), and a relative file is resolved against the entry's `cwd`. The env file is read only for that entry during a Scan or Migrate, and if it is missing, unreadable, has a multi-line value, or `op run` uses `--environment`, the entry is left as it was. An `mcp-remote` entry (how Claude Desktop reaches an HTTP server, e.g. `npx mcp-remote https://… --header "Authorization: Bearer ${TOKEN}"` with `TOKEN` in its `env`) is recognised, including when run through the 1Password injector, and imported as the HTTP server it really is: its URL and headers, with `${VAR}` filled in from the entry's own `env` and secret references kept as references. In a command entry, a `${VAR}` that the entry's own `env` sets is left for the program to expand; any other `${VAR}` or `${env:VAR}` becomes a `{{env://VAR}}` reference (turn on the Environment source for those), and servers marked `disabled` are imported switched off. `${input:…}` prompts aren't supported. If a server can't be set up in MCP Hub (for example a reference can't be resolved), Migrate leaves that entry in the app as it was and says why.

## 15. Security model

- The hub listens on `127.0.0.1` only. Requests with an unexpected `Host` (DNS rebinding) or a foreign browser `Origin` are rejected.
- The management API needs a random per-run token. The UI receives it in the URL the desktop shell opens, keeps it in `sessionStorage`, and removes it from the address bar.
- **Any process on your computer can use the `/mcp/…` endpoints**, and therefore the secrets behind them, unless you turn on **Require an access token** in Settings. Clients then must send `Authorization: Bearer <token>` (the "Connect a client" snippets include it).
- Secrets are never written to disk or to logs in readable form (resolved values are masked in server logs, and the masks are kept encrypted too). Local secrets and credential references are saved only as AES-256-GCM ciphertext. If your OS keychain can't be used, nothing is encrypted for saving, so nothing is saved: local secrets stay in memory and Settings says why. Remaining limits: a value handed to a running server (its environment, or request headers for a remote server) is plain while that server runs, OAuth tokens are held by the MCP SDK in memory unencrypted while in use, and malware running as you can still read the key from your keychain or the hub's memory. Servers that drive other Mac apps with AppleScript (Outlook, Mail, Calendar) run as children of MCP Hub, so macOS asks once to let **MCP Hub** control that app (System Settings → Privacy & Security → Automation). Server logs are kept per server under the data folder (`logs/`, readable only by you, 1 MB cap) so you can look back after a restart or a timeout; they include slow (5 s+) and failed requests, requests still running after 30 s, and apps that cancelled or disconnected while waiting. OAuth sign-ins are held in memory unless you choose to remember them: **Remember sign-ins** (Credentials page, off by default, with a per-server override in each OAuth server's settings) saves the tokens encrypted (AES-256-GCM, bound to the server) in `signins.json`, so a restart doesn't need a new browser sign-in. They are listed under "Remembered sign-ins", can be forgotten one by one, are forgotten automatically after a time you choose (**Forget after**: 1 day to 90 days, or until you forget them; 30 days by default, counted from the last sign-in or token renewal, so a sign-in you use keeps renewing itself), and are never saved without the keychain key. "Forget all" only clears fetched secrets, not remembered sign-ins.
- Config files contain references, not secrets (`config.json` is created with mode 0600).

## 16. Releasing

```bash
node scripts/version.mjs set 1.2.3     # writes 1.2.3 into every file that carries the version (8 of them)
git commit -am "Release 1.2.3"
git push origin master                 # or merge a pull request into master
```

Every push to master that changes app code runs the tests (the build stops early if the version files disagree with each other) and builds the macOS installers (Apple silicon and Intel, each on its own runner because the hub and bridge are packaged with the Node that builds them), keeping them as workflow artifacts for 14 days. If the version has no GitHub Release yet, the installers are also published as release `v1.2.3` (the tag is created for you) with `SHA256SUMS.txt` and generated release notes. A version with a hyphen (`1.2.3-beta.1`) is published as a pre-release. Pushes that don't change the version publish nothing, so ordinary merges are safe.

- **No tags or manual runs:** nothing triggers the workflow except a push to master. Windows and Linux aren't built; add runners to the matrix to try them.
- **Signing is optional.** Without secrets the macOS builds are unsigned (people open them with right-click → Open the first time). To sign and notarize, add these repository secrets: `APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`. A signed build keeps the same Keychain key and macOS permissions across updates; an unsigned one may ask again.
