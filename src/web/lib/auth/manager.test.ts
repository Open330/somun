import { afterEach, expect, it, vi } from "vitest";
import { AuthManager } from "./manager";

vi.mock("./config", () => ({ AUTH_URL: "https://auth.test", AUTH_AUDIENCE: "somun" }));
afterEach(() => vi.unstubAllGlobals());
const tokenReply: (value: string) => Response = (token) => Response.json({ token, expiresAt: Date.now() + 3600000 });

function mockAuth(external: () => Promise<Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/token/external")) return external();
    if (url.endsWith("/auth/refresh") || url.endsWith("/auth/exchange")) return Response.json({ accessToken: "test-access" });
    if (url.endsWith("/auth/me")) return Response.json({ id: "test-user", username: "test" });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("shares one issuance across parallel initial requests and forced refreshes, then caches it", async () => {
  const fetchMock = mockAuth(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return tokenReply("test-api");
  });
  const manager = new AuthManager();
  expect(await Promise.all(Array.from({ length: 15 }, () => manager.fetchApiToken()))).toEqual(Array(15).fill("test-api"));
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/token/external"))).toHaveLength(1);
  expect(await manager.fetchApiToken()).toBe("test-api");
  await Promise.all(Array.from({ length: 15 }, () => manager.fetchApiToken(true)));
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/token/external"))).toHaveLength(2);
});

it.each([429, 503])("keeps a temporary issuance failure (%s) distinct from expired authentication and permits retry", async (status) => {
  let fail = true;
  mockAuth(async () => (fail ? new Response(null, { status }) : tokenReply("recovered")));
  const manager = new AuthManager();
  await manager.restore();
  await expect(manager.fetchApiToken()).rejects.toThrow(`token issuance failed (${status})`);
  expect(manager.snapshot.status).toBe("signedIn");
  fail = false;
  expect(await manager.fetchApiToken()).toBe("recovered");
});

it("does not cache an issuance that finishes after logout", async () => {
  let complete!: (value: Response) => void;
  mockAuth(() => new Promise((resolve) => (complete = resolve)));
  const manager = new AuthManager();
  await manager.restore();
  const pending = manager.fetchApiToken();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  await manager.signOut();
  complete(tokenReply("stale"));
  await expect(pending).rejects.toThrow("session changed");
  expect(manager.snapshot.status).toBe("signedOut");
});

it("clears the prior account's API token on a new login", async () => {
  let count = 0;
  const fetchMock = mockAuth(async () => tokenReply(`account-token-${++count}`));
  const manager = new AuthManager();
  expect(await manager.fetchApiToken()).toBe("account-token-1");
  await manager.exchangeCode("test-code");
  expect(await manager.fetchApiToken()).toBe("account-token-2");
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/token/external"))).toHaveLength(2);
});

it.each([401, 403])("still returns missing authentication for an authorization rejection (%s)", async (status) => {
  mockAuth(async () => new Response(null, { status }));
  expect(await new AuthManager().fetchApiToken()).toBeNull();
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}
const calls = (fetchMock: ReturnType<typeof mockAuth>, path: string) => fetchMock.mock.calls.filter(([url]) => url.endsWith(path)).length;
const storageKey = "somun.auth.apiToken.v1";
const jwt = (sub = "test-user", exp = Date.now() + 3600000, aud = "somun") =>
  `dummy.${btoa(JSON.stringify({ sub, exp: Math.floor(exp / 1000), aud, iss: "https://auth.test" }))}.dummy`;
const storedSession: (value: string, id?: string, expiresAt?: number) => Record<string, unknown> = (
  token,
  id = "test-user",
  expiresAt = Date.now() + 3600000,
) => ({ token, expiresAt, user: { id, username: "test" } });
function storageEvent(target: EventTarget) {
  target.dispatchEvent(Object.assign(new Event("storage"), { key: storageKey }));
}

it("reuses a stored API token across page loads and tabs without calling jiun-api", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  const cached = jwt();
  const fetchMock = mockAuth(async () => tokenReply(cached));
  const first = new AuthManager();
  await first.restore();
  expect(await first.fetchApiToken()).toBe(cached);
  expect([calls(fetchMock, "/auth/refresh"), calls(fetchMock, "/auth/me"), calls(fetchMock, "/auth/token/external")]).toEqual([1, 1, 1]);
  // 새로고침·새 탭: 저장된 토큰과 계정으로 바로 시작한다.
  const second = new AuthManager();
  await second.restore();
  expect(second.snapshot).toEqual({ status: "signedIn", user: expect.objectContaining({ id: "test-user" }) });
  expect(await second.fetchApiToken()).toBe(cached);
  expect([calls(fetchMock, "/auth/refresh"), calls(fetchMock, "/auth/me"), calls(fetchMock, "/auth/token/external")]).toEqual([1, 1, 1]);
});

it("ignores a stored token close to expiry, and drops it on a forced refresh and on logout", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(
    "somun.auth.apiToken.v1",
    JSON.stringify(storedSession(jwt("test-user", Date.now() + 60000), "test-user", Date.now() + 60000)),
  );
  const cached = jwt();
  const fetchMock = mockAuth(async () => tokenReply(cached));
  const manager = new AuthManager();
  await manager.restore();
  expect(calls(fetchMock, "/auth/refresh")).toBe(1);
  expect(await manager.fetchApiToken()).toBe(cached);
  expect(JSON.parse(storage.getItem("somun.auth.apiToken.v1")!).token).toBe(cached);
  // 401 뒤의 강제 갱신은 저장된 토큰을 쓰지 않는다.
  expect(await manager.fetchApiToken(true)).toBe(cached);
  expect(calls(fetchMock, "/auth/token/external")).toBe(2);
  await manager.signOut();
  expect(storage.getItem("somun.auth.apiToken.v1")).toBeNull();
});

