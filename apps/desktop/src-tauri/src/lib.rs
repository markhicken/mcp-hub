mod daemon;

use daemon::{Daemon, LaunchSpec, SpawnError, READY_TIMEOUT};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const POLL_EVERY: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);

struct AppState {
    daemon: Mutex<Option<Arc<Daemon>>>,
    quitting: AtomicBool,
    /// Only this loopback port may be shown in the window; follows the current daemon.
    allowed_port: AtomicU16,
    /// Cleared after the first start, or when the user asks for the window before it exists.
    start_hidden: AtomicBool,
    status_item: MenuItem<Wry>,
    autostart_item: CheckMenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

// ---------------------------------------------------------------------------------------------
// Daemon launch

fn launch_spec(app: &AppHandle) -> Result<LaunchSpec, String> {
    // A packaged .app (even a debug one) must use the bundled hub server: launched from Finder it has
    // no `node` on PATH, so the tsx dev path cannot work there.
    let packaged = std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/"));
    let dev = std::env::var("MCP_HUB_DEV_CORE").is_ok_and(|v| v == "1") || (cfg!(debug_assertions) && !packaged);
    if dev {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let root = root.canonicalize().unwrap_or(root);
        let tsx_name = if cfg!(windows) { "tsx.cmd" } else { "tsx" };
        let tsx = [root.join("node_modules/.bin"), root.join("packages/core/node_modules/.bin")]
            .into_iter()
            .map(|dir| dir.join(tsx_name))
            .find(|p| p.exists())
            .ok_or_else(|| format!("tsx was not found under {}. Run `npm install` first.", root.display()))?;
        return Ok(LaunchSpec {
            program: tsx,
            args: vec![root.join("packages/core/src/cli.ts").to_string_lossy().into_owned()],
            env: vec![
                ("MCP_HUB_UI_DIR".into(), root.join("packages/ui/dist").to_string_lossy().into_owned()),
                ("MCP_HUB_NOTIFY".into(), "stdout".into()),
            ],
            // The dev daemon locates packages/shim on its own.
            env_remove: vec!["MCP_HUB_SHIM".into()],
            cwd: Some(root),
            on_notify: None,
        });
    }

    // Tauri puts externalBin sidecars next to the main executable, without the target triple.
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("cannot locate the application: {e}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or("cannot locate the application directory")?;
    let exe = |name: &str| exe_dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });

    let core = exe("mcp-hub-core");
    if !core.exists() {
        return Err(format!("The bundled service {} is missing.", core.display()));
    }
    let ui = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot locate bundled resources: {e}"))?
        .join("ui");

    // The daemon hands its notifications to this app, which shows them as MCP Hub (its icon; a click brings it forward).
    let mut env = vec![
        ("MCP_HUB_UI_DIR".to_string(), ui.to_string_lossy().into_owned()),
        ("MCP_HUB_NOTIFY".to_string(), "stdout".to_string()),
    ];
    let shim = exe("mcp-hub-stdio");
    let mut env_remove = Vec::new();
    if shim.exists() {
        env.push(("MCP_HUB_SHIM".into(), shim.to_string_lossy().into_owned()));
    } else {
        env_remove.push("MCP_HUB_SHIM".to_string());
    }
    Ok(LaunchSpec { program: core, args: vec![], cwd: None, env, env_remove, on_notify: None })
}

/// Starts the daemon (retrying on request), shows the window and supervises the process.
/// Blocking; always run on a worker thread.
fn boot(app: AppHandle) {
    loop {
        if state(&app).quitting.load(Ordering::SeqCst) {
            return;
        }
        set_status(&app, "Starting…");
        let result = launch_spec(&app)
            .map_err(SpawnError::Failed)
            .map(|mut spec| {
                let handle = app.clone();
                spec.on_notify = Some(Arc::new(move |title, message| notify(&handle, title, message)));
                spec
            })
            .and_then(|spec| Daemon::spawn(&spec, READY_TIMEOUT));
        match result {
            Ok(d) => return on_started(&app, d),
            Err(SpawnError::AlreadyRunning(port)) => {
                let port = if port == 0 { String::new() } else { format!(" on port {port}") };
                inform(
                    &app,
                    "MCP Hub is already running",
                    &format!("Another MCP Hub is already running{port}. Quit it first, or use the one that is already open."),
                );
                return quit(&app);
            }
            Err(SpawnError::Failed(msg)) => {
                if !ask(&app, "MCP Hub could not start", &trim_for_dialog(&msg), "Retry", "Quit") {
                    return quit(&app);
                }
            }
        }
    }
}

fn on_started(app: &AppHandle, d: Arc<Daemon>) {
    let st = state(app);
    st.allowed_port.store(d.port, Ordering::SeqCst);
    *st.daemon.lock().unwrap() = Some(d.clone());
    set_status(app, "Connecting…");

    let hidden = st.start_hidden.swap(false, Ordering::SeqCst);
    if let Err(e) = show_window(app, &d.url, hidden) {
        inform(app, "MCP Hub could not open its window", &e.to_string());
    }
    thread::spawn({
        let app = app.clone();
        move || watch(app, d)
    });
}

