#!/usr/bin/env node
// Stand-in for the Vault CLI used by setup tests.
//   version           prints a version line
//   login -address=… -method=…   writes $HOME/.vault-token and records the arguments in $HOME/vault-args.txt
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "version") {
  process.stdout.write("Vault v1.18.3 (abcdef0123), built 2024-12-01T00:00:00Z\n");
  process.exit(0);
}
if (args[0] === "login") {
  const home = process.env.HOME ?? "";
  appendFileSync(join(home, "vault-args.txt"), args.join(" ") + "\n");
  if (process.env.FAKE_VAULT_FAIL) {
    process.stderr.write("Error authenticating: permission denied\n");
    process.exit(2);
  }
  writeFileSync(join(home, ".vault-token"), "s.faketoken");
  process.exit(0);
}
process.exit(1);
