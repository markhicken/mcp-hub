// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mcp_hub_desktop_lib::run(tauri::generate_context!());
}
