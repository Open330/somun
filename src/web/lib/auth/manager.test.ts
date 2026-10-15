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
  expect(await pending).toBeNull();
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

it("reuses a stored API token across page loads and tabs without calling jiun-api", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  const fetchMock = mockAuth(async () => tokenReply("test-api"));
  const first = new AuthManager();
  await first.restore();
  expect(await first.fetchApiToken()).toBe("test-api");
  expect([calls(fetchMock, "/auth/refresh"), calls(fetchMock, "/auth/me"), calls(fetchMock, "/auth/token/external")]).toEqual([1, 1, 1]);
  // 새로고침·새 탭: 저장된 토큰과 계정으로 바로 시작한다.
  const second = new AuthManager();
  await second.restore();
  expect(second.snapshot).toEqual({ status: "signedIn", user: expect.objectContaining({ id: "test-user" }) });
  expect(await second.fetchApiToken()).toBe("test-api");
  expect([calls(fetchMock, "/auth/refresh"), calls(fetchMock, "/auth/me"), calls(fetchMock, "/auth/token/external")]).toEqual([1, 1, 1]);
});

it("ignores a stored token close to expiry, and drops it on a forced refresh and on logout", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(
    "somun.auth.apiToken.v1",
    JSON.stringify({ token: "old", expiresAt: Date.now() + 60_000, user: { id: "test-user", username: "test" } }),
  );
  const fetchMock = mockAuth(async () => tokenReply("fresh"));
  const manager = new AuthManager();
  await manager.restore();
  expect(calls(fetchMock, "/auth/refresh")).toBe(1);
  expect(await manager.fetchApiToken()).toBe("fresh");
  expect(JSON.parse(storage.getItem("somun.auth.apiToken.v1")!).token).toBe("fresh");
  // 401 뒤의 강제 갱신은 저장된 토큰을 쓰지 않는다.
  expect(await manager.fetchApiToken(true)).toBe("fresh");
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
  storage.setItem(
    "somun.auth.apiToken.v1",
    JSON.stringify({ token: "theirs", expiresAt: Date.now() + 3600_000, user: { id: "someone-else", username: "x" } }),
  );
  expect(await manager.fetchApiToken()).toBe("mine");
  expect(calls(fetchMock, "/auth/token/external")).toBe(1);
});
