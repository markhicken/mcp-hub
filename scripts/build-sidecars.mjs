#!/usr/bin/env node
// Builds the two Tauri sidecars as Node Single Executable Applications (SEA):
//   mcp-hub-core   <- packages/core/src/cli.ts       (the daemon)
//   mcp-hub-stdio  <- packages/shim/src/shim.mjs     (the stdio shim MCP clients launch)
// Output: apps/desktop/src-tauri/binaries/<name>-<rust target triple>[.exe]
//
// Usage: node scripts/build-sidecars.mjs [--only core|shim] [--shim <file>]
// The sidecars embed the Node that runs this script, so they are built for the host platform only.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const binDir = join(desktop, "src-tauri/binaries");
const work = join(desktop, ".sidecar-build");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const only = opt("only");
if (only && !["core", "shim"].includes(only)) fail(`--only must be "core" or "shim"`);

function fail(msg) {
  console.error(`build-sidecars: ${msg}`);
  process.exit(1);
}

function load(fromPackageJson, name, hint) {
  try {
    return createRequire(fromPackageJson)(name);
  } catch {
    fail(`cannot load "${name}" (${hint}). Run \`npm install\` first.`);
  }
}

const esbuild = load(join(root, "packages/core/package.json"), "esbuild", "devDependency of @mcp-hub/core");
const { inject } = load(join(desktop, "package.json"), "postject", "devDependency of @mcp-hub/desktop");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const ext = isWin ? ".exe" : "";

/** The Rust target triple Tauri names sidecars by. Normally `rustc` says; without it, the usual one for this system. */
function hostTriple() {
  try {
    const t = /^host:\s*(\S+)/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
    if (t) return t;
  } catch {
    // no Rust toolchain: fall through
  }
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) return undefined;
  if (isWin) return `${arch}-pc-windows-msvc`;
  if (isMac) return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}
const triple = hostTriple();
if (!triple) fail("could not determine the Rust host target triple (install Rust, or build on x64/arm64)");

// Fixed sentinel defined by Node's SEA implementation.
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    // SEA runs a CommonJS script; `import.meta.url` is emulated from __filename.
    format: "cjs",
    define: { "import.meta.url": "__importMetaUrl" },
    banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    legalComments: "none",
    logLevel: "warning",
    // jsonc-parser's default (UMD) entry loads its own files with a dynamic require that can't be bundled.
    alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  });
}

/** Run the finished executable once, the way the app will, so a broken bundle fails the build instead of the user. */
// Slow CI machines (Windows on ARM) need longer than a desktop, and a start that is only slow should not fail the build.
const STARTUP_LIMIT_MS = 90_000;

function smokeTest(name, exe) {
  return new Promise((done, reject) => {
    const home = mkdtempSync(join(tmpdir(), "mcp-hub-smoke-"));
    const child = spawn(exe, name === "mcp-hub-core" ? ["--exit-on-stdin-close"] : [], {
      // The key store is kept in memory so this check never reads or writes the machine's real keychain / Credential Manager.
      env: { ...process.env, MCP_HUB_HOME: home, MCP_HUB_PORT: "0", MCP_HUB_TOKEN: "smoke", MCP_HUB_KEYSTORE: "memory", MCP_HUB_TRACE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      // Windows keeps a killed program's files locked for a moment (its database), so wait for it to exit and retry;
      // a leftover temp folder must never fail the build.
      const cleanup = () => {
        try {
          rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch {
          // left in the temp folder
        }
        error ? reject(error) : done();
      };
      if (child.exitCode !== null || child.signalCode !== null) cleanup();
      else child.once("exit", cleanup);
    };
    const timer = setTimeout(() => finish(new Error(`${name} did not start within ${STARTUP_LIMIT_MS / 1000}s.\n--- stderr (last steps shown by MCP_HUB_TRACE)\n${err}\n--- stdout\n${out}`)), STARTUP_LIMIT_MS);
    child.stdout.on("data", (d) => {
      out += d;
      if (name === "mcp-hub-core" && out.includes('"event":"ready"')) finish();
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (name === "mcp-hub-stdio" && err.includes("usage:")) finish();
    });
    child.on("exit", (code) => finish(new Error(`${name} exited early (code ${code}).\n${err}${out}`)));
  });
}

function buildSea(name, entry) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return (async () => {
    const script = join(dir, `${name}.cjs`);
    await bundle(entry, script);

    const blob = join(dir, `${name}.blob`);
    const config = join(dir, "sea-config.json");
    writeFileSync(
      config,
      JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2),
    );
    execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

    mkdirSync(binDir, { recursive: true });
    const out = join(binDir, `${name}-${triple}${ext}`);
    rmSync(out, { force: true });
    copyFileSync(process.execPath, out);
    if (!isWin) chmodSync(out, 0o755);
    // The copied node binary is signed; injecting invalidates that signature.
    if (isMac) execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });
    if (isWin) {
      // Best effort: signtool ships with the Windows SDK. Without it the executable keeps node.exe's (then invalid) signature,
      // which still runs, but some antivirus tools dislike it.
      try {
        execFileSync("signtool", ["remove", "/s", out], { stdio: "ignore" });
      } catch {
        console.warn("signtool not found: the Node signature was left on the sidecar");
      }
    }

    await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
      sentinelFuse: SEA_FUSE,
      ...(isMac ? { machoSegmentName: "NODE_SEA" } : {}),
    });
    // Apple Silicon refuses unsigned binaries; Tauri re-signs with the real identity when bundling.
    if (isMac) execFileSync("codesign", ["-s", "-", out], { stdio: "inherit" });

    console.log(`built ${out} (${(statSync(out).size / 1e6).toFixed(0)} MB)`);
    await smokeTest(name, out);
    console.log(`${name} starts correctly`);
  })();
}

const coreEntry = join(root, "packages/core/src/cli.ts");
const shimEntry = resolve(opt("shim") ?? join(root, "packages/shim/src/shim.mjs"));

if (only !== "shim") {
  if (!existsSync(coreEntry)) fail(`missing ${coreEntry}`);
  await buildSea("mcp-hub-core", coreEntry);
}
if (only !== "core") {
  if (!existsSync(shimEntry)) fail(`missing ${shimEntry} (pass --shim <file> to use another entry)`);
  await buildSea("mcp-hub-stdio", shimEntry);
}
rmSync(work, { recursive: true, force: true });
