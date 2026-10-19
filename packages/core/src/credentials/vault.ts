import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CredentialError, type ProviderFactory } from "./types.js";

/**
 * Options: address, namespace?, mount? (default "secret"), kvVersion? ("2" default | "1"),
 * tokenSource? ("env" default | "file" | "manual"). Manual tokens live in memory under the
 * name `vault-token/<sourceId>` and are set from the UI.
 * Reference: vault://path/to/secret#field
 */
export const createVaultProvider: ProviderFactory = (source, deps) => {
  const address = (source.options.address || deps.env.VAULT_ADDR || "").replace(/\/+$/, "");
  const mount = (source.options.mount || "secret").replace(/^\/+|\/+$/g, "");
  const kv2 = (source.options.kvVersion || "2") !== "1";
  const tokenSource = source.options.tokenSource || "env";

  const token = (): string => {
    let t: string | undefined;
    if (tokenSource === "manual") t = deps.memory.get(`vault-token/${source.id}`);
    else if (tokenSource === "file") {
      try {
        t = readFileSync(join(homedir(), ".vault-token"), "utf-8").trim();
      } catch {}
    } else t = deps.env.VAULT_TOKEN;
    if (!t) throw new CredentialError(`No Vault token available (token source: ${tokenSource})`, "unavailable");
    return t;
  };

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "X-Vault-Token": token() };
    if (source.options.namespace) h["X-Vault-Namespace"] = source.options.namespace;
    return h;
  };

  /** Vault explains refusals in the body: {"errors": ["permission denied"]}. */
  const reason = async (res: Response): Promise<string> => {
    try {
      const errors = ((await res.json()) as { errors?: unknown }).errors;
      return Array.isArray(errors) ? errors.filter((e) => typeof e === "string").join("; ") : "";
    } catch {
      return "";
    }
  };

  /** What a 401/403 usually means, and what to do about it, for the way the token is supplied. */
  const refusedAdvice = (): string =>
    tokenSource === "file"
      ? "The token in ~/.vault-token has probably expired. Sign in again."
      : tokenSource === "manual"
        ? "Check the token you typed in, or that it hasn't expired."
        : "Check that VAULT_TOKEN is current and not expired.";

  return {
    source,
    async resolve(ref) {
      if (!address) throw new CredentialError("Vault address is not configured", "unavailable");
      const rest = ref.slice("vault://".length);
      const [rawPath, field] = rest.split("#");
      const path = (rawPath ?? "").replace(/^\/+|\/+$/g, "");
      if (!path || !field) throw new CredentialError("vault reference must look like vault://path/to/secret#field", "invalid");
      const url = kv2 ? `${address}/v1/${mount}/data/${path}` : `${address}/v1/${mount}/${path}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new CredentialError(`Could not reach Vault: ${(err as Error).message}`, "unavailable");
      }
      if (res.status === 404) throw new CredentialError(`No Vault secret at ${path}`, "not-found");
      if (res.status === 401 || res.status === 403) {
        const why = await reason(res);
        throw new CredentialError(`Vault refused access to ${path} (HTTP ${res.status}${why ? `: ${why}` : ""}). ${refusedAdvice()} If the token is fine, it may lack a policy for this path.`, "denied");
      }
      if (!res.ok) throw new CredentialError(`Vault returned HTTP ${res.status}`, "unavailable");
      const body = (await res.json()) as { data?: { data?: Record<string, unknown> } & Record<string, unknown> };
      const data = (kv2 ? body.data?.data : body.data) as Record<string, unknown> | undefined;
      const value = data?.[field];
      if (typeof value !== "string") throw new CredentialError(`Field "${field}" not found at ${path}`, "not-found");
      return value;
    },
    async test() {
      if (!address) return { ok: false, message: "Vault address is not configured. Edit this source to add it." };
      try {
        const res = await fetch(`${address}/v1/auth/token/lookup-self`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
        if (res.ok) return { ok: true, message: "Authenticated to Vault" };
        if (res.status === 401 || res.status === 403) {
          const why = await reason(res);
          return { ok: false, message: `Vault rejected the token (HTTP ${res.status}${why ? `: ${why}` : ""}). ${refusedAdvice()}`, ...(tokenSource === "file" ? { hint: "sign-in" as const } : {}) };
        }
        return { ok: false, message: `Vault returned HTTP ${res.status}` };
      } catch (err) {
        const e = err as Error;
        // A missing token is reported by headers() before any request is made.
        return { ok: false, message: e.message.startsWith("No Vault token") ? `${e.message}. ${refusedAdvice()}` : e.message, ...(tokenSource === "file" ? { hint: "sign-in" as const } : {}) };
      }
    },
  };
};
