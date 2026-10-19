import { describe, expect, it } from "vitest";
import { checkAutomation, APP_BUNDLE_ID } from "../src/automation.js";
import { ExecError } from "../src/credentials/exec.js";

const outlook = { id: "outlook", name: "Microsoft Outlook", bundleId: "com.microsoft.Outlook" };

function fake(result: "ok" | ExecError) {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file.endsWith("osascript") && result !== "ok") throw result;
    return { stdout: "", stderr: "" };
  };
  return { exec: exec as never, calls };
}

describe("mac automation check", () => {
  it("reports allowed when the AppleScript call works", async () => {
    const f = fake("ok");
    const r = await checkAutomation(outlook, { exec: f.exec });
    expect(r.status).toBe("allowed");
    expect(f.calls).toEqual([["/usr/bin/osascript", "-e", 'tell application id "com.microsoft.Outlook" to get name']]);
  });

  it("reports denied for error -1743", async () => {
    const r = await checkAutomation(outlook, { exec: fake(new ExecError("failed", "execution error: Not authorized to send Apple events to Microsoft Outlook. (-1743)", 1, false)).exec });
    expect(r.status).toBe("denied");
    expect(r.message).toContain("Ask again");
  });

  it("reports waiting when no one answered the prompt", async () => {
    const r = await checkAutomation(outlook, { exec: fake(new ExecError("timed out", "", null, true)).exec });
    expect(r.status).toBe("waiting");
  });

  it("reports unavailable when the app can't be opened", async () => {
    const r = await checkAutomation(outlook, { exec: fake(new ExecError("failed", "Application isn't running. (-600)", 1, false)).exec });
    expect(r.status).toBe("unavailable");
  });

  it("forgets only MCP Hub's own decision before asking again", async () => {
    const f = fake("ok");
    await checkAutomation(outlook, { exec: f.exec, reset: true });
    expect(f.calls[0]).toEqual(["/usr/bin/tccutil", "reset", "AppleEvents", APP_BUNDLE_ID]);
    expect(f.calls[1]![0]).toBe("/usr/bin/osascript");
  });
});
