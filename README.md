# MCP Hub

**One home for every MCP server on your Mac.** Run your MCP servers once, keep their secrets encrypted, and let all your AI apps share them, with a live view of what each one is doing.

**[Download for macOS](https://github.com/markhicken/mcp-hub/releases/latest)** · [How it works](ARCHITECTURE.md)

![MCP Hub: servers](screenshots/MCP%20Hub%20-%20Servers.png)

![MCP Hub: usage dashboard](screenshots/MCP%20Hub%20-%20Usage.png)

## Why MCP Hub

- **Run each server once.** Claude, Copilot, Cursor and the rest all connect to the same running server instead of each starting their own copy.
- **Secrets stay private.** Your 1Password, Keychain, Vault and environment secrets are fetched when needed, kept encrypted, and never written to config files in readable form.
- **See what's happening.** Live status for every server, which apps are connected right now, a usage dashboard for data, requests, errors and speed, and a searchable History of every secret read, app let in and server started.
- **Set up in a few clicks.** Import the servers your apps already use, or add MCP Hub to an app's config for you. Every change is previewed and backed up first.
- **Switch sets of servers.** Label servers (work, personal…) and turn a group on or off, or switch to just that group, in one click.
- **Private by design.** Everything runs on your computer. No telemetry, and nothing leaves your machine except the MCP servers you configure.

## Works with

Claude Desktop · Claude Code · GitHub Copilot CLI · Cursor · VS Code · Augment (Auggie) · ChatGPT / Codex

Each app connects through a small bridge that MCP Hub adds to its config. The first time an app connects, MCP Hub asks you to allow it.

## Get started

1. **[Download the latest release](https://github.com/markhicken/mcp-hub/releases/latest)**. On a Mac, open the `.dmg` for your Mac (`aarch64` is Apple silicon, `x64` is Intel) and drag MCP Hub to Applications. On Windows, run the `-setup.exe` (`x64` for most PCs, `arm64` for ARM PCs); it installs for your user only.
2. Builds aren't signed yet. On macOS the first time says it can't verify the app: open **System Settings → Privacy & Security** and choose **Open Anyway** (or run `xattr -cr "/Applications/MCP Hub.app"`). On Windows, SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**. You can check a download against `SHA256SUMS.txt` on the release page.
3. Follow the welcome tour: save your recovery key, then scan your apps to import their servers or install MCP Hub into them.

## Platform support

**macOS and Windows are supported and tested** (CI runs the full test suite on both, and each release includes installers for both: macOS for Apple silicon and Intel, Windows for x64 and ARM64). Builds aren't code-signed yet, so macOS and SmartScreen warn on first run. Linux is not finished. You can [run it from source](#run-from-source) on any of them.

## Prerequisites

To install and use MCP Hub you need nothing else: download the installer from the [releases page](https://github.com/markhicken/mcp-hub/releases/latest). To run it from source or build it yourself:

| You need | For | Notes |
|---|---|---|
| **Node.js 24 or newer** (includes npm) | everything (`npm run dev`, `npm test`, builds) | Check with `node -v`. |
| **Rust** (1.86 or newer, via [`rustup`](https://rustup.rs)) | building the desktop app only (`npm run build:app`, `build:app:debug`) | Not needed to run from source or run the tests. |
| **A C/C++ build toolchain** | building the desktop app only | macOS: Xcode Command Line Tools (`xcode-select --install`). Windows: Visual Studio Build Tools with the "Desktop development with C++" workload. |

On Windows, one way to get all of it:

```powershell
winget install OpenJS.NodeJS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

After installing anything, **open a new terminal (and restart your editor)** so it picks up the new PATH; otherwise commands such as `cargo` are "not found". The rest of the Tauri requirements are listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run from source

```bash
npm install
npm run dev     # daemon + UI with hot reload; open http://localhost:5173/?token=devtoken
npm test
```

## Build a debug app

Builds the app faster than a release build (on macOS the `.app` only, no installer; on Windows the NSIS installer). It needs everything in [Prerequisites](#prerequisites), including Rust. On Windows, `npm run build:app` builds the release NSIS installer; the result ends up in `dist/`.

```bash
npm install
npm run build:app:debug
```

The finished app is copied into `dist/` (git-ignored). If you rebuild often on a Mac, run `npm run setup:signing` once: it makes a local signing certificate so macOS keeps your approvals (such as 1Password access) across rebuilds instead of asking again. For release builds and signing, see [`apps/desktop/README.md`](apps/desktop/README.md).

## Update the screenshots

`npm run screenshots` rebuilds the UI and retakes the two screenshots in `screenshots/` from made-up data (`scripts/screenshots/demo-data.ts`, nothing from your machine), framed in a macOS window. It needs a one-time `npx playwright install chromium`. Run it before a release, then commit the images.

## Learn more

Everything else lives in [`ARCHITECTURE.md`](ARCHITECTURE.md): the detailed feature reference, how the proxy and credential broker work, the security model, the API, testing, releasing and known limitations. For the desktop app and installers, see [`apps/desktop/README.md`](apps/desktop/README.md).
