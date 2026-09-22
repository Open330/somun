// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResource } from "./api";

vi.mock("./events", () => ({ subscribeEvents: () => () => {}, resetEvents: vi.fn() }));
vi.mock("./auth/manager", () => ({ getAuthManager: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  vi.stubGlobal("fetch", vi.fn((_url, init) => { signals.push(init.signal); return Promise.resolve(new Response('{"id":1}')); }));
  const { result, rerender, unmount } = renderHook(({ path }: { path: string | null }) => useResource(path, []), { initialProps: { path: "/one" as string | null } });
  await waitFor(() => expect(result.current.data).toEqual({ id: 1 }));
  rerender({ path: null });
  expect(result.current.data).toBeUndefined();
  expect(signals[0].aborted).toBe(true);
  rerender({ path: "/two" });
  await waitFor(() => expect(signals).toHaveLength(2));
  unmount();
  expect(signals[1].aborted).toBe(true);
});
