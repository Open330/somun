import { AUTH_AUDIENCE, AUTH_URL, type AuthProviderName } from "./config";

/**
 * jiun-api 토큰 관리자 (웹 전용, daily에서 가져옴).
 * accessToken(1h)은 메모리에만, refresh는 httpOnly 쿠키로, 소문 API용 외부 JWT는 만료 5분 전까지 캐시.
 * 외부 JWT와 표시용 사용자 정보는 localStorage에도 둔다: 새로고침·새 탭마다 refresh → me → 발급을 다시 하면
 * jiun-api의 발급·감사 기록이 페이지 로드 수만큼 쌓였다(사용자 2명에 나흘 동안 발급 1,438회). 이 토큰은 소문 전용(aud)·1시간짜리라
 * 탭을 닫은 뒤에도 토큰이 남는 차이가 있다. 로그아웃·계정 전환은 다른 탭에도 반영하며 서명 검증은 API 서버가 담당한다.
 */
const ACCESS_TOKEN_FRESH_MS = 55 * 60 * 1000;
const API_TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;
const API_TOKEN_STORAGE_KEY = "somun.auth.apiToken.v1";
type StoredSession = NonNullable<AuthManager["apiToken"]> & { user: AuthUser | null };

/** 저장된 표시 계정·만료가 JWT와 일치하는지 확인한다. 서명 검증이나 인증을 대신하지 않는다. */
function tokenClaims(value: string): { sub: string; exp: number } | null {
  try {
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || claims.iss !== AUTH_URL) return null;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audience.includes(AUTH_AUDIENCE) ? { sub: claims.sub, exp: claims.exp } : null;
  } catch {
    return null;
  }
}

