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
