/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *  Ported from the celiador-ai extension of the Celiador editor.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getRestrictedSetting } from './config';
import { resolveDaemonUrl } from './daemonUrl';

// Dependency-free Supabase/GoTrue client for the editor. Supports PKCE-protected
// OAuth and magic-link flows. Session stored in VS Code SecretStorage, access token
// refreshed just before expiry. The access_token is sent to the daemon as
// `Authorization: Bearer` — the shared cross-client auth contract.

const SESSION_KEY = 'celiador.session';
/** Refresh this long before the access token expires. */
const REFRESH_LEAD_SECONDS = 120;
/** Retry delay after a failed background refresh (e.g. offline). */
const REFRESH_RETRY_MS = 60_000;
const PKCE_KEY = 'celiador.pkce';
// The editor routes deep links as <scheme>://<publisher>.<extension><path> to the
// extension's UriHandler; the scheme is the host's (vscode, cursor, vscode-insiders…).
// GoTrue's redirect allowlist must contain each one exactly.
export const AUTH_REDIRECT = `${vscode.env.uriScheme}://celiador.celiador-remote/auth-callback`;

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  email?: string;
}

/** Best-effort email from a JWT payload (no verification — display only). */
function jwtEmail(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

interface PkceState {
  verifier: string;
  expiresAt: number;
}

export class Auth {
  private cached: Session | null | undefined;
  private supaConfig: { base: string; anonKey: string } | undefined;
  private readonly onChange = new vscode.EventEmitter<void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fires whenever the signed-in state changes (sign in/out/refresh). */
  readonly onDidChange = this.onChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private daemonUrl(): string {
    return resolveDaemonUrl();
  }

  /** Resolve the Supabase base URL + anon key (setting override → /api/config). */
  private async supa(): Promise<{ base: string; anonKey: string }> {
    if (this.supaConfig) {return this.supaConfig;}
    const override = getRestrictedSetting<string>('supabaseUrl', '');
    let cfg: any = {};
    try {
      const res = await fetch(`${this.daemonUrl()}/api/config`, { headers: { Accept: 'application/json' } });
      if (res.ok) {cfg = await res.json();}
    } catch {
      /* fall back to daemon URL */
    }
    const base = (override || cfg.supabaseUrl || this.daemonUrl()).replace(/\/+$/, '');
    this.supaConfig = { base, anonKey: cfg.supabaseAnonKey || '' };
    return this.supaConfig;
  }

  private async gotrue(pathAndQuery: string, body: unknown): Promise<any> {
    const { base, anonKey } = await this.supa();
    const res = await fetch(`${base}/auth/v1/${pathAndQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error_description || data?.msg || data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  private toSession(data: any): Session {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at) || now + Number(data.expires_in || 3600),
      email: data.user?.email || data.email || jwtEmail(data.access_token),
    };
  }

  // ---- PKCE helpers ---------------------------------------------------------

  private async generatePkce(): Promise<{ verifier: string; challenge: string }> {
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const data = new TextEncoder().encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const challenge = Buffer.from(hashBuffer)
      .toString('base64url');
    return { verifier, challenge };
  }

  private async storePkce(verifier: string): Promise<void> {
    const state: PkceState = { verifier, expiresAt: Date.now() + 10 * 60 * 1000 };
    await this.secrets.store(PKCE_KEY, JSON.stringify(state));
  }

  private async consumePkce(): Promise<string | null> {
    const raw = await this.secrets.get(PKCE_KEY);
    await this.secrets.delete(PKCE_KEY);
    if (!raw) {return null;}
    try {
      const state: PkceState = JSON.parse(raw);
      if (state.expiresAt < Date.now()) {return null;}
      return state.verifier;
    } catch {
      return null;
    }
  }

  // ---- sign-in methods ------------------------------------------------------

  async signInWithPassword(email: string, password: string): Promise<void> {
    await this.store(this.toSession(await this.gotrue('token?grant_type=password', { email, password })));
  }

  async signUp(email: string, password: string): Promise<boolean> {
    const data = await this.gotrue('signup', { email, password });
    if (data.access_token) {
      await this.store(this.toSession(data));
      return true; // email confirmation disabled → immediate session
    }
    return false; // confirmation email sent; user must confirm
  }

  async sendMagicLink(email: string): Promise<void> {
    const { base, anonKey } = await this.supa();
    const { verifier, challenge } = await this.generatePkce();
    await this.storePkce(verifier);
    const url = `${base}/auth/v1/otp?redirect_to=${encodeURIComponent(AUTH_REDIRECT)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ 
        email, 
        create_user: true,
        code_challenge: challenge,
        code_challenge_method: 's256'
      }),
    });
    if (!res.ok) {
      const d: any = await res.json().catch(() => ({}));
      throw new Error(d?.msg || d?.error_description || `HTTP ${res.status}`);
    }
  }

  async signInWithGitHub(): Promise<void> {
    const { base } = await this.supa();
    const { verifier, challenge } = await this.generatePkce();
    await this.storePkce(verifier);
    const url = `${base}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(AUTH_REDIRECT)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=s256`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Handle celiador://auth-callback — exchange PKCE code for tokens. */
  async handleCallback(uri: vscode.Uri): Promise<boolean> {
    const query = new URLSearchParams(uri.query);
    const fragment = new URLSearchParams(uri.fragment);
    
    // Reject implicit flow tokens
    if (fragment.get('access_token')) {
      throw new Error('Implicit flow tokens rejected. Use PKCE authorization code flow.');
    }

    const code = query.get('code');
    if (!code) {return false;}

    const verifier = await this.consumePkce();
    if (!verifier) {
      throw new Error('No pending sign-in flow (PKCE verifier missing or expired).');
    }

    // Exchange authorization code for tokens via PKCE
    const data = await this.gotrue('token?grant_type=pkce', {
      auth_code: code,
      code_verifier: verifier,
    });

    await this.store(this.toSession(data));
    return true;
  }

  // ---- session state --------------------------------------------------------

  private async store(s: Session): Promise<void> {
    this.cached = s;
    await this.secrets.store(SESSION_KEY, JSON.stringify(s));
    this.scheduleRefresh(s);
    this.onChange.fire();
  }

  private async load(): Promise<Session | null> {
    if (this.cached !== undefined) {return this.cached;}
    const raw = await this.secrets.get(SESSION_KEY);
    this.cached = raw ? (JSON.parse(raw) as Session) : null;
    if (this.cached) {this.scheduleRefresh(this.cached);}
    return this.cached;
  }

  /**
   * Refresh the session shortly before it expires. Consumers that were handed a token
   * once (the agent host's daemon transport, via the auth provider) never ask again, so
   * without this every request fails with 401 an hour after sign-in. A refresh goes
   * through `store`, which fires `onDidChange` and re-forwards the new token.
   */
  private scheduleRefresh(s: Session, delayMs?: number): void {
    if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
    const dueMs = delayMs ?? Math.max(5_000, (s.expires_at - REFRESH_LEAD_SECONDS) * 1000 - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.cached !== s) {return;} // superseded by a newer session or a sign-out
      this.refresh(s).catch(() => this.scheduleRefresh(s, REFRESH_RETRY_MS));
    }, dueMs);
  }

  async signOut(): Promise<void> {
    if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
    this.refreshTimer = undefined;
    this.cached = null;
    await this.secrets.delete(SESSION_KEY);
    this.onChange.fire();
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await this.load());
  }

  async currentEmail(): Promise<string | undefined> {
    return (await this.load())?.email;
  }

  private async refresh(s: Session): Promise<Session> {
    const next = this.toSession(await this.gotrue('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
    await this.store(next);
    return next;
  }

  /** Force a refresh (used after a daemon 401). Returns false if not signed in. */
  async tryRefresh(): Promise<boolean> {
    const s = await this.load();
    if (!s) {return false;}
    try {
      await this.refresh(s);
      return true;
    } catch {
      return false;
    }
  }

  /** A valid access token, refreshing within 60s of expiry. Throws if signed out. */
  async getAccessToken(): Promise<string> {
    let s = await this.load();
    if (!s) {throw new Error('Not signed in.');}
    if (s.expires_at - Math.floor(Date.now() / 1000) < 60) {
      s = await this.refresh(s);
    }
    return s.access_token;
  }
}
