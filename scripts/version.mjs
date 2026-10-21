// Keeps the app's version in one step instead of eight files.
//   node scripts/version.mjs check [tag]   fail unless every file agrees (and matches `tag`, e.g. v1.2.3, if given)
//   node scripts/version.mjs set 1.2.3     write 1.2.3 into every file
//   node scripts/version.mjs bump patch    raise the current version (major, minor or patch) in every file
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [file, pattern that captures the version, replacement template]
const jsonVersion = [/("version":\s*")([^"]+)(")/, (v) => `$1${v}$3`];
const targets = [
  ["package.json", ...jsonVersion],
  ["packages/core/package.json", ...jsonVersion],
  ["packages/shim/package.json", ...jsonVersion],
  ["packages/ui/package.json", ...jsonVersion],
  ["apps/desktop/package.json", ...jsonVersion],
  ["apps/desktop/src-tauri/tauri.conf.json", ...jsonVersion],
  ["apps/desktop/src-tauri/Cargo.toml", /^(version\s*=\s*")([^"]+)(")/m, (v) => `$1${v}$3`],
  ["packages/core/src/version.ts", /(VERSION\s*=\s*")([^"]+)(")/, (v) => `$1${v}$3`],
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const read = (file) => readFileSync(join(root, file), "utf8");

function versions() {
  return targets.map(([file, re]) => {
    const m = re.exec(read(file));
    if (!m) throw new Error(`No version found in ${file}`);
    return { file, version: m[2] };
  });
}

/** package-lock.json repeats the version of the root package and of each workspace; keep them in step when it exists. */
function updateLockfile(version) {
  const file = join(root, "package-lock.json");
  if (!existsSync(file)) return false;
  const lock = JSON.parse(readFileSync(file, "utf8"));
  lock.version = version;
  const dirs = targets.map(([f]) => f).filter((f) => f.endsWith("/package.json")).map((f) => f.slice(0, -"/package.json".length));
  for (const key of ["", ...dirs]) if (lock.packages?.[key]) lock.packages[key].version = version;
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return true;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "check") {
  const found = versions();
  const wanted = arg ? arg.replace(/^v/, "") : found[0].version;
  if (!SEMVER.test(wanted)) {
    console.error(`"${arg}" isn't a version like v1.2.3`);
    process.exit(1);
  }
  const bad = found.filter((f) => f.version !== wanted);
  if (bad.length) {
    console.error(`Expected version ${wanted}${arg ? ` (from tag ${arg})` : ""}, but:\n${bad.map((b) => `  ${b.file} is ${b.version}`).join("\n")}\nRun: node scripts/version.mjs set ${wanted}`);
    process.exit(1);
  }
  console.log(`All ${found.length} files are at ${wanted}`);
} else if (cmd === "set" || cmd === "bump") {
  let next = (arg ?? "").replace(/^v/, "");
  if (cmd === "bump") {
    if (!["major", "minor", "patch"].includes(arg)) {
      console.error("Usage: node scripts/version.mjs bump major|minor|patch");
      process.exit(1);
    }
    const found = versions();
    const current = found[0].version;
    const disagree = found.filter((f) => f.version !== current);
    if (disagree.length) {
      console.error(`Files disagree about the current version:\n${disagree.map((b) => `  ${b.file} is ${b.version} (package.json is ${current})`).join("\n")}\nRun: node scripts/version.mjs set <version>`);
      process.exit(1);
    }
    // A pre-release suffix (1.2.3-beta.1) is dropped: the bump starts from the numbers.
    const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
    next = arg === "major" ? `${major + 1}.0.0` : arg === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  }
  if (!SEMVER.test(next)) {
    console.error("Usage: node scripts/version.mjs set 1.2.3");
    process.exit(1);
  }
  for (const [file, re, replace] of targets) {
    const text = read(file);
    if (!re.test(text)) throw new Error(`No version found in ${file}`);
    writeFileSync(join(root, file), text.replace(re, replace(next)));
  }
  const lock = updateLockfile(next);
  console.log(`Set ${targets.length} files${lock ? " and package-lock.json" : ""} to ${next}. Remember to commit and push to master; the release is tagged v${next} for you.`);
} else {
  console.error("Usage: node scripts/version.mjs check [tag] | set <version> | bump major|minor|patch");
  process.exit(1);
}
