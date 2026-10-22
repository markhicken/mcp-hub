# MCP Hub desktop (Tauri v2)

> **Status:** the macOS app and the Windows app (per-user NSIS installer, configured in `tauri.windows.conf.json`) are built, tested and released; the Linux notes below describe the intended setup but are not finished, and no Linux installers are published.

A tray / menu-bar app that owns the MCP Hub daemon. It spawns the daemon on launch, shows the
web UI (`packages/ui`, served by the daemon on `127.0.0.1`) in a window, and stops the daemon
when you quit.

- **Closing the window hides it** to the tray; the daemon keeps running. Only *Quit MCP Hub*
  (tray menu, Cmd/Ctrl+Q, or the OS) stops it.
- **Tray menu:** Open MCP Hub · `N servers connected` (polled every 5 s) · Forget all secrets ·
  Launch at login · Quit.
- **Launch at login** registers the app with `--hidden`, so it starts in the tray only.
- **Single instance:** a second launch just focuses the existing window. If a daemon started
  outside the app already owns the data dir, the app says so and exits.
- **Crash safety:** the daemon runs with `--exit-on-stdin-close` and the app keeps its stdin open,
  so the daemon dies with the GUI even if the GUI is killed. On quit it gets SIGTERM (Windows:
  stdin EOF), 3 s to exit, then a force kill of its process group. If the daemon dies on its own,
  a dialog offers *Restart* or *Quit*.
- **Notifications:** the daemon doesn't ask the OS itself when it runs under the app (`MCP_HUB_NOTIFY=stdout`). It prints a
  `{"event":"notify","title":…,"message":…}` line and the app shows it with `tauri-plugin-notification`, so the notification
  carries MCP Hub's icon and clicking it brings the app (and its window) forward. Run on its own, the daemon falls back to
  `osascript`, which macOS attributes to Script Editor. A `tauri dev` build is attributed to Terminal.
- **Navigation guard:** the webview may only show `http://127.0.0.1:<daemon port>`; every other
  `http(s)` link (and `target=_blank`) opens in the system browser.

## Prerequisites

