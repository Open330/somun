import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { deleteAccount, exportAccount } from "./account.js";

function makeCtx(): AppContext {
  return { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
}

describe("account export/delete", () => {
  it("exports only the owner's rows without secrets and deletes only them", () => {
    const ctx = makeCtx(); const now = Date.now();
    ctx.db.insert(schema.settings).values({ ownerId: "a", data: { llm: { provider: "gemini", apiKey: "sk-secret" }, notify: { weekly: true, discordWebhookUrl: "https://discord.com/api/webhooks/x" } }, updatedAt: now }).run();
    ctx.db.insert(schema.candidates).values({ ownerId: "a", type: "release", title: "t", repo: "a/x", key: "repo:a/x:2026-09-21", evidence: {}, status: "new", createdAt: now, updatedAt: now }).run();
    ctx.db.insert(schema.candidates).values({ ownerId: "b", type: "release", title: "t", repo: "b/y", key: "repo:b/y:2026-09-21", evidence: {}, status: "new", createdAt: now, updatedAt: now }).run();
    const ex = exportAccount(ctx, "a") as { settings: { data: { llm: { apiKey?: string }; notify: { discordWebhookUrl?: string } } }[]; candidates: unknown[] };
    expect(ex.candidates).toHaveLength(1);
    expect(ex.settings[0].data.llm.apiKey).toBeUndefined();
    expect(ex.settings[0].data.notify.discordWebhookUrl).toBeUndefined();
    const counts = deleteAccount(ctx, "a");
    expect(counts.candidates).toBe(1);
    expect(ctx.db.select().from(schema.candidates).all()).toHaveLength(1);
  });
});
