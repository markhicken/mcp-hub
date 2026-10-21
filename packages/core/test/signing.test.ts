import { afterAll, describe, expect, it } from "vitest";
import { detectAdHocSigning, isAdHocSignature } from "../src/signing.js";
import { startHub } from "./helpers.js";

const ADHOC = "Executable=/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-desktop\nCodeDirectory v=20500 size=7695 flags=0x10002(adhoc,runtime) hashes=230+7 location=embedded\nSignature=adhoc\n";
const DEVID = "CodeDirectory v=20500 size=7695 flags=0x10000(runtime) hashes=230+7 location=embedded\nAuthority=Developer ID Application: Someone (TEAMID1234)\nTeamIdentifier=TEAMID1234\n";

describe("ad-hoc signature detection", () => {
  it("recognises an ad-hoc signature and not a certificate-backed one", () => {
    expect(isAdHocSignature(ADHOC)).toBe(true);
    expect(isAdHocSignature(DEVID)).toBe(false);
  });

  it("only says yes for the packaged macOS app, and stays quiet when unsure", async () => {
    const ok = async () => ({ stdout: "", stderr: ADHOC });
    const app = "/Applications/MCP Hub.app/Contents/MacOS/mcp-hub-core";
    expect(await detectAdHocSigning(app, "darwin", ok)).toBe(true);
    expect(await detectAdHocSigning(app, "linux", ok)).toBe(false);
    expect(await detectAdHocSigning("/usr/local/bin/node", "darwin", ok)).toBe(false);
    expect(await detectAdHocSigning(app, "darwin", async () => ({ stdout: "", stderr: DEVID }))).toBe(false);
    expect(await detectAdHocSigning(app, "darwin", async () => { throw new Error("no codesign"); })).toBe(false);
  });
});

describe("the signing note", () => {
  const started: Array<Awaited<ReturnType<typeof startHub>>> = [];
  afterAll(async () => {
    for (const t of started) await t.stop();
  });

  it("is reported in the snapshot, and dismissing it is saved", async () => {
    const t = await startHub({}, { detectAdHocSigning: async () => true });
    started.push(t);
    await new Promise((r) => setTimeout(r, 50));
    const snap = (await t.api("GET", "/api/state")).body;
    expect(snap.signing).toEqual({ adHoc: true });
    expect(snap.settings).toMatchObject({ dismissedSigningNotice: false, preloadSecrets: false });
    expect((await t.api("PUT", "/api/settings", { dismissedSigningNotice: true })).status).toBe(200);
    expect((await t.api("GET", "/api/state")).body.settings.dismissedSigningNotice).toBe(true);
    expect((await t.api("PUT", "/api/settings", { dismissedSigningNotice: "yes" })).status).toBe(400);
  });

  it("is not reported for a normal run", async () => {
    const t = await startHub();
    started.push(t);
    await new Promise((r) => setTimeout(r, 50));
    expect((await t.api("GET", "/api/state")).body.signing).toEqual({ adHoc: false });
  });
});
