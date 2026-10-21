import { appBundle } from "./clients.js";
import { run } from "./credentials/exec.js";

/** True when `codesign -dv` output describes an ad-hoc signature (no certificate behind it). */
export function isAdHocSignature(codesignOutput: string): boolean {
  return /^Signature=adhoc$/im.test(codesignOutput) || /flags=0x[0-9a-f]+\([^)]*\badhoc\b/i.test(codesignOutput);
}

/**
 * Is this the packaged macOS app, signed ad hoc? Then macOS sees each update as a new app and asks again for
 * approvals it already gave. Anything uncertain (not macOS, not run from an .app bundle, codesign failing) is false:
 * the answer only ever adds an explanation, so it should not guess.
 */
export async function detectAdHocSigning(execPath = process.execPath, platform = process.platform, runner: typeof run = run): Promise<boolean> {
  if (platform !== "darwin") return false;
  const bundle = appBundle(execPath);
  if (!bundle) return false;
  try {
    // codesign writes its description to stderr.
    const { stdout, stderr } = await runner("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], { timeoutMs: 10_000 });
    return isAdHocSignature(`${stdout}\n${stderr}`);
  } catch (err) {
    const text = (err as { stderr?: string }).stderr;
    return typeof text === "string" && isAdHocSignature(text);
  }
}
