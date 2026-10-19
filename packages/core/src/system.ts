import { execFile, spawn } from "node:child_process";

/**
 * GUI apps on macOS/Linux do not inherit the PATH and variables from your shell profile, which
 * breaks `npx`, `uvx`, nvm-managed node, etc. Ask a login shell for its environment once.
 */
export function loadShellEnv(timeoutMs = 6000): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return Promise.resolve({});
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", "env -0"],
      { timeout: timeoutMs, encoding: "buffer", env: { ...process.env, TERM: "dumb" }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout?.length) return resolve({});
        const out: NodeJS.ProcessEnv = {};
        for (const entry of stdout.toString("utf-8").split("\0")) {
          const i = entry.indexOf("=");
          if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
        }
        resolve(out);
      },
    );
  });
}

/** Open a URL in the user's default browser. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error("Refusing to open a non-http(s) URL");
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/**
 * Best-effort desktop notification. Never throws.
 *
 * Under the desktop app (`MCP_HUB_NOTIFY=stdout`) the notification is handed to it as a JSON line and shown by the
 * app itself, so it carries MCP Hub's icon and clicking it brings MCP Hub forward. Run on its own, the daemon can
 * only ask the OS: `osascript` notifications are attributed to Script Editor (its icon, and a click opens it).
 */
export function notify(title: string, message: string): void {
  try {
    if (process.env.MCP_HUB_NOTIFY === "stdout") {
      process.stdout.write(JSON.stringify({ event: "notify", title, message }) + "\n");
    } else if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", "on run {t, m}", "-e", "display notification m with title t", "-e", "end run", title, message],
        () => {},
      );
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, message], () => {});
    }
  } catch {
    // notifications are optional
  }
}

/**
 * Shows the system "Save As" dialog and resolves to the path the user chose, `null` if they cancelled, or
 * `undefined` when this platform has no dialog we can show (the caller then falls back to a browser download).
 * The suggested name and prompt are passed as arguments, never spliced into the script.
 */
export function pickSavePath(suggestedName: string, prompt: string): Promise<string | null | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      [
        "-e", "on run argv",
        "-e", "tell current application to activate",
        "-e", "set f to choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (path to documents folder)",
        "-e", "return POSIX path of f",
        "-e", "end run",
        prompt,
        suggestedName,
      ],
      // The person may take their time choosing.
      { timeout: 10 * 60_000 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim() || null);
        // -128 is "User canceled."
        if (/-128|User canceled/i.test(`${stderr} ${err.message}`)) return resolve(null);
        reject(new Error((stderr || err.message).trim().slice(0, 200)));
      },
    );
  });
}

/** Show a file in Finder (macOS) or its folder in the file manager. Best effort. */
export function revealInFileManager(path: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", ["-R", path]] : process.platform === "win32" ? ["explorer", [`/select,${path}`]] : ["xdg-open", [path.replace(/[^/\\]*$/, "") || "."]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
