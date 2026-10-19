import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SavedSignIn } from "./credentials/signins.js";

/** Where a sign-in is kept between restarts, when the user chose to remember it. */
export interface SignInMemory {
  remember: () => boolean;
  /** The server's address; a saved sign-in for a different one is not used. */
  origin: string;
  load: () => SavedSignIn | undefined;
  save: (s: SavedSignIn) => void;
  clear: () => void;
}

/** OAuth state for one upstream server. Held in memory; saved (encrypted) only when the user chose to remember it. */
export class HubOAuthProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _client?: OAuthClientInformationMixed;
  private _verifier = "";
  /** The state value we sent; the callback must echo it. */
  expectedState = "";
  authUrl?: string;

  constructor(
    private readonly redirect: () => string,
    private readonly opts: { clientId?: string; clientSecret?: string; scope?: string } = {},
    private readonly onAuthUrl: (url: string) => void = () => {},
    private readonly memory?: SignInMemory,
  ) {
    if (opts.clientId) {
      this._client = { client_id: opts.clientId, ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}) } as OAuthClientInformationMixed;
    }
    this.restore();
  }

  private restore(): void {
    const m = this.memory;
    if (!m?.remember()) return;
    const saved = m.load();
    if (!saved) return;
    if (saved.origin !== m.origin) return m.clear();
    this._tokens = saved.tokens;
    if (saved.client && !this.opts.clientId) this._client = saved.client;
  }

  /** Bring the saved copy in line with what is held now and whether it should be remembered. */
  syncRemembered(): void {
    const m = this.memory;
    if (!m) return;
    if (this._tokens && m.remember()) m.save({ tokens: this._tokens, origin: m.origin, ...(this.opts.clientId || !this._client ? {} : { client: this._client }) });
    else m.clear();
  }

  get redirectUrl(): string {
    return this.redirect();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MCP Hub",
      redirect_uris: [this.redirect()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("base64url");
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._client;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._client = info;
    if (this._tokens) this.syncRemembered();
  }
  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    this.authUrl = undefined;
    this.syncRemembered();
  }
  redirectToAuthorization(url: URL): void {
    this.authUrl = url.toString();
    this.onAuthUrl(this.authUrl);
  }
  saveCodeVerifier(v: string): void {
    this._verifier = v;
  }
  codeVerifier(): string {
    return this._verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this._tokens = undefined;
    if ((scope === "all" || scope === "client") && !this.opts.clientId) this._client = undefined;
    if (scope === "all" || scope === "verifier") this._verifier = "";
    this.syncRemembered();
  }

  get hasTokens(): boolean {
    return !!this._tokens;
  }
  signOut(): void {
    this._tokens = undefined;
    this.authUrl = undefined;
    this.memory?.clear();
  }
}
