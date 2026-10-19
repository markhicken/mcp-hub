#!/usr/bin/env node
// Stand-in for the 1Password CLI used by broker tests.
//   FAKE_OP_LOG   file that receives "start <ts> <ref>" / "end <ts> <ref>" lines
//   FAKE_OP_DENY  if set to a path that exists, behave as if the user dismissed the prompt
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const ref = args.find((a) => a.startsWith("op://")) ?? "";
const log = (kind) => process.env.FAKE_OP_LOG && appendFileSync(process.env.FAKE_OP_LOG, `${kind} ${Date.now()} ${ref}\n`);

if (args[0] === "--version") {
  process.stdout.write("2.30.0\n");
  process.exit(0);
}

if (args[0] === "whoami") {
  process.stdout.write("{}");
  process.exit(0);
}

log("start");
if (process.env.FAKE_OP_DENY && existsSync(process.env.FAKE_OP_DENY)) {
  process.stderr.write("[ERROR] authorization prompt dismissed\n");
  log("end");
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 120));
log("end");
process.stdout.write(`secret:${ref}`);
