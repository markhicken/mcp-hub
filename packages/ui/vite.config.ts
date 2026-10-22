import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// Dev: run the daemon with MCP_HUB_DEV_ORIGIN=http://localhost:5173 so its Origin check allows this server.
const target = process.env.MCP_HUB_TARGET ?? "http://127.0.0.1:47615";

// A checkout reached through a symlinked folder (as on some Windows setups) has its root at the link's path but its
// files at the real one, and Vite refuses to serve files outside its root: allow both.
const workspace = searchForWorkspaceRoot(process.cwd());
// Root at the real path too, so the build sees index.html under the same path as the root.
const root = realpathSync(process.cwd());

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    fs: { allow: [workspace, realpathSync(workspace)] },
    proxy: Object.fromEntries(["/api", "/mcp", "/health", "/oauth"].map((p) => [p, { target, changeOrigin: true }])),
  },
  build: { outDir: "dist", sourcemap: false },
});
