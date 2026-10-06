import { expect, it } from "vitest";
import { claudeUsage, codexModelFrom, codexUsage, mainModel } from "./agent-usage.js";

it("reads per-model tokens from Claude Code JSON output, counting cache reads and writes as input", () => {
  const out = { duration_api_ms: 1849, modelUsage: { "claude-opus-5-5": { inputTokens: 2, outputTokens: 8, cacheReadInputTokens: 10084, cacheCreationInputTokens: 9841 } } };
  expect(claudeUsage(out, 1000)).toEqual([{ provider: "anthropic", model: "claude-opus-5-5", startedAt: 1000, latencyMs: 1849, status: "success", inputTokens: 19927, outputTokens: 8, cachedInputTokens: 10084 }]);
  expect(claudeUsage({}, 1000)).toEqual([]);
});

it("sums Codex turn usage, where input already includes cached tokens", () => {
  const lines = [{ type: "thread.started" }, { type: "turn.completed", usage: { input_tokens: 15144, cached_input_tokens: 12160, output_tokens: 9 } }];
  expect(codexUsage(lines, "gpt-5", 1000, 3000)).toEqual([{ provider: "openai", model: "gpt-5", startedAt: 1000, latencyMs: 3000, status: "success", inputTokens: 15144, outputTokens: 9, cachedInputTokens: 12160 }]);
});

it("picks the model that wrote the answer and reads only the top-level Codex model", () => {
  expect(mainModel({ "claude-haiku-4-5": { outputTokens: 3 }, "claude-opus-5-5": { outputTokens: 400 } })).toBe("claude-opus-5-5");
  expect(mainModel(undefined)).toBeUndefined();
  expect(codexModelFrom('model = "gpt-5"\n[profiles.fast]\nmodel = "gpt-5-mini"\n')).toBe("gpt-5");
  expect(codexModelFrom('[profiles.fast]\nmodel = "gpt-5-mini"\n')).toBe("codex");
});
