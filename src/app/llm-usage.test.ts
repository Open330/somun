import { expect, it, vi } from "vitest";
import { LlmError } from "../infra/llm/providers.js";
import type { AppContext } from "./context.js";
import { recordFailedAttempt, recordLlmUsage, recordLocalUsage } from "./llm-usage.js";

const OWNER = "https://api.jiun.dev|665f00000000000000000001";
const ctxWith = () => { const record = vi.fn(); return { ctx: { usage: { record } } as unknown as AppContext, record }; };

it("reports the call's own latency, omits labels outside the contract, and skips failures already reported per attempt", () => {
  const { ctx, record } = ctxWith();
  recordLlmUsage(ctx, OWNER, { provider: "gemini" }, Date.now() - 60_000, { res: { json: {}, provider: "gemini", model: "m", keyLabel: "free-2", latencyMs: 1234, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } });
  expect(record.mock.calls[0][0]).toMatchObject({ latencyMs: 1234, apiKeyLabel: "free-2", provider: "google", userId: "665f00000000000000000001" });
  recordLlmUsage(ctx, OWNER, { provider: "anthropic" }, Date.now(), { res: { json: {}, provider: "anthropic", model: "c", keyLabel: "byok", latencyMs: 5 } });
  expect(record.mock.calls[1][0].apiKeyLabel).toBeUndefined();
  const reported = new LlmError("503", 503, true); reported.reported = true;
  recordLlmUsage(ctx, OWNER, { provider: "gemini" }, Date.now(), { failedModel: "m", error: reported });
  expect(record).toHaveBeenCalledTimes(2);
  recordLlmUsage(ctx, OWNER, { provider: "gemini" }, Date.now(), { failedModel: "m", error: new Error("network") });
  expect(record.mock.calls[2][0]).toMatchObject({ status: "error", model: "m" });
});

it("records each failed key attempt with its label", () => {
  const { ctx, record } = ctxWith();
  recordFailedAttempt(ctx, OWNER, { model: "gemini-3.7-flash", keyLabel: "free-3", status: 503, startedAt: 1000, latencyMs: 45_000 });
  expect(record.mock.calls[0][0]).toMatchObject({ provider: "google", model: "gemini-3.7-flash", apiKeyLabel: "free-3", status: "error", latencyMs: 45_000, totalTokens: 0 });
});

it("records local CLI usage with the billing vendor and bounded numbers", () => {
  const { ctx, record } = ctxWith();
  recordLocalUsage(ctx, OWNER, [{ provider: "anthropic", model: "claude-opus-5-5", startedAt: 1000, latencyMs: 1849, status: "success", inputTokens: 19927, outputTokens: 8, cachedInputTokens: 99999 }]);
  expect(record.mock.calls[0][0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", inputTokens: 19927, outputTokens: 8, cachedInputTokens: 19927, totalTokens: 19935, status: "success" });
  expect(record.mock.calls[0][0].apiKeyLabel).toBeUndefined();
});

it("does not trust the worker clock", () => {
  const { ctx, record } = ctxWith();
  const now = Date.parse("2026-10-06T12:00:00Z");
  recordLocalUsage(ctx, OWNER, [{ provider: "openai", model: "gpt-5", startedAt: 1e16, latencyMs: 1, status: "success", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }], now);
  expect(record.mock.calls[0][0].occurredAt).toBe("2026-10-06T12:00:00.000Z");
});
