// Runs a command (normally the Tauri build) with a stable code-signing identity, if this Mac has one.
//   node scripts/with-signing.mjs npm run build -w @mcp-hub/desktop
//
// macOS remembers what you allowed an app to do (reading 1Password, other apps' data, ...) against the app's
// code identity. An ad-hoc signature is a hash of the exact binary, so every rebuild looks like a new app and
// macOS asks again. A real certificate keeps the identity the same across rebuilds.
//
// The identity is APPLE_SIGNING_IDENTITY if it is already set (CI does this when the signing secrets exist),
// otherwise the first of: a Developer ID Application certificate, an Apple Development certificate, or the
// local one made by `npm run setup:signing`. With none of those the build is ad-hoc signed, as before.
import { execFileSync, spawnSync } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/with-signing.mjs <command> [args...]");
  process.exit(2);
}

const LOCAL_IDENTITY = "MCP Hub Local Signing";
const PREFERRED = ["Developer ID Application", "Apple Development", LOCAL_IDENTITY];

/** The SHA-1 of the best valid code-signing identity in the keychains, or null. */
function findIdentity(list) {
  const found = [...list.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1], name: m[2] }));
  for (const want of PREFERRED) {
    const hit = found.find((f) => f.name.startsWith(want));
    if (hit) return hit;
  }
  return null;
}

const env = { ...process.env };
let hint = "";
if (process.platform === "darwin" && !env.APPLE_SIGNING_IDENTITY) {
  let list = "";
  try {
    list = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  } catch {
    // no keychain tooling or no identities: fall through to ad-hoc
  }
  const id = findIdentity(list);
  if (id) {
    env.APPLE_SIGNING_IDENTITY = id.hash;
    console.log(`Signing with "${id.name}" (stable identity: macOS keeps your approvals across rebuilds).`);
  } else {
    hint = "Hint: this build is signed ad hoc, so macOS will ask for approvals (1Password and so on) again after every rebuild.\n      Run `npm run setup:signing` once to make a local signing certificate and stop that.";
    console.log(hint);
  }
} else if (env.APPLE_SIGNING_IDENTITY) {
  console.log("Signing with the identity in APPLE_SIGNING_IDENTITY.");
}

const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
// The build prints a lot; say it again at the end where it will be seen.
if (hint && r.status === 0) console.log(`\n${hint}`);
process.exit(r.status ?? 1);
