#!/usr/bin/env node
// Runs the test suite on a Windows PC over SSH, from your Mac, without committing or pushing anything.
//
//   npm run test:windows -- --host user@192.168.1.50    first run: remembers the host
//   npm run test:windows                                later runs: uses the remembered host
//   npm run test:windows -- clients windows             only test files matching these names (core package)
//   npm run test:windows -- --dry-run                   pack the working tree and show the plan; no connection
//
// `--host` takes `user@address` (a bare address works too: ssh then uses your Mac user name, which is rarely right on
// Windows). A positional argument that looks like `user@host` or an IPv4 address is treated as the host as well.
// The host is saved in `.windows-test-host` at the repo root (gitignored) after the first successful connection;
// giving `--host` again replaces it.
//
// What it does: packs the working tree (tracked and untracked files that aren't gitignored, so uncommitted changes
// are tested), copies it to %USERPROFILE%\mcp-hub-test on the PC, runs `npm ci` and the tests there, streams the
// output, and exits with the test result.
//
// One-time setup on the Windows PC:
//   - Install the OpenSSH Server (Settings > System > Optional features) and start it:
//       Start-Service sshd; Set-Service sshd -StartupType Automatic
//   - Node.js 24 or newer: on the machine PATH, or installed with nvm for Windows (the script finds it through
//     NVM_HOME / NVM_SYMLINK, even though an SSH session doesn't carry an interactive session's PATH).
//   - Optional: put your Mac's public key in the PC so no password is asked (for an administrator account the file is
//     C:\ProgramData\ssh\administrators_authorized_keys). Without it ssh asks for the password once per run.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAVED = join(root, ".windows-test-host");
const REMOTE_DIR = "mcp-hub-test"; // relative to the account's home folder, on the PC

class Failure extends Error {}

// Throws rather than exiting, so the cleanup in `finally` always runs.
function fail(msg) {
  throw new Failure(msg);
}

const log = (msg) => console.log(`\n==> ${msg}`);

const HOST_RE = /^(?:[\w.-]+@)?[\w.:-]+$/;
const LOOKS_LIKE_HOST = /^(?:[\w.-]+@[\w.:-]+|\d{1,3}(?:\.\d{1,3}){3})$/;

function parseArgs(argv) {
  const out = { host: "", filters: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--host") out.host = argv[++i] ?? fail("--host needs a value, like user@192.168.1.50");
    else if (a.startsWith("--host=")) out.host = a.slice(7);
    else if (a.startsWith("-")) fail(`unknown option ${a}`);
    else if (!out.host && LOOKS_LIKE_HOST.test(a)) out.host = a;
    else out.filters.push(a);
  }
  if (out.host && (out.host.startsWith("-") || !HOST_RE.test(out.host))) fail(`"${out.host}" isn't a valid host (use user@address)`);
  for (const f of out.filters) if (!/^[\w@./\\*?-]+$/.test(f)) fail(`"${f}" isn't a plain test file name or pattern`);
  return out;
}

function savedHost() {
  try {
    const { host } = JSON.parse(readFileSync(SAVED, "utf8"));
    return typeof host === "string" && HOST_RE.test(host) && !host.startsWith("-") ? host : "";
  } catch {
    return "";
  }
}

/** The files to test: everything git tracks or would track (not ignored) that exists, so uncommitted work is included. */
function sourceFiles() {
  const out = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) fail("git ls-files failed");
  return out.stdout.split("\0").filter((f) => {
    if (!f) return false;
    try {
      lstatSync(join(root, f));
      return true;
    } catch {
      return false; // deleted but not committed yet
    }
  });
}