Node 24, npm, a Rust toolchain (`rustup`), and the platform's Tauri
[prerequisites](https://v2.tauri.app/start/prerequisites/) (Xcode CLT on macOS; the Visual Studio Build Tools
"Desktop development with C++" workload, plus WebView2 (built into Windows 10/11), on
Windows; `webkit2gtk-4.1` and `libayatana-appindicator3` on Linux — the tray icon needs the latter). The root
[README](../../README.md#prerequisites) has the one-line install commands. Open a new terminal after installing Rust so `cargo` is on PATH.

Rust 1.86 is enough: `src-tauri/.cargo/config.toml` makes Cargo pick dependency versions that
support the declared `rust-version`. Delete that file when you move to Rust ≥ 1.90.

## Develop

```sh
npm install
npm run build -w @mcp-hub/ui               # the daemon serves packages/ui/dist
npm run dev -w @mcp-hub/desktop
```

Debug builds run from source (`tsx packages/core/src/cli.ts`) when started with `npm run dev -w
@mcp-hub/desktop`, or with `MCP_HUB_DEV_CORE=1`. A packaged `MCP Hub.app`, even a debug one, always
uses the bundled hub server, because an app launched from Finder has no `node` on its PATH. No sidecar build is needed for dev runs (empty placeholder sidecars are created
automatically so the Tauri build passes). The window is created in Rust and loads the daemon's
URL, so there is no frontend dev server. For UI hot reload run `npm run dev:ui` and open its URL in a
browser instead.

Set `MCP_HUB_HOME` / `MCP_HUB_PORT` to run an isolated instance next to your real one.

## Build installers

```sh
npm run build -w @mcp-hub/ui      # UI -> packages/ui/dist (copied into the app as resources/ui)
npm run build:sidecars            # daemon + shim single executables for this machine
npm run build -w @mcp-hub/desktop # tauri build
```

Or all three at once: `npm run build:app` (release) or `npm run build:app:debug` (faster, `.app` only). Both copy the finished app and installers into the top-level `dist/` folder (git-ignored); Tauri itself leaves them under `src-tauri/target/<profile>/bundle/`.

Output lands in `apps/desktop/src-tauri/target/release/bundle/` (`.app` + `.dmg` on macOS,
`.msi`/`.exe` on Windows, `.deb`/`.rpm`/`.AppImage` on Linux). Release builds fail with a clear
message if the sidecars or the UI are missing. Installers must be built on their own OS: the
sidecars embed the Node binary that built them.

### Sidecars (`scripts/build-sidecars.mjs`)

1. Bundles `packages/core/src/cli.ts` (and `packages/shim/src/shim.mjs`) with esbuild into one
   CommonJS file; `node:*` built-ins such as `node:sqlite` stay external. `import.meta.url` is
   emulated from `__filename`.
2. Builds a [Node Single Executable Application](https://nodejs.org/api/single-executable-applications.html):
   `node --experimental-sea-config`, copy `process.execPath`, inject the blob with `postject`.
   On macOS the copied binary's signature is removed and re-applied ad hoc (`codesign -s -`).
3. Writes `src-tauri/binaries/mcp-hub-core-<triple>` and `mcp-hub-stdio-<triple>` (triple from
   `rustc -vV`; `.exe` on Windows). Tauri bundles them next to the app binary under the plain name.

Options: `--only core|shim`, `--shim <file>` (alternative shim entry). Each sidecar is ~115 MB
because it contains a full Node runtime.

At runtime the app passes `MCP_HUB_UI_DIR` (bundled `ui/` resources) and `MCP_HUB_SHIM` (the
`mcp-hub-stdio` sidecar) to the daemon. The window's CSP is `null` on purpose: the page is served
by the local daemon (loopback only, bearer-token API, host/origin checks), the webview is pinned to
that origin and gets no Tauri IPC permissions (`capabilities/default.json`), so there is nothing a
CSP would additionally protect and the UI keeps full control of its own policy.

## Signing and notarization

Without a certificate, macOS builds are ad-hoc signed (`bundle.macOS.signingIdentity` is `"-"`): Apple
silicon refuses an app whose bundle isn't sealed, reporting it as "damaged". An ad-hoc build still
isn't trusted, so a downloaded copy needs **Open Anyway** in System Settings → Privacy & Security
(or `xattr -cr "/Applications/MCP Hub.app"`). `APPLE_SIGNING_IDENTITY` overrides the ad-hoc identity.
Distribution without that step needs a Developer ID certificate and notarization.

**Local builds keep a stable identity.** macOS ties what you've allowed an app to do (for example reading 1Password, or
"access data from other apps") to its code identity, and an ad-hoc signature changes with every rebuild, so the prompts
come back each time. `npm run build:app` signs through `scripts/with-signing.mjs`, which uses `APPLE_SIGNING_IDENTITY` if
set, otherwise the first Developer ID Application, Apple Development or "MCP Hub Local Signing" certificate in your
keychain, otherwise ad hoc (it says which). Run `npm run setup:signing` once to create the local certificate; it adds one
self-signed certificate to your login keychain and asks macOS to trust it for code signing. Delete "MCP Hub Local
Signing" in Keychain Access to undo it. After the first build with a new identity, approve the prompts once more.

- **macOS:** a Developer ID Application certificate and notarization. Set
  `APPLE_SIGNING_IDENTITY`, and either `APPLE_ID` + `APPLE_PASSWORD` (app-specific) +
  `APPLE_TEAM_ID`, or `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`, then run
  `tauri build`. Tauri signs the bundled sidecars with the same identity. Node SEA binaries need
  the hardened-runtime JIT entitlements: add `src-tauri/Entitlements.plist` with
  `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`
  and reference it from `bundle.macOS.entitlements`.
- **Windows:** an Authenticode certificate (`bundle.windows.certificateThumbprint` or
  `signCommand`) to avoid SmartScreen warnings. Sign the sidecar `.exe`s as well.
- **Linux:** no signing required; consider signing the AppImage/repo.

## Follow-ups

- Auto-update with `tauri-plugin-updater` (signed update manifest hosted with releases).
- Notifications (`tauri-plugin-notification`) for "service stopped" / "secrets forgotten".
- Universal macOS build (`--target universal-apple-darwin`) needs both arch sidecars; extend
  `build-sidecars.mjs` to build per target.
- CI matrix for Linux (macOS and Windows are in `.github/workflows/`; Linux support is not finished yet).
