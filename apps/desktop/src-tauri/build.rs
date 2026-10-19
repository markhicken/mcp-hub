use std::{env, fs, path::Path};

const SIDECARS: [&str; 2] = ["mcp-hub-core", "mcp-hub-stdio"];

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
    let manifest = Path::new(&manifest);
    let release = env::var("PROFILE").map(|p| p == "release").unwrap_or(false);

    prepare_sidecar_placeholders(manifest, release);
    stage_ui(manifest, release);

    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build();
}

/// `tauri-build` fails when an externalBin file is missing. Debug builds run the daemon through tsx
/// and never execute these, so an empty stand-in keeps `cargo check` / `tauri dev` working.
/// Release builds must have the real thing (`npm run build:sidecars`).
fn prepare_sidecar_placeholders(manifest: &Path, release: bool) {
    let triple = env::var("TARGET").unwrap();
    let ext = if triple.contains("windows") { ".exe" } else { "" };
    let dir = manifest.join("binaries");
    fs::create_dir_all(&dir).unwrap();
    println!("cargo:rerun-if-changed=binaries");

    for name in SIDECARS {
        let path = dir.join(format!("{name}-{triple}{ext}"));
        let empty = fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true);
        if !empty {
            continue;
        }
        if release {
            panic!(
                "missing sidecar {}. Run `npm run build:sidecars` from the repo root before a release build.",
                path.display()
            );
        }
        fs::write(&path, b"").unwrap();
    }
}

/// Copies packages/ui/dist into src-tauri/resources/ui so the bundler has a stable resource path
/// even when the UI has not been built yet (debug builds get a placeholder page).
fn stage_ui(manifest: &Path, release: bool) {
    let src = manifest.join("../../../packages/ui/dist");
    let dst = manifest.join("resources/ui");
    let _ = fs::remove_dir_all(&dst);
    fs::create_dir_all(&dst).unwrap();

    if src.join("index.html").exists() {
        println!("cargo:rerun-if-changed={}", src.display());
        copy_dir(&src, &dst);
    } else if release {
        panic!("packages/ui/dist is missing. Run `npm run build -w @mcp-hub/ui` first.");
    } else {
        println!("cargo:warning=packages/ui/dist not found; bundling a placeholder UI");
        fs::write(dst.join("index.html"), "<!doctype html><title>MCP Hub</title><p>UI not built.</p>").unwrap();
    }
}

fn copy_dir(from: &Path, to: &Path) {
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir_all(&target).unwrap();
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
