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

it("goes straight to the default model while the draft model is known to be failing", async () => {
  const called: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string;
    called.push(model);
    return new Response(JSON.stringify({ model, choices: [{ message: { content: '{"title":"","body":"ok"}' } }] }), { status: 200 });
  }));
  const pool = { order: async (labels: string[]) => labels, report: async () => {}, unavailable: async (model: string) => model === "gemini-3.7-flash" };
  const res = await runLlm({ provider: "gemini", draftModel: "gemini-3.7-flash" }, prompt, "draft", pool, '{"free-1":"test"}', new AbortController().signal);
  expect(called).not.toContain("gemini-3.7-flash");
  expect(res.model).not.toBe("gemini-3.7-flash");
  vi.unstubAllGlobals();
});

it("falls back to the default model when slow 503s use up the upper-model budget", async () => {
  vi.useFakeTimers();
  try {
    const called: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      called.push(model);
      if (model === "gemini-3.7-flash") {
        await new Promise((r) => setTimeout(r, 40_000));
        return new Response('{"error":{"code":503,"message":"overloaded"}}', { status: 503 });
      }
      return new Response(JSON.stringify({ model, choices: [{ message: { content: '{"title":"","body":"ok"}' } }] }), { status: 200 });
    }));
    const draft = runLlm({ provider: "gemini", draftModel: "gemini-3.7-flash" }, prompt, "draft", undefined, '{"free-1":"test"}', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await draft;
    expect(res.model).not.toBe("gemini-3.7-flash");
    // 40초짜리 503 두 번(약 85초)이면 넘어간다. 네 바퀴를 다 기다리지 않는다.
    expect(called.filter((m) => m === "gemini-3.7-flash").length).toBeLessThanOrEqual(2);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
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
