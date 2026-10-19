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
