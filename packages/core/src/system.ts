import { execFile, spawn } from "node:child_process";
import { runPowerShell } from "./powershell.js";

/**
 * Merges environments the way the platform reads them. Windows variable names ignore case (`Path`, `PATH`), so a plain
 * object spread would keep two copies of one variable and the child would see either. The first spelling seen is kept
 * and later values replace it. Elsewhere it is a plain spread.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...base, ...extra };
  const out: NodeJS.ProcessEnv = {};
  const keys = new Map<string, string>();
  for (const source of [base, extra]) {
    for (const [k, v] of Object.entries(source)) {
      const lower = k.toLowerCase();
      const key = keys.get(lower) ?? k;
      keys.set(lower, key);
      out[key] = v;
    }
  }
  return out;
}

const expandVars = (text: string, env: NodeJS.ProcessEnv): string =>
  text.replace(/%([^%]+)%/g, (whole, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit && env[hit] ? env[hit]! : whole;
  });

/** The `Path` value in `reg query` output (REG_SZ or REG_EXPAND_SZ), or "". */
export function parseRegPath(output: string): string {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output)?.[1] ?? "";
}

/** System PATH, then user PATH, then whatever this process already had (nothing in it is dropped), without repeats. */
export function combinePaths(machine: string, user: string, current: string, env: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [machine, user, current].flatMap((p) => expandVars(p, env).split(";"))) {
    const e = entry.trim();
    if (!e || seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    out.push(e);
  }
  return out.join(";");
}

const regPath = (key: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("reg.exe", ["query", key, "/v", "Path"], { timeout: 4000, windowsHide: true, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : parseRegPath(String(stdout))));
  });

/**
 * A program installed after you logged in (a new node, uv) changes PATH in the registry but not in running programs,
 * so the hub would not find it. Windows has no login shell to ask, so read the registry values directly.
 */
async function loadWindowsEnv(): Promise<NodeJS.ProcessEnv> {
  const [machine, user] = await Promise.all([regPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), regPath("HKCU\\Environment")]);
  if (!machine && !user) return {};
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "Path";
  return { [key]: combinePaths(machine, user, process.env[key] ?? "") };
}

/**
 * GUI apps on macOS/Linux do not inherit the PATH and variables from your shell profile, which
 * breaks `npx`, `uvx`, nvm-managed node, etc. Ask a login shell for its environment once.
 * On Windows GUI apps do inherit the user environment; only PATH is refreshed from the registry.
 */
export function loadShellEnv(timeoutMs = 6000): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return loadWindowsEnv();
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

/** A toast attributed to Windows PowerShell (the one app id that is always registered); the text arrives in environment variables. */
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:HUB_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:HUB_MESSAGE)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;

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
    } else if (process.platform === "win32") {
      void runPowerShell(TOAST_SCRIPT, { env: { HUB_TITLE: title, HUB_MESSAGE: message }, timeoutMs: 15_000 }).catch(() => {});
    }
  } catch {
    // notifications are optional
  }
}

const SAVE_DIALOG_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = $env:HUB_PROMPT
$dialog.FileName = $env:HUB_NAME
$dialog.Filter = $env:HUB_FILTER
$dialog.OverwritePrompt = $true
$dialog.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
`;

/**
 * Shows the system "Save As" dialog and resolves to the path the user chose, `null` if they cancelled, or
 * `undefined` when this platform has no dialog we can show (the caller then falls back to a browser download).
 * The suggested name and prompt are passed as arguments, never spliced into the script.
 */
export function pickSavePath(suggestedName: string, prompt: string): Promise<string | null | undefined> {
  if (process.platform === "win32") {
    const ext = /\.([A-Za-z0-9]{1,10})$/.exec(suggestedName)?.[1];
    const filter = `${ext ? `${ext.toUpperCase()} files (*.${ext})|*.${ext}|` : ""}All files (*.*)|*.*`;
    // The person may take their time choosing.
    return runPowerShell(SAVE_DIALOG_SCRIPT, { env: { HUB_PROMPT: prompt, HUB_NAME: suggestedName, HUB_FILTER: filter }, sta: true, timeoutMs: 10 * 60_000 }).then(
      (out) => out.trim() || null,
    );
  }
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

/** Show a file in Finder (macOS) or Explorer (Windows), or its folder in the file manager. Best effort. */
export function revealInFileManager(path: string): void {
  if (process.platform === "win32") {
    // Explorer parses its own command line: `/select,"C:\a b\c.json"` must reach it verbatim, which Node's usual quoting breaks.
    if (path.includes('"')) return;
    const child = spawn("explorer.exe", [`/select,"${path}"`], { stdio: "ignore", detached: true, windowsVerbatimArguments: true });
    child.on("error", () => {});
    child.unref();
    return;
  }
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", path]] : ["xdg-open", [path.replace(/[^/\\]*$/, "") || "."]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
