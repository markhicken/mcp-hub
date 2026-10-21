# Windows support: plan and todo list

> **Handoff file.** Written on macOS to be picked up from a Windows machine (pull the repo, open a Copilot CLI session in it, and say "continue the work in WINDOWS-TODO.md"). Tick the boxes below as items are finished and keep the "Findings log" section current, so the next session has the context. Not committed automatically (repo rule: never commit without permission).

## How to resume on Windows
1. `git pull`, install Node >= 24, Rust (MSVC toolchain), and the WebView2 runtime; `npm ci`.
2. Run `npm run typecheck` and `npm test` first to get the Windows baseline (many suites currently skip or fail on win32; that is expected and is item 12).
3. Pick the first unchecked item whose dependencies are done. Items marked **(needs Windows)** can only be verified on a real machine; record the result in the Findings log.
4. Rules from `AGENTS.md` still apply: no commits without permission, use npm, every path in the UI is a `PathLink`, every secret read/app connection is attributed and recorded in History.

## Goal
Make MCP Hub work on Windows with the **same local-app model as macOS**: apps launch `mcp-hub-stdio`, which reaches the hub over a private local channel, and the user approves each app once. HTTP stays optional and off by default. Also: persist secrets safely, stop servers cleanly, and ship an installer.

Decisions (confirmed): master key in **Credential Manager, DPAPI file fallback**; **x64 + ARM64**; **NSIS per-user .exe** only; tested by **CI (windows-latest) + manual runs on a Windows machine**.

## Current state (what already works vs. what doesn't)

Already Windows-aware: data dir (`%APPDATA%\MCP Hub`), `keychain://` read via PowerShell + `CredRead`, `op`/`vault` detection + installers, client-config paths in `import.ts`, `openExternal`, Tauri job object (kill-on-close), `taskkill` force kill, `.exe` sidecar naming, shim data dir.

Broken or missing on Windows today:

| # | Area | Today | Impact |
|---|---|---|---|
| 1 | **Local app channel** (`hub.ts listenSocket`) | `if win32 return` – no socket at all | Apps can only use unauthenticated HTTP. **The big one.** |
| 2 | **Per-app approval** (`clients.ts`) | Uses `ps` + `.app` bundles + `codesign` | Can't identify which app connected |
| 3 | **Master key store** (`keystore.ts`) | `unsupported()` on win32 | Local secrets, saved sign-ins, sealed config are memory-only; lost on restart |
| 4 | **Stopping servers / leftovers** (`children.ts`) | `processes()` returns empty on Windows; SDK `kill()` only ends the root (`npx.cmd` → `cmd.exe` → `node` leaves orphans) | Orphaned MCP servers on stop/restart/crash |
| 5 | Atomic file writes | `writeFileSync(tmp)` + `renameSync` in store, apps, local-secrets, signins, install | Rename can fail with EPERM/EBUSY (AV, readers) → corrupted/failed saves |
| 6 | `revealInFileManager` | `explorer /select,path` via spawn | Node's quoting breaks it for paths with spaces |
| 7 | Save As dialog (`pickSavePath`) | macOS only | Falls back to browser download (works, but less native) |
| 8 | Notifications standalone | none on win32 | Only matters when daemon runs without the desktop app (the app handles it itself) |
| 9 | Automation page (AppleScript) | macOS only | No Windows equivalent needed (see below) |
| 10 | Installers/CI | macOS runners only; `collect-dist`/release notes mac-only | No Windows build published |
| 11 | Tests | Many `skipIf(win32)`, shebang fake `op`, POSIX mode asserts | Windows CI would fail |
| 12 | UI copy | "Show in Finder", mac-only wording | Wrong labels on Windows |
| 13 | Imports | `cmd /c npx …` entries, MSIX Claude Desktop config path | Some existing configs not detected/understood |

## Features that can't work as-is, and the closest Windows alternative

