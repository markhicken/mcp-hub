import type { SourceConfig, SourceType } from "../types.js";

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly kind: "denied" | "not-found" | "unavailable" | "invalid" = "unavailable",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Read access to the user's typed-in secrets (values are decrypted when read). */
export interface SecretStore {
  get(name: string): string | undefined;
  names(): string[];
}

export interface ProviderDeps {
  memory: SecretStore;
  env: NodeJS.ProcessEnv;
}

export interface CredentialProvider {
  readonly source: SourceConfig;
  resolve(ref: string): Promise<string>;
  test(): Promise<{ ok: boolean; message: string; hint?: "sign-in" }>;
}

export type ProviderFactory = (source: SourceConfig, deps: ProviderDeps) => CredentialProvider;

/** URL scheme used in references, per source type. */
export const SCHEME_FOR_TYPE: Record<SourceType, string> = {
  "1password": "op",
  keychain: "keychain",
  vault: "vault",
  manual: "secret",
  env: "env",
};

export const TYPE_FOR_SCHEME: Record<string, SourceType> = Object.fromEntries(
  Object.entries(SCHEME_FOR_TYPE).map(([t, s]) => [s, t as SourceType]),
);

export function schemeOf(ref: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(ref);
  return m ? m[1]!.toLowerCase() : null;
}
