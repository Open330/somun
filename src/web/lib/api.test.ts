// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearResourceCache, endSession, REFETCH_DEBOUNCE_MS, useResource } from "./api";
import { resetEvents } from "./events";

const { listeners } = vi.hoisted(() => ({ listeners: new Set<(ev: { resource: string }) => void>() }));
vi.mock("./events", () => ({ subscribeEvents: (l: (ev: { resource: string }) => void) => { listeners.add(l); return () => listeners.delete(l); }, resetEvents: vi.fn() }));
vi.mock("./auth/manager", () => ({ getAuthManager: () => null }));
afterEach(() => { cleanup(); clearResourceCache(); listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); });

it("ignores an older response even if fetch does not honor cancellation", async () => {
  const pending: { resolve: (res: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve) => pending.push({ resolve, signal: init.signal }))));
  const { result, rerender } = renderHook(({ path }) => useResource<{ id: number }>(path, []), { initialProps: { path: "/old" } });
  await waitFor(() => expect(pending).toHaveLength(1));
  rerender({ path: "/new" });
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => { pending[1].resolve(new Response('{"id":2}')); });
  await waitFor(() => expect(result.current.data).toEqual({ id: 2 }));
  await act(async () => { pending[0].resolve(new Response('{"id":1}')); });
  expect(result.current.data).toEqual({ id: 2 });
});

it("aborts in-flight requests on unmount and clears data for a null path", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init) => { signals.push(init.signal); return url.endsWith("/done") ? Promise.resolve(new Response('{"id":1}')) : new Promise<Response>(() => {}); }));
  const { result, rerender, unmount } = renderHook(({ path }: { path: string | null }) => useResource(path, []), { initialProps: { path: "/done" as string | null } });
  await waitFor(() => expect(result.current.data).toEqual({ id: 1 }));
  rerender({ path: "/one" });
  await waitFor(() => expect(signals).toHaveLength(2));
  rerender({ path: null });
  expect(result.current.data).toBeUndefined();
  expect(signals[1].aborted).toBe(true);
  rerender({ path: "/two" });
  await waitFor(() => expect(signals).toHaveLength(3));
  unmount();
  expect(signals[2].aborted).toBe(true);
});


it.each(["network", "http"])("keeps session client state when logout fails: %s", async (failure) => {
  localStorage.setItem("somun.token", "test-token");
  const fetchMock = failure === "network" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(endSession()).rejects.toThrow();
  expect(resetEvents).not.toHaveBeenCalled();
  expect(localStorage.getItem("somun.token")).toBe("test-token");
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  await endSession();
  expect(resetEvents).toHaveBeenCalledOnce();
  expect(localStorage.getItem("somun.token")).toBeNull();
});

describe("shared resource cache", () => {
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

  it("sends one request when several screens open the same resource", async () => {
    const fetchMock = vi.fn(() => json([{ id: 1 }]));
    vi.stubGlobal("fetch", fetchMock);
    const a = renderHook(() => useResource<{ id: number }[]>("/candidates", ["candidates"]));
    const b = renderHook(() => useResource<{ id: number }[]>("/candidates", ["candidates"]));
    await waitFor(() => expect(b.result.current.data).toEqual([{ id: 1 }]));
    expect(a.result.current.data).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows the cached data at once when a screen comes back, then refreshes it", async () => {
    let n = 0;
    const fetchMock = vi.fn(() => json({ n: ++n }));
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useResource<{ n: number }>("/settings", ["settings"]));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    first.unmount();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    const again = renderHook(() => useResource<{ n: number }>("/settings", ["settings"]));
    expect(again.result.current.data).toEqual({ n: 1 });
    await waitFor(() => expect(again.result.current.data).toEqual({ n: 2 }));
  });

  it("refetches once per burst of change events, however many screens listen", async () => {
    const fetchMock = vi.fn(() => json([]));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useResource("/candidates", ["candidates", "drafts"]));
    renderHook(() => useResource("/candidates", ["candidates"]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => { for (const l of [...listeners]) { l({ resource: "drafts" }); l({ resource: "candidates" }); } });
    await new Promise((r) => setTimeout(r, REFETCH_DEBOUNCE_MS + 50));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => { for (const l of [...listeners]) l({ resource: "sources" }); });
    await new Promise((r) => setTimeout(r, REFETCH_DEBOUNCE_MS + 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forgets cached data when the session ends", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/session") ? Promise.resolve(new Response(null, { status: 204 })) : json({ owner: "a" })));
    const first = renderHook(() => useResource<{ owner: string }>("/me", []));
    await waitFor(() => expect(first.result.current.data).toEqual({ owner: "a" }));
    first.unmount();
    await endSession();
    const next = renderHook(() => useResource<{ owner: string }>("/me", []));
    expect(next.result.current.data).toBeUndefined();
  });
});
