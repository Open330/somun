import { EventEmitter } from "node:events";
import pino from "pino";
import { expect, it } from "vitest";
import { openDb } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { getSettingsView, updateSettings } from "./settings.js";

it("reports model credentials without exposing server keys or confusing providers", () => {
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
  try {
    expect(getSettingsView(ctx, "a").llm.credentialsConfigured).toBe(false);
    ctx.env.geminiKeys = JSON.stringify({ "paid-1": "paid-secret" });
    expect(getSettingsView(ctx, "a").llm.credentialsConfigured).toBe(false);
    ctx.env.geminiKeys = JSON.stringify({ "free-1": "server-secret" });
    const view = getSettingsView(ctx, "a");
    expect(view.llm.credentialsConfigured).toBe(true);
    expect(view.llm.apiKeySet).toBe(false);
    expect(JSON.stringify(view)).not.toContain("server-secret");
    expect(updateSettings(ctx, "a", { llm: { provider: "openai" } }).llm.credentialsConfigured).toBe(false);
    expect(updateSettings(ctx, "a", { llm: { provider: "anthropic", apiKey: "user-secret" } }).llm.credentialsConfigured).toBe(true);
    expect(updateSettings(ctx, "a", { llm: { provider: "local-agent" } }, false).llm.credentialsConfigured).toBe(true);
  } finally { ctx.db.$client.close(); }
});

it("rejects a defer threshold above the draft threshold", () => {
  const ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } } as unknown as AppContext;
  expect(() => updateSettings(ctx, "me", { deferThreshold: 7 })).toThrow("보류 기준");
  expect(updateSettings(ctx, "me", { draftThreshold: 8, deferThreshold: 7 }).deferThreshold).toBe(7);
});
