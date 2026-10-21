# Instructions for AI agents

## Working rules

- **Never commit or push without explicit permission** from the user.
- Create and change files with the editor/file tools, not shell redirection, heredocs or `sed -i`.
- Use **npm** (not pnpm or yarn). Keep responses short.
- If the runtime's permission gate rejects a command with "Permission could not be granted automatically", retry the same call once; if it is still refused, use an equivalent route or tell the user. Deleting files may be blocked, in which case say which files are left for the user to delete.
- Check `git status` before a first commit, and commit `package-lock.json`.

## Browsers and test servers

- If you start a browser to test or build the UI (Playwright or any other), **close it when you are done**. Use the browser's close action, and don't leave a window or session open when you finish a task.
- Stop the dev servers and hubs you started for that testing (`npm run dev`, `dev:core`, `dev:ui`, a bundled hub server) before you finish. Use an isolated `MCP_HUB_HOME` and a spare `MCP_HUB_PORT` so a test hub never touches the user's real data.
- Delete what testing left in the repo: screenshots and the `.playwright-mcp/` folder.

## Architectural rules

- **Transparency: the user can always see when an app connects to a server and when a secret is requested.** Every secret read (including cache hits, preloads, retries and restarts) and every app connection is attributed to a server and a reason, recorded in History and announced by a notification (unless the user turned those off). Never read a secret or start a server on a path that skips this: pass a real trigger phrase to `connect(trigger)` / `broker.resolve(…, trigger)`. History must never store secret values, references, commands, arguments or raw error text. Details: `ARCHITECTURE.md` §4.5.
- **Every setting has a sane default** in `DEFAULT_SETTINGS`, and an invalid saved value falls back to it (`normalizeSettings`). A new setting needs a default, an entry in `SETTING_LIMITS` if numeric, and validation in `PUT /api/settings`.

## UI rules

- **Every path the UI shows is a link that opens it in the file manager.** Use `PathLink` (`packages/ui/src/ui.tsx`), never bare text: for an app's config file (`app`), a backup of it (`app` + `backup`), a connected app's program (`running`) or the file just exported (`exported`). The hub looks the file up itself, so don't send an arbitrary path to it; if a new kind of path needs a link, add a server-side lookup for it (see `/api/apps/reveal`, `/api/clients/:id/reveal`) that only accepts known locations. Don't put paths inside sentences as plain text either; show the link next to the text.
