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

1. **[Download the latest release](https://github.com/markhicken/mcp-hub/releases/latest)**, open the `.dmg` for your Mac (`aarch64` is Apple silicon, `x64` is Intel) and drag MCP Hub to Applications.
2. Builds aren't notarized yet, so the first time macOS says it can't verify the app: open **System Settings → Privacy & Security** and choose **Open Anyway** (or run `xattr -cr "/Applications/MCP Hub.app"`). You can check a download against `SHA256SUMS.txt` on the release page.
3. Follow the welcome tour: save your recovery key, then scan your apps to import their servers or install MCP Hub into them.

## Platform support

**macOS only for now.** Windows and Linux are not finished: parts of the code exist but are untested, and no installers are published for them. You can [run it from source](#run-from-source) on them at your own risk.

## Run from source

```bash
npm install
npm run dev     # daemon + UI with hot reload; open http://localhost:5173/?token=devtoken
npm test
```

## Build a debug app

Builds the macOS `.app` faster than a release build, with no installer. You need Node 24, npm and a Rust toolchain ([`rustup`](https://rustup.rs)).

```bash
npm install
npm run build:app:debug
```

The finished app is copied into `dist/` (git-ignored). If you rebuild often on a Mac, run `npm run setup:signing` once: it makes a local signing certificate so macOS keeps your approvals (such as 1Password access) across rebuilds instead of asking again. For release builds and signing, see [`apps/desktop/README.md`](apps/desktop/README.md).

## Learn more

Everything else lives in [`ARCHITECTURE.md`](ARCHITECTURE.md): the detailed feature reference, how the proxy and credential broker work, the security model, the API, testing, releasing and known limitations. For the desktop app and installers, see [`apps/desktop/README.md`](apps/desktop/README.md).