/// Offers a restart when the daemon dies without us asking it to.
fn watch(app: AppHandle, d: Arc<Daemon>) {
    while !d.has_exited() {
        if d.is_stopping() || state(&app).quitting.load(Ordering::SeqCst) {
            return;
        }
        thread::sleep(Duration::from_millis(500));
    }
    if d.is_stopping() || state(&app).quitting.load(Ordering::SeqCst) {
        return;
    }
    {
        let st = state(&app);
        let mut slot = st.daemon.lock().unwrap();
        if slot.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &d)) {
            *slot = None;
        }
    }
    set_status(&app, "MCP Hub service stopped");
    let msg = format!("The MCP Hub background service stopped unexpectedly.\n\n{}", d.stderr_tail());
    if ask(&app, "MCP Hub service stopped", &trim_for_dialog(&msg), "Restart", "Quit") {
        boot(app);
    } else {
        quit(&app);
    }
}

fn stop_daemon(app: &AppHandle) {
    let d = state(app).daemon.lock().unwrap().take();
    if let Some(d) = d {
        d.stop();
    }
}

// ---------------------------------------------------------------------------------------------
// Window

fn show_window(app: &AppHandle, url: &str, hidden: bool) -> Result<(), Box<dyn std::error::Error>> {
    let url: Url = url.parse()?;
    if let Some(w) = app.get_webview_window(MAIN) {
        // Daemon restart: the port/token may have changed, keep the window's visibility as is.
        w.navigate(url)?;
        return Ok(());
    }

    let nav_app = app.clone();
    let popup_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("MCP Hub")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 520.0)
        .center()
        .background_color(Color(15, 17, 21, 255))
        .visible(!hidden)
        // The page does its own drag and drop (reordering cards). Tauri's native file-drop handler would swallow
        // those events on macOS and Windows, and nothing here takes dropped files.
        .disable_drag_drop_handler()
        .on_navigation(move |url| allow_navigation(&nav_app, url))
        // target=_blank / window.open: never a new in-app window, only the system browser.
        .on_new_window(move |url, _features| {
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    // The page sits on a #0f1115 background; keep the OS chrome dark as well.
    let _ = window.set_theme(Some(tauri::Theme::Dark));
    Ok(())
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// The webview may only stay on the daemon's own origin; web links go to the system browser.
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    let port = state(app).allowed_port.load(Ordering::SeqCst);
    let local = url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port);
    if local || url.as_str() == "about:blank" {
        return true;
    }
    open_external(app, url);
    false
}

fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    match app.get_webview_window(MAIN) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        // Still starting: show it as soon as it is created.
        None => state(app).start_hidden.store(false, Ordering::SeqCst),
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
    // Dock icon and menu bar go away while the app lives only in the tray.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

fn quit(app: &AppHandle) {
    state(app).quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Dialogs

fn trim_for_dialog(msg: &str) -> String {
    const MAX: usize = 1800;
    if msg.chars().count() <= MAX {
        return msg.to_string();
    }
    let tail: String = msg.chars().rev().take(MAX).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn ask(app: &AppHandle, title: &str, message: &str, ok: &str, cancel: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()))
        .blocking_show()
}

fn inform(app: &AppHandle, title: &str, message: &str) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Info).blocking_show();
}

/// A system notification from MCP Hub itself. Best effort: a notification that can't be shown is not an error.
fn notify(app: &AppHandle, title: &str, message: &str) {
    let _ = app.notification().builder().title(title).body(message).show();
}

// ---------------------------------------------------------------------------------------------
// Tray, status polling and menu actions

fn set_status(app: &AppHandle, text: &str) {
    let st = state(app);
    let _ = st.status_item.set_text(text);
    let _ = st.tray.set_tooltip(Some(format!("MCP Hub — {text}")));
}