| macOS feature | Windows alternative |
|---|---|
| Unix socket `hub.sock` (0600) | **Named pipe** `\\.\pipe\mcp-hub-<random>`. Node's `http` supports it with the same `listen(path)` / `{socketPath}` API, so the proxy code is unchanged. The unguessable name is stored in `runtime.json` (in the user-only profile dir). Remote (SMB) clients are rejected by libuv's `PIPE_REJECT_REMOTE_CLIENTS`; to be verified in the smoke test. |
| `ps` ancestry walk | **One CIM snapshot** (`Get-CimInstance Win32_Process` via PowerShell, JSON): pid, ppid, creation time, exe path, command line. Cached briefly. `wmic` is removed in Win11 24H2, so not used. |
| `.app` bundle = app identity | Executable path, collapsed to the **install folder** (strip version segments like `app-1.2.3`, MSIX `Claude_1.2.3.0_x64__hash`) so all Electron helpers and updates share one identity. |
| `codesign` signer check (remembered-app tamper check) | **Authenticode** (`Get-AuthenticodeSignature`) subject/thumbprint; unsigned = "" exactly like macOS ad hoc. |
| Keychain master key | **Credential Manager** (`CredWrite`/`CredRead`, persist = local machine) with a **DPAPI** file (`ProtectedData`, CurrentUser) fallback. |
| SIGTERM / process groups | stdin-close (already used) + **`taskkill /T /F`** on a descendants list captured while the parent is alive. Desktop app job object already covers GUI death. |
| `open -R` | `explorer.exe` with verbatim `/select,"path"`. |
| `osascript` Save dialog | PowerShell `SaveFileDialog` (STA) – same "path passed as argument" rule. |
| AppleScript Automation (TCC prompts for Outlook/Mail…) | **Not needed**: Windows has no per-app permission gate for COM automation, so a server driving Outlook through COM just works (exception: Outlook elevated vs. hub not). Hide the Automation section on Windows. |
| Login-shell env (`loadShellEnv`) | Windows GUI apps inherit the user env; add a **registry refresh** (HKCU/HKLM `Environment` Path) so a PATH change after login (new node/uv install) is seen without logging out. |

Known limits to document, same as macOS: the approval uses the PID the bridge reports about itself (not a kernel peer check). Node has no `GetNamedPipeClientProcessId`, so no stronger option without a native helper.

## Todos

Step 0 (first thing after approval): copy this plan verbatim to `WINDOWS-TODO.md` in the repo root (name chosen to sit beside `ARCHITECTURE.md`; `*.md` is already ignored by the release workflow). Do not commit it unless asked. After that, this repo file is the source of truth and is updated as items finish.

Status: `[ ]` open, `[x]` done. Dependencies are in "Order / dependencies" below.

