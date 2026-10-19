// Runs the core daemon and the UI dev server together (cross-platform env handling).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env.MCP_HUB_TOKEN || "devtoken";
const env = {
  ...process.env,
  MCP_HUB_TOKEN: token,
  MCP_HUB_DEV_ORIGIN: process.env.MCP_HUB_DEV_ORIGIN || "http://localhost:5173",
};

console.log(`\nOpen the UI: http://localhost:5173/?token=${token}\n`);

const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/concurrently/dist/bin/index.js", import.meta.url)),
    "--kill-others-on-fail",
    "--names", "core,ui",
    "--prefix-colors", "cyan,magenta",
    "npm run dev:core",
    "npm run dev:ui",
  ],
  { cwd: root, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