function readStoredSession(now = Date.now()): StoredSession | null {
  try {
    const raw = localStorage.getItem(API_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.token !== "string" || typeof value.expiresAt !== "number" || value.expiresAt - API_TOKEN_EARLY_REFRESH_MS <= now)
      return null;
    const user = value.user && typeof value.user === "object" && typeof value.user.id === "string" ? value.user : null;
    const claims = tokenClaims(value.token);
    if (!user || !claims || claims.sub !== user.id || !Number.isFinite(value.expiresAt)) return null;
    const expiresAt = Math.min(value.expiresAt, claims.exp * 1000);
    const { token } = value;
    return expiresAt - API_TOKEN_EARLY_REFRESH_MS > now ? { token, expiresAt, user } : null;
  } catch {
    return null;
  }
}
function writeStoredSession(session: StoredSession): void {
  try {
    localStorage.setItem(API_TOKEN_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* 저장할 수 없으면 메모리 캐시만 쓴다 */
  }
}
function clearStoredSession(): void {
  try {
    localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export type AuthUser = { id: string; username: string; displayName?: string; avatarUrl?: string; provider?: string; email?: string };
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
  private apiToken: { token: string; expiresAt: number } | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private apiTokenInFlight: Promise<string | null> | null = null;
  private authEpoch = 0;
  private listeners = new Set<() => void>();
  private restored = false;
  snapshot: AuthSnapshot = { status: "loading", user: null };

  constructor() {
    if (typeof window !== "undefined") window.addEventListener("storage", this.onStorageChange);
  }

  private onStorageChange = (event: StorageEvent) => {
    if (event.key !== API_TOKEN_STORAGE_KEY && event.key !== null) return;
    const stored = readStoredSession();
    if (stored?.user?.id && stored.user.id === this.snapshot.user?.id) {
      const { token, expiresAt } = stored;
      this.apiToken = { token, expiresAt };
      return;
    }
    // 다른 탭의 로그아웃·계정 전환은 메모리에 남은 이전 토큰에도 반영한다.
    this.resetLocalSession();
  };

  private resetLocalSession() {
    this.authEpoch++;
    this.accessToken = null;
    this.accessTokenFetchedAt = 0;
    this.apiToken = null;
    this.apiTokenInFlight = null;
    this.refreshInFlight = null;
    this.set({ status: "signedOut", user: null });
  }

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
    const epoch = this.authEpoch;
    // 다른 탭이나 이전 로드에서 받은 토큰이 아직 쓸 만하면 jiun-api를 부르지 않고 그대로 시작한다.
    const stored = readStoredSession();
    if (stored?.user) {
      this.apiToken = { token: stored.token, expiresAt: stored.expiresAt };
      this.set({ status: "signedIn", user: stored.user });
      return;
    }
    try {
      const token = await this.refreshAccessToken();
      if (epoch !== this.authEpoch) return;
      if (token) {
        await this.loadUser();
        if (epoch !== this.authEpoch) return;
        this.set({ ...this.snapshot, status: "signedIn" });
        return;
      }
    } catch {
      /* 로그아웃 상태로 시작 */
    }
    if (epoch === this.authEpoch) this.set({ status: "signedOut", user: null });
  }

  signIn(provider: AuthProviderName): void {
    if (!AUTH_URL) throw new Error("auth disabled");
    const redirectUri = `${window.location.origin}/auth/callback`;
    window.location.assign(`${AUTH_URL}/auth/${provider}?redirect_uri=${encodeURIComponent(redirectUri)}`);
  }

  async exchangeCode(code: string): Promise<void> {
    const res = await authFetch("/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`code exchange failed (${res.status})`);
    const body = (await res.json()) as { accessToken: string };
    this.authEpoch++;
    this.apiToken = null;
    clearStoredSession();
    this.apiTokenInFlight = null;
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
    clearStoredSession();
    this.resetLocalSession();
  }

  private async loadUser(): Promise<void> {
    const epoch = this.authEpoch;
    try {
      const res = await authFetch("/auth/me", { headers: { Authorization: `Bearer ${this.accessToken}` } });
      if (!res.ok) return;
      const json = (await res.json()) as unknown;
      if (epoch !== this.authEpoch) return;
      const wrapped = json && typeof json === "object" ? (json as { user?: unknown }).user : undefined;
      const u = (wrapped && typeof wrapped === "object" ? wrapped : json) as Record<string, unknown> | null;
      if (!u) return;
      const id = String(u.id ?? u._id ?? "");
      if (!id) return;
      this.snapshot = {
        ...this.snapshot,
        user: {
          id,
          username: String(u.username ?? ""),
          displayName: (u.displayName as string | undefined) ?? (u.name as string | undefined),
          avatarUrl: (u.avatarUrl as string | undefined) ?? undefined,
          provider: (u.provider as string | undefined) ?? undefined,
          email: (u.email as string | undefined) ?? undefined,
        },
      };
    } catch {
      /* 표시용 */
    }
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const epoch = this.authEpoch;
    const pending = (async () => {
      const res = await authFetch("/auth/refresh", { method: "POST" });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      if (epoch !== this.authEpoch) throw new Error("session changed");
      this.accessToken = body.accessToken;
      this.accessTokenFetchedAt = Date.now();
      return body.accessToken;
    })();
    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  private async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() - this.accessTokenFetchedAt < ACCESS_TOKEN_FRESH_MS) return this.accessToken;
    return await this.refreshAccessToken();
  }

  async fetchApiToken(force = false): Promise<string | null> {
    if (this.snapshot.status === "signedOut") throw new Error("session changed; sign in again");
    if (!force && this.apiToken && Date.now() < this.apiToken.expiresAt - API_TOKEN_EARLY_REFRESH_MS) return this.apiToken.token;
    // 다른 탭이 먼저 새 토큰을 받았으면 그것을 쓴다(탭마다 따로 발급하지 않게).
    const stored = force ? null : readStoredSession();
    if (stored && this.snapshot.user && stored.user?.id === this.snapshot.user.id) {
      this.apiToken = { token: stored.token, expiresAt: stored.expiresAt };
      return stored.token;
    }
    if (this.apiTokenInFlight) return this.apiTokenInFlight;
    const epoch = this.authEpoch;
    const pending = (async () => {
      const accessToken = await this.ensureAccessToken();
      if (epoch !== this.authEpoch) throw new Error("session changed");
      if (!accessToken) return null;
      const res = await authFetch("/auth/token/external", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ aud: AUTH_AUDIENCE }),
      });
      if (epoch !== this.authEpoch) throw new Error("session changed");
      if (res.status === 401 || res.status === 403) {
        clearStoredSession();
        return null;
      }
      // 429·일시 장애를 null로 바꾸면 API가 인증 없이 호출돼 401 → 강제 로그아웃이 된다.
      if (!res.ok) throw new Error(`token issuance failed (${res.status})`);
      const body = (await res.json()) as NonNullable<typeof this.apiToken>;
      if (epoch !== this.authEpoch) throw new Error("session changed");
      const { token, expiresAt } = body;
      const claims = tokenClaims(token);
      if (claims && this.snapshot.user && claims.sub !== this.snapshot.user.id) {
        clearStoredSession();
        this.resetLocalSession();
        throw new Error("account changed; sign in again");
      }
      this.apiToken = { token, expiresAt: normalizeExpiresAt(expiresAt) };
      // 사용자 정보가 있을 때만 저장한다(저장된 세션으로 시작할 때 화면에 보일 계정이 있어야 한다).
      if (claims && this.snapshot.user) writeStoredSession({ ...this.apiToken, user: this.snapshot.user });
      return body.token;
    })();
    this.apiTokenInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.apiTokenInFlight === pending) this.apiTokenInFlight = null;
    }
  }
}

let manager: AuthManager | null = null;
export function getAuthManager(): AuthManager | null {
  if (!AUTH_URL) return null;
  if (!manager) manager = new AuthManager();
  return manager;
}