### A. Core platform layer (`packages/core`)
- [ ] 1. **win-process-table** – new `proc.ts`: `snapshot()` (ps on unix, CIM on Windows), cached ~2 s; used by `children.ts` and `clients.ts`. Make `descendantsOf`/`sweep` async (no blocking `execFileSync` on Windows). Add `taskkill /T /F` path in `stopLeftovers`; call it from `upstream.ts` stop (descendants captured before the SDK closes).
- [ ] 2. **win-named-pipe** – `paths.socketPath()` returns the pipe name on win32 (random per run, persisted in `runtime.json`); `hub.ts listenSocket` enables win32, skips `chmod`/`rm`, handles pipe cleanup; shim `discover()` verifies liveness with `/health` instead of `existsSync` (stale pipe names, and `existsSync` on a pipe is unreliable); `runtime.json.socket` keeps working.
- [ ] 3. **win-client-identity** – `clients.ts`: normalise `exeName` (`.exe/.cmd/.bat`), add Windows wrappers (`cmd`, `powershell`, `pwsh`, `conhost`, `openconsole`, `windowsterminal`, `npx.cmd`…) and runtimes; install-folder identity; Authenticode signer lookup; Windows `pidAlive` check fine as is. Fake-lookup unit tests for the Windows shapes (Electron app, Claude Code via node, terminal → pwsh → node).
- [ ] 4. **win-keystore** – `keystore.ts`: `windowsCredentialManager()` (shares the P/Invoke script with `keychain.ts`; key passed on stdin/env, never on a command line) and `windowsDpapi()` fallback (file `master-key.dpapi` in the data dir). Use `-EncodedCommand` (UTF-16LE base64) instead of a quoted multi-line `-Command` to avoid quoting bugs; clear error when Constrained Language Mode blocks `Add-Type`. `keychain://` read: also handle UTF-8 blobs (not only UTF-16) and the `account` part.
- [ ] 5. **win-atomic-write** – one shared `atomicWrite()` (tmp + rename with short EPERM/EBUSY/EACCES retry); use in `store`, `app-store`, `local-secrets`, `signins`, `install`, config export. POSIX modes remain best effort on Windows (profile ACLs already restrict `%APPDATA%`; no icacls hardening planned).
- [ ] 6. **win-system-utils** – `system.ts`: verbatim-argument `explorer /select`, PowerShell save dialog, optional toast fallback for standalone runs, registry PATH refresh, normalise env key case (`Path` vs `PATH`) before merging `baseEnv`, handle `SIGBREAK`.
- [ ] 7. **win-import** – `import.ts`: unwrap `cmd /c npx …` (and `cmd /c npx mcp-remote …`) entries; Claude Desktop **MSIX** config path (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\…`, verify on a real install); `pointsAtHub` also matches backslash dev paths; confirm TOML (Codex) escaping of backslash paths and `bridgeEntry` JSON paths with spaces.

### B. UI
- [ ] 8. **win-ui-copy** – platform-aware labels from `snap.platform`: "Show in Finder" → "Show in Explorer"/"file manager" (`ui.tsx`, `ConfigTransfer.tsx`), hide the Automation section off macOS, keychain blurb/help, Settings text. Keep the PathLink rule.

### C. Desktop app and build
- [ ] 9. **win-tauri** – `lib.rs`: Windows "packaged" detection (not `.app/Contents/`), WebView2 install mode (bootstrapper/embed), per-user NSIS (`bundle.windows.nsis.installMode = currentUser`), tray behaviour check, autostart; sidecars `.exe`; verify `daemon.rs` stop path (stdin close, then `taskkill /T`).
- [ ] 10. **win-sidecars** – `build-sidecars.mjs`: Windows SEA (postject, remove existing signature before inject with `signtool remove` if present, smoke test), per-arch triples (`x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`); `collect-dist.mjs` already copies `.exe`.
- [ ] 11. **win-release-ci** – `release.yml`: add `windows-latest` (x64) and `windows-11-arm` (ARM64) to the build matrix, Windows install note in the release body, optional Authenticode signing step (secrets, off by default, SmartScreen warning documented); add a **PR/push test job on windows-latest** (typecheck + `npm test`).

### D. Tests and docs
- [ ] 12. **win-tests** – un-skip or port Windows-skipped suites: fake `op`/`vault` as `.cmd`, mode assertions guarded, `children` test via Windows process table, local-socket suite runs against a named pipe, `clients` tests for Windows lookup. New smoke test: start the daemon, connect with the shim over the pipe, approve, call a mock server.
- [ ] 13. **win-docs** – update `ARCHITECTURE.md` (§3, §4 `children.ts`/`clients.ts`/`system.ts`, §4.2 keychain/master key, §8.1 socket, §12/§13 platform status), `README.md`, `apps/desktop/README.md`.

## Order / dependencies
`win-process-table` → `win-client-identity`, and → part of `win-named-pipe` (approval needs identity). `win-keystore`, `win-atomic-write`, `win-system-utils`, `win-import`, `win-ui-copy` are independent. `win-tauri` → `win-sidecars` → `win-release-ci`. `win-tests` after the core work; `win-docs` last.

## Risks / things only a real Windows machine can confirm
- Named pipe default DACL and `PIPE_REJECT_REMOTE_CLIENTS` behaviour; shim connect latency.
- PowerShell cold-start cost (0.5–1.5 s) on each keychain read / process snapshot: mitigated by caching, never on the hot request path after approval.
- Antivirus / SmartScreen reactions to Node SEA `.exe`s and an unsigned installer.
- Windows reserved/excluded TCP ports (Hyper-V/WSL) can block 47615: the random-port fallback already exists; the shim re-discovers via `runtime.json`.
- Constrained Language Mode / AppLocker blocking `Add-Type` (hence the DPAPI fallback).
- MSIX Claude Desktop path and whether other apps virtualise `%APPDATA%`.
- Dev (`npm run dev`) on Windows: `tsx.cmd` path in `lib.rs` and `scripts/dev.mjs`.

## Findings log (fill in while working; keep it short)
- (needs Windows) Named pipe: default DACL / remote-client rejection result:
- (needs Windows) PowerShell cold-start timings (CIM snapshot, CredRead):
- (needs Windows) Claude Desktop MSIX vs. classic install config path:
- (needs Windows) Antivirus / SmartScreen behaviour for the SEA `.exe`s and installer:
- (needs Windows) `npm run dev` on Windows (`tsx.cmd`, `scripts/dev.mjs`):

## Out of scope
Linux; signing certificates (hook only); auto-update; native (Rust/N-API) helper for kernel peer-PID checks.
