import { afterEach, expect, it, vi } from "vitest";
import { modelFor, runLlm } from "./providers.js";
const prompt = { system: "test", user: "test", schema: { type: "object" }, schemaName: "draft" };
afterEach(() => vi.unstubAllGlobals());
it("cancels a stalled provider request when the generation deadline expires", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetcher);
  const request = runLlm({ provider: "openai", apiKey: "test", model: "test" }, prompt, "draft", undefined, undefined, controller.signal);
  const rejected = expect(request).rejects.toThrow("deadline");
  controller.abort(new DOMException("deadline", "TimeoutError"));
  await rejected;
  expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
});
it("does not call a provider after the shared retry deadline has already expired", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const signal = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
  await expect(runLlm({ provider: "gemini" }, prompt, "draft", undefined, '{"free-1":"test"}', signal)).rejects.toThrow("deadline");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["digest", "judge", "draft"] as const)("pins Gemini %s despite stored overrides, including BYOK", async (kind) => {
  const config = { provider: "gemini" as const, model: "gemini-3.7-flash", draftModel: "gemini-3.7-flash" };
  expect(modelFor(config, kind)).toBe("gemini-3.5-flash-lite");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"body":"ok"}' } }] })));
  vi.stubGlobal("fetch", fetcher);
  await runLlm(config, prompt, kind, undefined, '{"free-1":"dummy"}');
  const personal = {
    ...config,
    apiKey: "dummy",
  };
  await runLlm(personal, prompt, kind);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).model === "gemini-3.5-flash-lite")).toBe(true);
});

it("retries an overloaded Gemini model without switching to a different model", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async () => new Response('{"error":{"code":503}}', { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const pending = runLlm({ provider: "gemini", draftModel: "gemini-3.7-flash" }, prompt, "draft", undefined, '{"free-1":"dummy"}').catch(e => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await pending).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).model === "gemini-3.5-flash-lite")).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("reports every failed key attempt and marks the final error as already reported", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"code":429,"message":"quota"}}', { status: 429 })));
  const attempts: { keyLabel?: string; status?: number }[] = [];
  const pending = runLlm({ provider: "gemini" }, prompt, "judge", undefined, '{"free-1":"a","free-2":"b"}', new AbortController().signal, { onAttemptFailed: (a) => attempts.push(a) }).catch((e) => e);
  await vi.advanceTimersByTimeAsync(60_000);
  const err = await pending;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(attempts.map((a) => a.keyLabel))).toEqual(new Set(["free-1", "free-2"]));
  expect(attempts.every((a) => a.status === 429)).toBe(true);
  expect((err as { reported?: boolean }).reported).toBe(true);
});
