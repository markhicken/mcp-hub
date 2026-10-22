// No console window on Windows, in any build. Debug builds still print to the terminal they were started from (below).
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    // A GUI program has no console of its own, so its logs would vanish. In debug builds, share the console of the
    // terminal that started it, if there is one; started from Explorer or the Start menu there is none and no window opens.
    #[cfg(all(windows, debug_assertions))]
    // SAFETY: plain Win32 call; it fails harmlessly when the parent has no console.
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
    mcp_hub_desktop_lib::run(tauri::generate_context!());
}
