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
it("preserves the populated previous workspace without copying settings or changing owner IDs", () => {
  ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|old`, data: { marker: "preserved" }, updatedAt: 1 }).run();
  const resolve = createAccountOwnerResolver(ctx);
  expect(resolve(issuer, "current", ["old"])).toBe(`${issuer}|old`);
  expect(resolve(issuer, "current", ["old", "old"])).toBe(`${issuer}|old`);
  expect(resolve(issuer, "new", [])).toBe(`${issuer}|new`);
  expect(resolve("https://another-issuer.example", "current", ["old"])).toBe("https://another-issuer.example|current");
  expect(ctx.db.select().from(schema.settings).all()).toHaveLength(1);
});
it("rejects ambiguous populated workspaces and leaves both unchanged", () => {
  for (const id of ["current", "old"]) ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|${id}`, data: { marker: id }, updatedAt: 1 }).run();
  expect(() => createAccountOwnerResolver(ctx)(issuer, "current", ["old"])).toThrow("Both linked accounts");
  expect(ctx.db.select().from(schema.settings).all()).toHaveLength(2);
});
it("detects separate workspaces even when their data is in different tables", () => {
  ctx.db.insert(schema.settings).values({ ownerId: `${issuer}|old`, data: {}, updatedAt: 1 }).run();
  ctx.db.insert(schema.sources).values({ ownerId: `${issuer}|current`, kind: "github", targets: ["example/project"] }).run();
  expect(() => createAccountOwnerResolver(ctx)(issuer, "current", ["old"])).toThrow("Both linked accounts");
  expect(ctx.db.select().from(schema.sources).all()).toHaveLength(1);
  expect(ctx.db.select().from(schema.settings).all()).toHaveLength(1);
});
