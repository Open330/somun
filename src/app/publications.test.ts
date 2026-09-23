import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { registerPublication, removePublication, updatePublicationUrl } from "./publications.js";

let ctx: AppContext, candidateId: number;
const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ tweet: { likes: 7, retweets: 1, replies: 2 } }), { status: 200 }));
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  vi.stubGlobal("fetch", fetchMock);
  const now = Date.now();
  candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: "me", type: "release", title: "t", repo: "me/tool", key: "k", evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool" }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  ctx.db.insert(schema.changeLedger).values({ ownerId: "me", repo: "me/tool", text: "Adds --watch.", normalized: "adds watch", candidateId, firstSeenAt: now }).run();
});
afterEach(() => { ctx.db.$client.close(); vi.unstubAllGlobals(); fetchMock.mockClear(); });
const ledger = () => ctx.db.select().from(schema.changeLedger).get()!;

it("undoes the ledger's 'already announced' mark when the only publication is removed", () => {
  const id = registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  expect(ledger().publishedChannel).toBe("x");
  removePublication(ctx, "me", id);
  expect(ledger()).toMatchObject({ publishedAt: null, publishedChannel: null });
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
});

it("keeps the ledger pointing at a remaining publication", () => {
  registerPublication(ctx, "me", { candidateId, channel: "show_hn", url: "https://news.ycombinator.com/item?id=1" });
  const second = registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  removePublication(ctx, "me", second);
  expect(ledger().publishedChannel).toBe("show_hn");
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it("refetches reactions for the corrected URL even on an old publication", async () => {
  const id = Number(ctx.db.insert(schema.publications).values({ ownerId: "me", candidateId, channel: "x", url: "https://x.com/me/status/1", publishedAt: Date.now() - 90 * 86_400_000, autoStats: { likes: 1, source: "fxtwitter" } }).run().lastInsertRowid);
  updatePublicationUrl(ctx, "me", id, "https://x.com/me/status/2");
  await vi.waitFor(() => expect(ctx.db.select().from(schema.publications).get()?.autoStats).toMatchObject({ likes: 7 }));
  expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/status/2");
});