it("does not adopt another account's stored token", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  const fetchMock = mockAuth(async () => tokenReply("mine"));
  const manager = new AuthManager();
  await manager.restore();
  storage.setItem("somun.auth.apiToken.v1", JSON.stringify(storedSession(jwt("someone-else"), "someone-else")));
  expect(await manager.fetchApiToken()).toBe("mine");
  expect(calls(fetchMock, "/auth/token/external")).toBe(1);
});

it("invalidates an already open tab on logout and does not revive it from another account's cache", async () => {
  const storage = memoryStorage();
  const target = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", target);
  mockAuth(async () => tokenReply(jwt()));
  const first = new AuthManager();
  await first.restore();
  await first.fetchApiToken();
  const second = new AuthManager();
  await second.restore();
  await first.signOut();
  storageEvent(target);
  expect(second.snapshot.status).toBe("signedOut");
  storage.setItem(storageKey, JSON.stringify(storedSession(jwt("other"), "other")));
  await expect(second.fetchApiToken()).rejects.toThrow("session changed");
});

it("ends the old tab's session on account replacement while preserving the new account's cache", async () => {
  const storage = memoryStorage();
  const target = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", target);
  mockAuth(async () => tokenReply(jwt()));
  const manager = new AuthManager();
  await manager.restore();
  await manager.fetchApiToken();
  const replacement = JSON.stringify(storedSession(jwt("other"), "other"));
  storage.setItem(storageKey, replacement);
  storageEvent(target);
  expect(manager.snapshot.status).toBe("signedOut");
  expect(storage.getItem(storageKey)).toBe(replacement);
  await expect(manager.fetchApiToken()).rejects.toThrow("session changed");
});

it.each([
  [jwt("other"), "test-user"],
  [jwt("test-user", Date.now() + 60000), "test-user"],
  [jwt("test-user", Date.now() + 3600000, "another-app"), "test-user"],
  ["malformed", "test-user"],
])("ignores cache with inconsistent identity, expiry or audience", async (value, id) => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(storageKey, JSON.stringify(storedSession(value, id)));
  const fetchMock = mockAuth(async () => tokenReply(jwt()));
  await new AuthManager().restore();
  expect(calls(fetchMock, "/auth/refresh")).toBe(1);
});

it("rejects a renewed JWT for another account instead of pairing it with the old display user", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  mockAuth(async () => tokenReply(jwt("other")));
  const manager = new AuthManager();
  await manager.restore();
  await expect(manager.fetchApiToken()).rejects.toThrow("account changed");
  expect(manager.snapshot.status).toBe("signedOut");
  expect(storage.getItem(storageKey)).toBeNull();
});

it("does not restore an old session when another tab changes accounts during refresh", async () => {
  const storage = memoryStorage();
  const target = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", target);
  let complete!: (value: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (complete = resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const manager = new AuthManager();
  const restoring = manager.restore();
  const replacement = JSON.stringify(storedSession(jwt("other"), "other"));
  storage.setItem(storageKey, replacement);
  storageEvent(target);
  complete(Response.json({ accessToken: "dummy-access" }));
  await restoring;
  expect(manager.snapshot.status).toBe("signedOut");
  expect(storage.getItem(storageKey)).toBe(replacement);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not overwrite the new account's cache with a late issuance for the old account", async () => {
  const storage = memoryStorage();
  const target = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", target);
  let complete!: (value: Response) => void;
  mockAuth(() => new Promise<Response>((resolve) => (complete = resolve)));
  const manager = new AuthManager();
  await manager.restore();
  const pending = manager.fetchApiToken();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  const replacement = JSON.stringify(storedSession(jwt("other"), "other"));
  storage.setItem(storageKey, replacement);
  storageEvent(target);
  complete(tokenReply(jwt()));
  await expect(pending).rejects.toThrow("session changed");
  expect(storage.getItem(storageKey)).toBe(replacement);
  expect(manager.snapshot.status).toBe("signedOut");
});

it.each([429, 503])(
  "does not send collection anonymously or log out after refresh HTTP %s, and recovers on the next request",
  async (status) => {
    const authModule = await import("./manager");
    const { post, UNAUTHORIZED_EVENT } = await import("../api");
    const events = new EventTarget();
    const unauthorized = vi.fn();
    events.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.useFakeTimers();
    const start = Date.now();
    let failed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return failed ? new Response(null, { status }) : Response.json({ accessToken: "access" });
      if (url.endsWith("/auth/me")) return Response.json({ id: "test-user", username: "test" });
      if (url.endsWith("/auth/token/external")) return tokenReply(jwt());
      if (url === "/api/collect") return Response.json({ pending: true });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AuthManager();
    const spy = vi.spyOn(authModule, "getAuthManager").mockReturnValue(manager);
    try {
      await manager.restore();
      await manager.fetchApiToken();
      vi.setSystemTime(start + 3600000);
      failed = true;
      await expect(post("/collect")).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/collect")).toHaveLength(0);
      expect(unauthorized).not.toHaveBeenCalled();
      expect(manager.snapshot.status).toBe("signedIn");
      failed = false;
      expect(await post("/collect")).toEqual({ pending: true });
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/collect")).toHaveLength(1);
      expect(unauthorized).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  },
);

it("identifies an auth network failure before attempting the service request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(new AuthManager().fetchApiToken()).rejects.toThrow("로그인 서버에 연결하지 못했습니다");
});
