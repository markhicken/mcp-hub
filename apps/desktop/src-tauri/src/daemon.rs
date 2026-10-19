//! Lifecycle of the MCP Hub daemon child process.
//!
//! Deliberately independent of Tauri so it stays small and testable: it spawns the process with
//! piped stdio, waits for the `ready` JSON line, keeps stdin open for the whole lifetime (the
//! daemon runs with `--exit-on-stdin-close`, so it dies with us even if we crash) and shuts the
//! process down gracefully, escalating to a forced kill.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(3);
const STDERR_TAIL_LINES: usize = 40;

pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    /// Called with (title, message) for each `notify` line the daemon prints, so the app can show it itself.
    pub on_notify: Option<NotifyFn>,
}

pub type NotifyFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub enum SpawnError {
    /// Another daemon already owns the data directory (exit code 3).
    AlreadyRunning(u16),
    Failed(String),
}

pub struct Daemon {
    child: Mutex<Child>,
    /// Windows: kills the daemon and everything it started if this app dies without stopping it.
    #[cfg(windows)]
    _job: Option<job::KillOnClose>,
    stdin: Mutex<Option<ChildStdin>>,
    pub port: u16,
    pub token: String,
    pub url: String,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stopping: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A Windows job object whose processes are all killed when the last handle to it closes,
    /// which includes this process dying for any reason.
    pub struct KillOnClose(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for KillOnClose {}
    unsafe impl Sync for KillOnClose {}

    impl KillOnClose {
        /// Best effort: `None` if the job can't be set up, in which case stdin EOF is still the safety net.
        pub fn adopt(child: &Child) -> Option<Self> {
            // SAFETY: plain Win32 calls with a valid, zero-initialised struct and our own child's handle.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }
    }

    impl Drop for KillOnClose {
        fn drop(&mut self) {
            // SAFETY: the handle is ours and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// 32 random bytes as hex: URL-safe, 64 characters.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("could not generate a token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn push_tail(tail: &Mutex<VecDeque<String>>, line: String) {
    let mut t = lock(tail);
    if t.len() >= STDERR_TAIL_LINES {
        t.pop_front();
    }
    t.push_back(line);
}

/// Reads lossy UTF-8 lines until EOF; the process may write arbitrary bytes.
fn for_each_line(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end().to_string()),
        }
    }
}

impl Daemon {
    pub fn spawn(spec: &LaunchSpec, timeout: Duration) -> Result<Arc<Daemon>, SpawnError> {
        let token = random_token().map_err(SpawnError::Failed)?;

        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .arg("--exit-on-stdin-close")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("MCP_HUB_TOKEN", &token);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        #[cfg(unix)]
        {
            // Own process group, so a forced kill also takes the daemon's children down.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| SpawnError::Failed(format!("Could not start {}: {e}", spec.program.display())))?;

        // Put the daemon in a job that is killed when this process dies, so its servers can't outlive a crash.
        // Anything the daemon starts later is in the job too. (Unix does this with a process group and stdin EOF.)
        #[cfg(windows)]
        let job_guard = job::KillOnClose::adopt(&child);

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let tail = Arc::new(Mutex::new(VecDeque::new()));
        {
            let tail = tail.clone();
            thread::spawn(move || for_each_line(stderr, |l| push_tail(&tail, l)));
        }
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        {
            let tail = tail.clone();
            let on_notify = spec.on_notify.clone();
            // Keeps draining after the ready line so the pipe never fills up and blocks the daemon.
            thread::spawn(move || {
                for_each_line(stdout, |l| match serde_json::from_str::<serde_json::Value>(&l) {
                    Ok(v) if v["event"] == "notify" => {
                        if let (Some(f), Some(title), Some(message)) = (&on_notify, v["title"].as_str(), v["message"].as_str()) {
                            f(title, message);
                        }
                    }
                    Ok(v) if v.is_object() => {
                        let _ = tx.send(v);
                    }
                    _ => push_tail(&tail, format!("[stdout] {l}")),
                })
            });
        }

        let deadline = Instant::now() + timeout;
        let ready = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(v) => match v["event"].as_str() {
                    Some("ready") => break v,
                    Some("already-running") => {
                        let port = v["port"].as_u64().unwrap_or(0) as u16;
                        reap(&mut child);
                        return Err(SpawnError::AlreadyRunning(port));
                    }
                    _ => continue,
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    force_kill(&mut child);
                    return Err(SpawnError::Failed(format!(
                        "The MCP Hub service did not become ready within {}s.\n\n{}",
                        timeout.as_secs(),
                        tail_text(&tail)
                    )));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let status = wait_briefly(&mut child);
                    thread::sleep(Duration::from_millis(150)); // let the stderr reader flush
                    return Err(SpawnError::Failed(format!(
                        "The MCP Hub service exited before it was ready ({status}).\n\n{}",
                        tail_text(&tail)
                    )));
                }
            }
        };

        let port = match ready["port"].as_u64() {
            Some(p) if p > 0 && p <= u16::MAX as u64 => p as u16,
            _ => {
                force_kill(&mut child);
                return Err(SpawnError::Failed("The MCP Hub service reported an invalid port.".into()));
            }
        };
        let token = ready["token"].as_str().filter(|t| !t.is_empty()).unwrap_or(&token).to_string();
        let url = ready["url"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}/?token={token}"));

        Ok(Arc::new(Daemon {
            #[cfg(windows)]
            _job: job_guard,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            port,
            token,
            url,
            stderr_tail: tail,
            stopping: AtomicBool::new(false),
        }))
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn has_exited(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(Some(_)) | Err(_))
    }

    pub fn stderr_tail(&self) -> String {
        tail_text(&self.stderr_tail)
    }

    /// SIGTERM (unix) / closing stdin (everywhere), a 3s grace period, then a forced kill.
    /// Blocks; safe to call more than once.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // EOF on stdin makes the daemon shut down on its own (--exit-on-stdin-close); this is the
        // graceful path on Windows, where there is no SIGTERM.
        drop(lock(&self.stdin).take());

        let mut child = lock(&self.child);
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        #[cfg(unix)]
        // SAFETY: the pid belongs to our un-reaped child.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }

        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                _ => break,
            }
        }
        force_kill(&mut child);
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if !self.is_stopping() {
            self.stop();
        }
    }
}

fn tail_text(tail: &Mutex<VecDeque<String>>) -> String {
    let t = lock(tail);
    let text = t.iter().map(String::as_str).collect::<Vec<_>>().join("\n");
    if text.is_empty() {
        "(no output)".into()
    } else {
        text
    }
}

fn wait_briefly(child: &mut Child) -> String {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.to_string(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                force_kill(child);
                return "killed".into();
            }
        }
    }
}

fn reap(child: &mut Child) {
    wait_briefly(child);
}

fn force_kill(child: &mut Child) {
    #[cfg(unix)]
    // SAFETY: negative pid targets the process group we created for this child.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}
