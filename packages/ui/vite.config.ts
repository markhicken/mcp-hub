import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: run the daemon with MCP_HUB_DEV_ORIGIN=http://localhost:5173 so its Origin check allows this server.
const target = process.env.MCP_HUB_TARGET ?? "http://127.0.0.1:47615";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/mcp", "/health", "/oauth"].map((p) => [p, { target, changeOrigin: true }])),
  },
  build: { outDir: "dist", sourcemap: false },
});
