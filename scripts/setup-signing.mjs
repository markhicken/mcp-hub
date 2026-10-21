// One-time setup: makes a self-signed code-signing certificate named "MCP Hub Local Signing" in your login
// keychain, so local builds keep the same identity and macOS stops asking for approvals again after every rebuild.
//   npm run setup:signing
//
// What it changes: it adds one certificate and its private key to your login keychain, and marks the certificate
// trusted for code signing (macOS will ask for your password or Touch ID for that). Nothing is sent anywhere, and
// the certificate only signs builds made on this Mac. To undo it, delete "MCP Hub Local Signing" in Keychain Access.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "MCP Hub Local Signing";

if (process.platform !== "darwin") {
  console.log("Local signing identities are only needed on macOS. Nothing to do.");
  process.exit(0);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const existing = () => run("security", ["find-identity", "-v", "-p", "codesigning"]).includes(`"${NAME}"`);

if (existing()) {
  console.log(`"${NAME}" is already set up. Builds will use it automatically.`);
  process.exit(0);
}

const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
const dir = mkdtempSync(join(tmpdir(), "mcp-hub-signing-"));
try {
  // The system openssl (LibreSSL) writes a .p12 that `security import` accepts; newer OpenSSL needs -legacy.
  const openssl = "/usr/bin/openssl";
  const conf = join(dir, "cert.conf");
  writeFileSync(
    conf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      `CN = ${NAME}`,
      "[ext]",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = critical, codeSigning",
      "basicConstraints = critical, CA:false",
      "",
    ].join("\n"),
  );
  const key = join(dir, "key.pem");
  const crt = join(dir, "cert.pem");
  const p12 = join(dir, "identity.p12");
  const password = randomBytes(16).toString("hex");
  run(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-config", conf, "-keyout", key, "-out", crt]);
  run(openssl, ["pkcs12", "-export", "-inkey", key, "-in", crt, "-name", NAME, "-out", p12, "-passout", `pass:${password}`]);

  console.log("Adding the certificate to your login keychain…");
  run("security", ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
  console.log("Marking it trusted for code signing. macOS will ask for your password or Touch ID.");
  execFileSync("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, crt], { stdio: "inherit" });
} catch (err) {
  console.error(`Setup failed: ${(err.stderr || err.message || err).toString().trim()}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!process.exitCode) {
  if (existing()) console.log(`Done. "${NAME}" will be used for the next build (npm run build:app). Approve the macOS prompts once more after that first build.`);
  else {
    console.error(`The certificate was added but macOS doesn't list it as valid for code signing yet. Open Keychain Access, find "${NAME}", and set Trust → Code Signing to Always Trust.`);
    process.exitCode = 1;
  }
}