fn api(d: &Daemon, method: &str, path: &str) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}{path}", d.port);
    ureq::request(method, &url)
        .set("Authorization", &format!("Bearer {}", d.token))
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Connected server count, plus the ids of apps waiting for the user to allow or deny them.
fn poll_state(d: &Daemon) -> Result<(usize, Vec<String>), String> {
    let body: serde_json::Value = serde_json::from_str(&api(d, "GET", "/api/state")?).map_err(|e| e.to_string())?;
    let servers = body["servers"].as_array().ok_or("unexpected /api/state response")?;
    let connected = servers.iter().filter(|s| s["state"] == "connected").count();
    let pending = body["clients"]
        .as_array()
        .map(|cs| cs.iter().filter(|c| c["status"] == "pending").filter_map(|c| c["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    Ok((connected, pending))
}

fn poll_loop(app: AppHandle) {
    let mut announced: Vec<String> = Vec::new();
    loop {
        thread::sleep(POLL_EVERY);
        let st = state(&app);
        if st.quitting.load(Ordering::SeqCst) {
            return;
        }
        let Some(d) = st.daemon.lock().unwrap().clone() else { continue };
        let text = match poll_state(&d) {
            Ok((n, pending)) => {
                // Bring the window forward once for each app that is waiting for an answer.
                if pending.iter().any(|id| !announced.contains(id)) {
                    show_main(&app);
                }
                announced = pending.clone();
                match (n, pending.len()) {
                    (_, p) if p > 0 => format!("{p} waiting for approval"),
                    (1, _) => "1 server connected".to_string(),
                    (n, _) => format!("{n} servers connected"),
                }
            }
            Err(_) => "Not responding".to_string(),
        };
        set_status(&app, &text);
    }
}

fn lock_secrets(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some(d) = state(&app).daemon.lock().unwrap().clone() else { return };
        match api(&d, "POST", "/api/credentials/lock") {
            Ok(_) => set_status(&app, "Secrets forgotten"),
            Err(e) => inform(&app, "Could not forget secrets", &e),
        }
    });
}

fn toggle_autostart(app: &AppHandle) {
    let launcher = app.autolaunch();
    let result = if launcher.is_enabled().unwrap_or(false) { launcher.disable() } else { launcher.enable() };
    if let Err(e) = result {
        let app = app.clone();
        let msg = e.to_string();
        thread::spawn(move || inform(&app, "Could not change launch at login", &msg));
    }
    let _ = state(app).autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
}

fn tray_icon(app: &AppHandle) -> tauri::Result<Image<'static>> {
    if cfg!(target_os = "macos") {
        // Black-on-transparent template image; macOS tints it for light/dark menu bars.
        Image::from_bytes(include_bytes!("../icons/tray-template.png"))
    } else {
        Ok(app.default_window_icon().map(|i| i.clone().to_owned()).expect("bundle icon is configured"))
    }
}

#[cfg(target_os = "macos")]
fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuItemBuilder, PredefinedMenuItem as P, Submenu};
    // Replaces the default menu so Cmd+Q is handled by us (and Edit shortcuts keep working).
    let quit = MenuItemBuilder::with_id("app-quit", "Quit MCP Hub").accelerator("CmdOrCtrl+Q").build(app)?;
    let sep = P::separator(app)?;
    let app_menu = Submenu::with_items(
        app,
        "MCP Hub",
        true,
        &[&P::about(app, None, None)?, &sep, &P::hide(app, None)?, &P::hide_others(app, None)?, &P::show_all(app, None)?, &sep, &quit],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &sep,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::close_window(app, None)?])?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &window])?)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------

pub fn run(context: tauri::Context) {
    let app = tauri::Builder::default()
        // Must be first: a second launch just surfaces the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--hidden") {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Closing only hides: the daemon keeps running until "Quit".
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    hide_main(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let start_hidden = std::env::args().any(|a| a == "--hidden");

            #[cfg(target_os = "macos")]
            {
                install_app_menu(&handle)?;
                if start_hidden {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }

            let open = MenuItem::with_id(&handle, "open", "Open MCP Hub", true, None::<&str>)?;
            let status = MenuItem::with_id(&handle, "status", "Starting…", false, None::<&str>)?;
            let lock = MenuItem::with_id(&handle, "lock", "Forget all secrets", true, None::<&str>)?;
            let enabled = handle.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(&handle, "autostart", "Launch at login", true, enabled, None::<&str>)?;
            let quit_item = MenuItem::with_id(&handle, "quit", "Quit MCP Hub", true, None::<&str>)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(&handle)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(&handle)?;
            let menu = Menu::with_items(&handle, &[&open, &status, &sep1, &lock, &autostart, &sep2, &quit_item])?;

            let builder = TrayIconBuilder::with_id("main")
                .icon(tray_icon(&handle)?)
                .tooltip("MCP Hub")
                .menu(&menu)
                // macOS convention is a menu on click; elsewhere a left click opens the window.
                .show_menu_on_left_click(cfg!(target_os = "macos"));
            #[cfg(target_os = "macos")]
            let builder = builder.icon_as_template(true);
            #[cfg(not(target_os = "macos"))]
            let builder = builder.on_tray_icon_event(|tray, event| {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            });
            let tray = builder.build(&handle)?;

            app.manage(AppState {
                daemon: Mutex::new(None),
                quitting: AtomicBool::new(false),
                allowed_port: AtomicU16::new(0),
                start_hidden: AtomicBool::new(start_hidden),
                status_item: status,
                autostart_item: autostart,
                tray,
            });

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main(app),
                "lock" => lock_secrets(app),
                "autostart" => toggle_autostart(app),
                "quit" | "app-quit" => quit(app),
                _ => {}
            });

            thread::spawn({
                let handle = handle.clone();
                move || boot(handle)
            });
            thread::spawn(move || poll_loop(handle));
            Ok(())
        })
        .build(context)
        .expect("failed to build MCP Hub");

    app.run(|app, event| match event {
        // Windows are hidden, never destroyed, so this only comes from the OS (Dock > Quit, logout).
        RunEvent::Exit => {
            state(app).quitting.store(true, Ordering::SeqCst);
            stop_daemon(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}
