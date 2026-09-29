import { afterEach, expect, it, vi } from "vitest";
import { runLlm } from "./providers.js";
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
it("waits out a short demand spike on the draft model before falling back, but not for analysis", async () => {
  vi.useFakeTimers();
  try {
    const ok = (model: string) => new Response(JSON.stringify({ model, choices: [{ message: { content: '{"title":"","body":"ok"}' } }] }), { status: 200 });
    const busy = () => new Response('{"error":{"code":503,"message":"overloaded"}}', { status: 503 });
    let flashCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      if (model === "gemini-3.7-flash") return ++flashCalls <= 3 ? busy() : ok(model);
      return ok(model);
    }));
    const draft = runLlm({ provider: "gemini" }, prompt, "draft", undefined, '{"free-1":"test"}', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await draft).model).toBe("gemini-3.7-flash");

    flashCalls = 0;
    const judged = runLlm({ provider: "gemini", draftModel: "gemini-3.7-flash" }, prompt, "judge", undefined, '{"free-1":"test"}', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await judged).model).not.toBe("gemini-3.7-flash");
  } finally { vi.useRealTimers(); }
});
