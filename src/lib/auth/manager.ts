import { AUTH_AUDIENCE, AUTH_URL, type AuthProviderName } from "./config";

/**
 * jiun-api 토큰 관리자 (웹 전용, daily에서 가져옴).
 * accessToken(1h)은 메모리에만, refresh는 httpOnly 쿠키로, Convex용 외부 JWT는 만료 5분 전까지 캐시.
 */
const ACCESS_TOKEN_FRESH_MS = 55 * 60 * 1000;
const CONVEX_TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;

export type AuthUser = { id: string; username: string; displayName?: string; avatarUrl?: string };
export type AuthSnapshot = { status: "loading" | "signedOut" | "signedIn"; user: AuthUser | null };

function normalizeExpiresAt(expiresAt: number): number {
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!AUTH_URL) throw new Error("auth disabled");
  return await fetch(`${AUTH_URL}${path}`, { credentials: "include", ...init });
}

export class AuthManager {
  private accessToken: string | null = null;
  private accessTokenFetchedAt = 0;
  private convexToken: { token: string; expiresAt: number } | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private listeners = new Set<() => void>();
  private restored = false;
  snapshot: AuthSnapshot = { status: "loading", user: null };

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;
  private set(next: AuthSnapshot) {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      const token = await this.refreshAccessToken();
      if (token) {
        await this.loadUser();
        this.set({ ...this.snapshot, status: "signedIn" });
        return;
      }
    } catch {
      /* 로그아웃 상태로 시작 */
    }
    this.set({ status: "signedOut", user: null });
  }

  signIn(provider: AuthProviderName): void {
    if (!AUTH_URL) throw new Error("auth disabled");
    const redirectUri = `${window.location.origin}/auth/callback`;
    window.location.assign(`${AUTH_URL}/auth/${provider}?redirect_uri=${encodeURIComponent(redirectUri)}`);
  }

  async exchangeCode(code: string): Promise<void> {
    const res = await authFetch("/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!res.ok) throw new Error(`code 교환 실패 (${res.status})`);
    const body = (await res.json()) as { accessToken: string };
    this.accessToken = body.accessToken;
    this.accessTokenFetchedAt = Date.now();
    await this.loadUser();
    this.set({ ...this.snapshot, status: "signedIn" });
  }

  async signOut(): Promise<void> {
    try {
      await authFetch("/auth/logout", { method: "POST" });
    } catch {
      /* 로컬 세션은 지운다 */
    }
    this.accessToken = null;
    this.accessTokenFetchedAt = 0;
    this.convexToken = null;
    this.set({ status: "signedOut", user: null });
  }

  private async loadUser(): Promise<void> {
    try {
      const res = await authFetch("/auth/me", { headers: { Authorization: `Bearer ${this.accessToken}` } });
      if (!res.ok) return;
      const json = (await res.json()) as unknown;
      const wrapped = json && typeof json === "object" ? (json as { user?: unknown }).user : undefined;
      const u = (wrapped && typeof wrapped === "object" ? wrapped : json) as Record<string, unknown> | null;
      if (!u) return;
      const id = String(u.id ?? u._id ?? "");
      if (!id) return;
      this.snapshot = {
        ...this.snapshot,
        user: { id, username: String(u.username ?? ""), displayName: (u.displayName as string | undefined) ?? (u.name as string | undefined), avatarUrl: (u.avatarUrl as string | undefined) ?? undefined },
      };
    } catch {
      /* 표시용 */
    }
  }

  private refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const res = await authFetch("/auth/refresh", { method: "POST" });
        if (!res.ok) return null;
        const body = (await res.json()) as { accessToken: string };
        this.accessToken = body.accessToken;
        this.accessTokenFetchedAt = Date.now();
        return body.accessToken;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() - this.accessTokenFetchedAt < ACCESS_TOKEN_FRESH_MS) return this.accessToken;
    return await this.refreshAccessToken();
  }

  async fetchConvexToken(force = false): Promise<string | null> {
    if (!force && this.convexToken && Date.now() < this.convexToken.expiresAt - CONVEX_TOKEN_EARLY_REFRESH_MS) return this.convexToken.token;
    const accessToken = await this.ensureAccessToken();
    if (!accessToken) return null;
    const res = await authFetch("/auth/token/external", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ aud: AUTH_AUDIENCE }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token: string; expiresAt: number };
    this.convexToken = { token: body.token, expiresAt: normalizeExpiresAt(body.expiresAt) };
    return body.token;
  }
}

let manager: AuthManager | null = null;
export function getAuthManager(): AuthManager | null {
  if (!AUTH_URL) return null;
  if (!manager) manager = new AuthManager();
  return manager;
}
