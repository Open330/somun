// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDraftReview } from "./useDraftReview";

const { patch } = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./api", () => ({ patch }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  patch.mockClear();
});

it("pauses review timing outside the active window and uses cumulative checkpoints", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  let focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  const view = renderHook(() => useDraftReview(3));
  expect(patch).toHaveBeenLastCalledWith("/drafts/3/review", expect.objectContaining({ activeSeconds: 0 }));
  const sessionId = patch.mock.calls[0][1].sessionId;
  act(() => {
    vi.advanceTimersByTime(20000);
    focused = false;
    window.dispatchEvent(new Event("blur"));
  });
  expect(patch).toHaveBeenLastCalledWith("/drafts/3/review", { sessionId, activeSeconds: 20 });
  act(() => vi.advanceTimersByTime(30000));
  expect(patch).toHaveBeenLastCalledWith("/drafts/3/review", { sessionId, activeSeconds: 20 });
  act(() => {
    focused = true;
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(10000);
  });
  await view.result.current();
  expect(patch).toHaveBeenLastCalledWith("/drafts/3/review", { sessionId, activeSeconds: 30 });
  view.unmount();
});

it("uses a new session for another draft and treats checkpoint failure as non-blocking", async () => {
  patch.mockRejectedValue(new Error("offline"));
  const view = renderHook(({ id }) => useDraftReview(id), { initialProps: { id: 1 } });
  const first = patch.mock.calls[0][1].sessionId;
  view.rerender({ id: 2 });
  expect(patch.mock.calls.at(-1)?.[0]).toBe("/drafts/2/review");
  expect(patch.mock.calls.at(-1)?.[1].sessionId).not.toBe(first);
  await expect(view.result.current()).resolves.toBeUndefined();
  view.unmount();
  patch.mockResolvedValue(undefined);
});
