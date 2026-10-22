// Builds the desktop app in debug mode with the bundle type that exists on this system, then gathers it into dist/.
//   node scripts/build-app-debug.mjs
// macOS makes just the .app (fast, no .dmg); Windows makes the NSIS installer (there is no bare-app bundle there).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.platform === "darwin" ? "app" : process.platform === "win32" ? "nsis" : "deb";
const shell = process.platform === "win32";

const steps = [
  ["npm", ["run", "build", "-w", "@mcp-hub/ui"]],
  ["npm", ["run", "build:sidecars"]],
  [process.execPath, ["scripts/with-signing.mjs", "npm", "run", "build", "-w", "@mcp-hub/desktop", "--", "--debug", "--bundles", bundle]],
  [process.execPath, ["scripts/collect-dist.mjs", "--debug"]],
];

for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: shell && cmd === "npm" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
