import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { installationInfo } from "../infra/github/app.js";
import { recordInstallation, saveGithubApp } from "./connectors.js";
import type { AppContext } from "./context.js";

vi.mock("../infra/github/app.js", async (original) => ({ ...await original<typeof import("../infra/github/app.js")>(), installationInfo: vi.fn() }));
let ctx: AppContext;
beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", ""); vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
  saveGithubApp(ctx, { id: 1, pem: "test", slug: "test" });
  vi.mocked(installationInfo).mockResolvedValue({ id: 7, account: "test", accountType: "User", repos: ["test/repo"] });
});
afterEach(() => { ctx.db.$client.close(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("allows the same owner to refresh but refuses ownership transfer", async () => {
  await recordInstallation(ctx, "owner", 7);
  await recordInstallation(ctx, "owner", 7);
  await expect(recordInstallation(ctx, "other", 7)).rejects.toThrow("다른 계정");
  expect(ctx.db.select().from(schema.githubInstallations).get()?.ownerId).toBe("owner");
  expect(ctx.db.select().from(schema.sources).all()).toHaveLength(1);
  expect(installationInfo).toHaveBeenCalledTimes(2);
});
it("cannot overwrite ownership established while GitHub lookup was in flight", async () => {
  vi.mocked(installationInfo).mockImplementationOnce(async () => {
    ctx.db.insert(schema.githubInstallations).values({ installationId: 7, ownerId: "other", account: "test", accountType: "User", repos: [], createdAt: 1, updatedAt: 1 }).run();
    return { id: 7, account: "test", accountType: "User", repos: [] };
  });
  await expect(recordInstallation(ctx, "owner", 7)).rejects.toThrow("다른 계정");
  expect(ctx.db.select().from(schema.githubInstallations).get()?.ownerId).toBe("other");
  expect(ctx.db.select().from(schema.sources).all()).toHaveLength(0);
});
