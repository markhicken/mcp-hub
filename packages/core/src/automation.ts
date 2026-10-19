import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExecError, run } from "./credentials/exec.js";

/** MCP Hub's own bundle id; macOS keeps its Automation decisions under this name. */
export const APP_BUNDLE_ID = "com.mcphub.app";

export interface AutomationTarget {
  id: string;
  name: string;
  bundleId: string;
}

export type AutomationStatus = "allowed" | "denied" | "waiting" | "unavailable";

export interface AutomationResult {
  status: AutomationStatus;
  message: string;
}

// Apps that MCP servers commonly drive with AppleScript.
const CANDIDATES: Array<AutomationTarget & { paths: string[] }> = [
  { id: "outlook", name: "Microsoft Outlook", bundleId: "com.microsoft.Outlook", paths: ["Microsoft Outlook.app"] },
  { id: "mail", name: "Mail", bundleId: "com.apple.mail", paths: ["Mail.app"] },
  { id: "calendar", name: "Calendar", bundleId: "com.apple.iCal", paths: ["Calendar.app"] },
  { id: "contacts", name: "Contacts", bundleId: "com.apple.AddressBook", paths: ["Contacts.app"] },
  { id: "reminders", name: "Reminders", bundleId: "com.apple.reminders", paths: ["Reminders.app"] },
  { id: "notes", name: "Notes", bundleId: "com.apple.Notes", paths: ["Notes.app"] },
];

const FOLDERS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

/** The Mac apps on this machine that servers are likely to control. Empty off macOS. */
export function automationTargets(): AutomationTarget[] {
  if (process.platform !== "darwin") return [];
  return CANDIDATES.filter((c) => FOLDERS.some((f) => c.paths.some((p) => existsSync(join(f, p))))).map(({ paths: _p, ...t }) => t);
}

type Runner = typeof run;

/**
 * Asks macOS whether MCP Hub may control `target`, by doing the same thing a server does: a harmless
 * AppleScript call (the app's name). If nobody has decided yet, macOS shows its "MCP Hub wants to control …"
 * prompt now. `reset` first forgets any earlier decision so a denied or lost permission is asked again.
 * The target app is opened if it isn't running, since macOS can only ask about a running app.
 */
export async function checkAutomation(target: AutomationTarget, opts: { reset?: boolean; timeoutMs?: number; exec?: Runner } = {}): Promise<AutomationResult> {
  const exec = opts.exec ?? run;
  if (process.platform !== "darwin" && !opts.exec) return { status: "unavailable", message: "Only macOS controls other apps this way." };
  if (opts.reset) {
    try {
      await exec("/usr/bin/tccutil", ["reset", "AppleEvents", APP_BUNDLE_ID], { timeoutMs: 10_000 });
    } catch {
      // nothing recorded yet, or not running as the packaged app
    }
  }
  try {
    await exec("/usr/bin/osascript", ["-e", `tell application id "${target.bundleId}" to get name`], { timeoutMs: opts.timeoutMs ?? 90_000 });
    return { status: "allowed", message: `MCP Hub can control ${target.name}.` };
  } catch (err) {
    const e = err as ExecError;
    const text = `${e.stderr ?? ""} ${e.message ?? ""}`;
    if (/-1743|not authorized|not allowed/i.test(text)) {
      return { status: "denied", message: `macOS has blocked MCP Hub from controlling ${target.name}. Choose "Ask again", or turn it on in System Settings → Privacy & Security → Automation.` };
    }
    if (e.timedOut) {
      return { status: "waiting", message: `No answer yet. If macOS showed a prompt, choose Allow, then check again. If there was no prompt, use "Ask again".` };
    }
    if (/-600|-10810|-1728|isn.t running|can.t get application|unable to find/i.test(text)) {
      return { status: "unavailable", message: `${target.name} couldn't be opened. Open it once yourself, then check again.` };
    }
    return { status: "unavailable", message: (e.stderr || e.message || "The check failed.").trim().slice(0, 300) };
  }
}

/** Opens the Automation page in System Settings. */
export async function openAutomationSettings(): Promise<void> {
  await run("/usr/bin/open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], { timeoutMs: 10_000 });
}
