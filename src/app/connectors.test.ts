import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { installationInfo, userCanAccessInstallation } from "../infra/github/app.js";
import { recordInstallation, saveGithubApp } from "./connectors.js";
import { ForbiddenError, type AppContext } from "./context.js";

vi.mock("../infra/github/app.js", async (original) => ({ ...await original<typeof import("../infra/github/app.js")>(), installationInfo: vi.fn(), userCanAccessInstallation: vi.fn() }));
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

describe("first link needs proof of access to the installation", () => {
  const multiUser = () => { ctx.env = { trustedOwners: ["op"] }; };
  const withOAuth = () => { ctx.db.delete(schema.appState).run(); saveGithubApp(ctx, { id: 1, pem: "test", slug: "test", client_id: "Iv1.x", client_secret: "s" }); };

  it("refuses a bare installation_id from a non-operator account", async () => {
    multiUser(); withOAuth();
    await expect(recordInstallation(ctx, "someone", 7)).rejects.toBeInstanceOf(ForbiddenError);
    expect(ctx.db.select().from(schema.githubInstallations).all()).toHaveLength(0);
    expect(installationInfo).not.toHaveBeenCalled();
  });

  it("refuses when the app has no OAuth client configured, even with a code", async () => {
    multiUser();
    await expect(recordInstallation(ctx, "someone", 7, { code: "c" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("links only when the GitHub user behind the code can access the installation", async () => {
    multiUser(); withOAuth();
    vi.mocked(userCanAccessInstallation).mockResolvedValueOnce(false);
    await expect(recordInstallation(ctx, "someone", 7, { code: "c1" })).rejects.toBeInstanceOf(ForbiddenError);
    vi.mocked(userCanAccessInstallation).mockResolvedValueOnce(true);
    await recordInstallation(ctx, "someone", 7, { code: "c2" });
    expect(userCanAccessInstallation).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: "Iv1.x" }), "c2", 7);
    expect(ctx.db.select().from(schema.githubInstallations).get()?.ownerId).toBe("someone");
    // 이미 연결된 설치의 갱신은 확인 없이 된다(설정 변경 뒤 콜백, webhook).
    await recordInstallation(ctx, "someone", 7);
  });

  it("lets the operator link without a code", async () => {
    multiUser();
    await recordInstallation(ctx, "op", 7);
    expect(ctx.db.select().from(schema.githubInstallations).get()?.ownerId).toBe("op");
  });
});
