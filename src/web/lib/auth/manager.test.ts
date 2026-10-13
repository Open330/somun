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
