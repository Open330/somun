import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb, schema } from "../infra/db/index.js";
import { createAccountOwnerResolver } from "./account-owner.js";

let ctx: AppContext;
const issuer = "https://api.jiun.dev";
beforeEach(() => { ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] }; });
afterEach(() => { ctx.db.$client.close(); });
it("preserves legacy content and default after the primary workspace gets data", () => {
  ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|old`, data: { marker: "preserved" }, updatedAt: 1 }).run();
  const resolve = createAccountOwnerResolver(ctx);
  expect(resolve(issuer, "current", ["old"]).ownerId).toBe(`${issuer}|old`);
  ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|current`, data: { marker: "new" }, updatedAt: 1 }).run();
  expect(resolve(issuer, "current", ["old", "old"]).ownerId).toBe(`${issuer}|old`);
  expect(resolve(issuer, "new", []).ownerId).toBe(`${issuer}|new`);
  expect(resolve("https://another-issuer.example", "current", ["old"]).ownerId).toBe("https://another-issuer.example|current");
  expect(ctx.db.select().from(schema.settings).all().map(row => row.data)).toEqual([{ marker: "preserved" }, { marker: "new" }]);
});
it("describes and selects separate workspaces whose data live in different tables", () => {
  ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|old`, data: {}, updatedAt: 1 }).run();
  ctx.db.insert(schema.sources).values({ ownerId: `${issuer}|current`, kind: "github", targets: ["example/project"] }).run();
  const resolve = createAccountOwnerResolver(ctx);
  expect(resolve(issuer, "current", ["old", "empty"], `${issuer}|current`, true)).toEqual({
    accountId: `${issuer}|current`, ownerId: `${issuer}|current`, workspaces: [
      { ownerId: `${issuer}|current`, primary: true, hasData: true },
      { ownerId: `${issuer}|empty`, primary: false, hasData: false },
      { ownerId: `${issuer}|old`, primary: false, hasData: true },
    ],
  });
  for (const selected of [`${issuer}|stranger`, "https://evil.example|old", "old"]) expect(() => resolve(issuer, "current", ["old"], selected)).toThrow("not linked");
  expect(ctx.db.select().from(schema.sources).all()).toHaveLength(1);
  expect(ctx.db.select().from(schema.settings).all()).toHaveLength(1);
});
