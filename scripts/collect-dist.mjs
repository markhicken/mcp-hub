// Copies the finished desktop artifacts out of Tauri's deeply nested target dir into ./dist.
//   node scripts/collect-dist.mjs            release build
//   node scripts/collect-dist.mjs --debug    debug build
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const bundle = join(root, "apps/desktop/src-tauri/target", profile, "bundle");
const out = join(root, "dist");

const artifacts = [
  ["macos", ".app"],
  ["dmg", ".dmg"],
  ["msi", ".msi"],
  ["nsis", ".exe"],
  ["deb", ".deb"],
  ["appimage", ".AppImage"],
];

// Finder or Spotlight can add a file (.DS_Store) mid-delete, which fails with ENOTEMPTY; retry.
rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(out, { recursive: true });

const copied = [];
for (const [dir, ext] of artifacts) {
  const from = join(bundle, dir);
  if (!existsSync(from)) continue;
  for (const name of readdirSync(from).filter((n) => n.endsWith(ext))) {
    const dest = join(out, name);
    // ditto keeps macOS code signatures, symlinks and extended attributes intact.
    if (process.platform === "darwin") execFileSync("ditto", [join(from, name), dest]);
    else cpSync(join(from, name), dest, { recursive: true, verbatimSymlinks: true });
    copied.push(name);
  }
}

if (!copied.length) {
  console.error(`No ${profile} bundles found in ${bundle}. Run the desktop build first.`);
  process.exit(1);
}
console.log(`dist/ (${profile}):\n${copied.map((n) => `  ${n}`).join("\n")}`);