function buildArchive(dir) {
  const files = sourceFiles();
  const list = join(dir, "files.txt");
  writeFileSync(list, files.join("\n") + "\n");
  const archive = join(dir, "repo.tgz");
  const r = spawnSync("tar", ["-czf", archive, "-C", root, "-T", list], { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" });
  if (r.status !== 0) fail(`tar failed: ${r.stderr}`);
  return { archive, count: files.length, mb: (statSync(archive).size / 1048576).toFixed(1) };
}

/** PowerShell run on the PC from a copied file (`run.ps1`), so it works whether the account's SSH shell is cmd or PowerShell. */
const remoteScript = (testCommand, preInstallCommand) => `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Set-Location $HOME\\${REMOTE_DIR}
# An SSH session may not carry the PATH of an interactive one, and nvm for Windows keeps Node in its own folder, so
# rebuild PATH from the registry and then look for Node 24+ in the usual nvm places.
foreach ($n in 'NVM_HOME', 'NVM_SYMLINK') {
  if (-not (Get-Item "env:$n" -ErrorAction SilentlyContinue)) {
    $v = [Environment]::GetEnvironmentVariable($n, 'User')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine') }
    if ($v) { Set-Item "env:$n" $v }
  }
}
$env:Path = [Environment]::ExpandEnvironmentVariables((@($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';')
function Get-NodeMajor($dir) { try { [int](& (Join-Path $dir 'node.exe') -p "process.versions.node.split('.')[0]") } catch { 0 } }
$found = Get-Command node -ErrorAction SilentlyContinue
$major = 0
if ($found) { $major = Get-NodeMajor (Split-Path $found.Source) }
if ($major -lt 24) {
  $dirs = @($env:NVM_SYMLINK, "$env:ProgramFiles\\nodejs", 'C:\\nvm4w\\nodejs')
  if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) { $dirs += Get-ChildItem $env:NVM_HOME -Directory -Filter 'v*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName } }
  foreach ($d in $dirs) {
    if ($d -and (Test-Path (Join-Path $d 'node.exe'))) {
      $m = Get-NodeMajor $d
      if ($m -ge 24) { $env:Path = "$d;$env:Path"; $major = $m; Write-Output "Using Node from $d"; break }
    }
  }
}
if ($major -lt 24) {
  Write-Output 'Node 24 or newer was not found on the PC (in this SSH session).'
  Write-Output "  node on PATH: $(if ($found) { $found.Source + ' (v' + $major + ')' } else { 'none' })"
  Write-Output "  NVM_HOME=$env:NVM_HOME  NVM_SYMLINK=$env:NVM_SYMLINK"
  Write-Output '  Install Node 24+ (nvm install 24, or winget install OpenJS.NodeJS).'
  exit 90
}
Write-Output "Windows $([Environment]::OSVersion.Version), node $(node -v), npm $(npm -v), $env:PROCESSOR_ARCHITECTURE"
if (Test-Path src) { cmd /c "rmdir /s /q src" }
New-Item -ItemType Directory src | Out-Null
tar -xzf repo.tgz -C src
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Set-Location src
$env:CI = 'true'
${preInstallCommand}
npm ci
if ($LASTEXITCODE) { Write-Output 'npm ci failed'; exit $LASTEXITCODE }
${testCommand}
exit $LASTEXITCODE
`;

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

const prepareScript = `New-Item -ItemType Directory -Force -Path $HOME\\${REMOTE_DIR} | Out-Null`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A full run mirrors CI (version check, install, typecheck, tests); filtered runs skip the checks to stay quick.
  const preInstallCommand = args.filters.length
    ? ""
    : "node scripts/version.mjs check\nif ($LASTEXITCODE) { Write-Output 'version check failed'; exit $LASTEXITCODE }";
  const testCommand = args.filters.length
    ? `npm test -w @mcp-hub/core -- ${args.filters.join(" ")}`
    : "npm run typecheck; if ($LASTEXITCODE) { Write-Output 'typecheck failed'; exit $LASTEXITCODE }; npm test";

  const remembered = savedHost();
  const host = args.host || remembered;
  if (!host && !args.dryRun) fail("No Windows host yet. Run once with --host user@address (for example: npm run test:windows -- --host me@192.168.1.50).");
  if (host && !args.host) console.log(`Using the saved Windows host ${host} (--host replaces it)`);

  log("Packing the working tree");
  const pack = buildArchive(tmp);
  console.log(`${pack.count} files, ${pack.mb} MB`);
  if (args.dryRun) {
    console.log(`\nDry run. On ${host || "the Windows host"} it would run: npm ci, then ${testCommand}\nNo connection was made.`);
    code = 0;
    return;
  }

  // One connection is opened and shared by every ssh/scp call below, so a password (if any) is asked for once.
  const control = join(tmp, "c");
  const sshOpts = ["-o", `ControlPath=${control}`, "-o", "ControlMaster=auto", "-o", "ControlPersist=300", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"];
  const ssh = (remoteArgs, stdio = "inherit") => spawnSync("ssh", [...sshOpts, host, ...remoteArgs], { stdio });
  const powershell = (script) => ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(script)];

  log(`Connecting to ${host}`);
  const prep = ssh(powershell(prepareScript));
  if (prep.status !== 0) {
    fail(`could not connect to ${host} (ssh exit ${prep.status}). Check that the OpenSSH Server is running on the PC, the address and user name, and that the PowerShell is available.`);
  }
  closeSsh = () => spawnSync("ssh", [...sshOpts, "-O", "exit", host], { stdio: "ignore" });
  if (host !== remembered) {
    writeFileSync(SAVED, JSON.stringify({ host }) + "\n");
    console.log(`Saved ${host} in .windows-test-host (gitignored) for next time`);
  }

  log("Copying the code to the PC");
  // The run script goes over as a file: it is too long for the command line a cmd.exe SSH shell allows.
  writeFileSync(join(tmp, "run.ps1"), remoteScript(testCommand, preInstallCommand));
  const copy = spawnSync("scp", [...sshOpts, "-q", join(tmp, "repo.tgz"), join(tmp, "run.ps1"), `${host}:${REMOTE_DIR}/`], { stdio: "inherit" });
  if (copy.status !== 0) fail("copying the code to the PC failed.");

  log(`Running on ${host}: npm ci, then ${testCommand}`);
  const run = ssh(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${REMOTE_DIR}/run.ps1`]);
  code = run.status ?? 1;
  log(code === 0 ? "Windows tests passed" : `Windows tests failed (exit code ${code})`);
}

const tmp = mkdtempSync(join(tmpdir(), "mcp-hub-win-"));
let closeSsh = () => {};
let code = 1;

try {
  await main();
} catch (err) {
  if (!(err instanceof Failure)) throw err;
  console.error(`\ntest-windows: ${err.message}`);
  code = 2;
} finally {
  closeSsh();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
