import { CredentialError, type ProviderFactory } from "./types.js";

/** secret://name: values the user added to the app. Encrypted in memory and on disk (see LocalSecrets). */
export const createManualProvider: ProviderFactory = (source, deps) => ({
  source,
  async resolve(ref) {
    const name = decodeURIComponent(ref.slice("secret://".length));
    const v = deps.memory.get(name);
    if (v === undefined) throw new CredentialError(`Secret "${name}" has not been entered yet`, "not-found");
    return v;
  },
  async test() {
    const n = deps.memory.names().length;
    return { ok: true, message: `${n} secret${n === 1 ? "" : "s"} held in memory` };
  },
});

/** env://NAME — environment of the hub process (includes your login shell environment). */
export const createEnvProvider: ProviderFactory = (source, deps) => ({
  source,
  async resolve(ref) {
    const name = ref.slice("env://".length);
    const v = deps.env[name];
    if (v === undefined) throw new CredentialError(`Environment variable ${name} is not set`, "not-found");
    return v;
  },
  async test() {
    return { ok: true, message: "Reads the hub's environment variables" };
  },
});
