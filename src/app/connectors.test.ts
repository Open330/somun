import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { authorizedGithubUser, installationInfo } from "../infra/github/app.js";
import { issueInstallLink, pruneInstallRecords, recordInstallation, recordInstaller, saveGithubApp, setInstallerWaitForTests } from "./connectors.js";
import { ForbiddenError, type AppContext } from "./context.js";

vi.mock("../infra/github/app.js", async (original) => ({ ...await original<typeof import("../infra/github/app.js")>(), installationInfo: vi.fn(), authorizedGithubUser: vi.fn() }));
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

describe("first link needs proof that the requester made the installation", () => {
  const multiUser = () => { ctx.env = { trustedOwners: ["op"] }; setInstallerWaitForTests(0); };
  const withOAuth = () => { ctx.db.delete(schema.appState).run(); saveGithubApp(ctx, { id: 1, pem: "test", slug: "test", client_id: "Iv1.x", client_secret: "s" }); };
  const stateFor = (owner: string) => new URL(issueInstallLink(ctx, owner)!).searchParams.get("state")!;
  const installs = () => ctx.db.select().from(schema.githubInstallations).all();

  it("refuses a bare installation_id, a missing or foreign state, and a missing code", async () => {
    multiUser(); withOAuth();
    await expect(recordInstallation(ctx, "someone", 7)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordInstallation(ctx, "someone", 7, { code: "c", state: stateFor("attacker") })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordInstallation(ctx, "someone", 7, { state: stateFor("someone") })).rejects.toBeInstanceOf(ForbiddenError);
    expect(installs()).toHaveLength(0);
    expect(installationInfo).not.toHaveBeenCalled();
  });

  it("links a personal installation only for the GitHub user who owns it, and each state works once", async () => {
    multiUser(); withOAuth();
    vi.mocked(installationInfo).mockResolvedValue({ id: 7, account: "Alice", accountType: "User", repos: ["alice/repo"] });
    vi.mocked(authorizedGithubUser).mockResolvedValueOnce({ id: 2, login: "mallory" });
    await expect(recordInstallation(ctx, "someone", 7, { code: "c1", state: stateFor("someone") })).rejects.toBeInstanceOf(ForbiddenError);
    const state = stateFor("someone");
    vi.mocked(authorizedGithubUser).mockResolvedValueOnce({ id: 1, login: "alice" });
    await recordInstallation(ctx, "someone", 7, { code: "c2", state });
    expect(installs()[0]?.ownerId).toBe("someone");
    // 이미 이 계정에 연결된 설치의 갱신(webhook)은 확인 없이 된다.
    await recordInstallation(ctx, "someone", 7);
    ctx.db.delete(schema.githubInstallations).run();
    await expect(recordInstallation(ctx, "someone", 7, { code: "c3", state })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("links an organization installation only for the member who installed it (from the webhook)", async () => {
    multiUser(); withOAuth();
    vi.mocked(installationInfo).mockResolvedValue({ id: 8, account: "acme", accountType: "Organization", repos: ["acme/a"] });
    vi.mocked(authorizedGithubUser).mockResolvedValue({ id: 5, login: "member" });
    await expect(recordInstallation(ctx, "someone", 8, { code: "c", state: stateFor("someone") })).rejects.toBeInstanceOf(ForbiddenError);
    recordInstaller(ctx, 8, { id: 9, login: "admin" });
    await expect(recordInstallation(ctx, "someone", 8, { code: "c", state: stateFor("someone") })).rejects.toBeInstanceOf(ForbiddenError);
    recordInstaller(ctx, 8, { id: 5, login: "member" });
    await recordInstallation(ctx, "someone", 8, { code: "c", state: stateFor("someone") });
    expect(installs()[0]?.ownerId).toBe("someone");
  });

  it("refuses when the app has no OAuth client configured, even with a code", async () => {
    multiUser();
    const state = stateFor("someone");
    await expect(recordInstallation(ctx, "someone", 7, { code: "c", state })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets the operator link without proof", async () => {
    multiUser();
    await recordInstallation(ctx, "op", 7);
    expect(installs()[0]?.ownerId).toBe("op");
  });

  it("lets an organization install be retried by reloading when the webhook arrived after the browser", async () => {
    multiUser(); withOAuth();
    vi.mocked(installationInfo).mockResolvedValue({ id: 8, account: "acme", accountType: "Organization", repos: ["acme/a"] });
    vi.mocked(authorizedGithubUser).mockResolvedValue({ id: 5, login: "member" });
    await expect(recordInstallation(ctx, "someone", 8, { code: "c", state: stateFor("someone") })).rejects.toBeInstanceOf(ForbiddenError);
    recordInstaller(ctx, 8, { id: 5, login: "member" });
    // 새로고침: code·state 없이 installation_id만 온다. 30분 안에 확인한 사용자로 다시 판단한다.
    await recordInstallation(ctx, "someone", 8);
    expect(installs()[0]?.ownerId).toBe("someone");
    expect(authorizedGithubUser).toHaveBeenCalledTimes(1);
    expect(ctx.db.select().from(schema.appState).all().filter((r) => r.key.startsWith("pending_link:") || r.key.startsWith("installer:"))).toHaveLength(0);
    // 다른 계정은 그 기록을 쓸 수 없다.
    await expect(recordInstallation(ctx, "other", 9)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("prunes expired states and verification records", () => {
    withOAuth();
    stateFor("someone");
    expect(pruneInstallRecords(ctx, Date.now() + 31 * 60_000)).toBe(1);
    expect(ctx.db.select().from(schema.appState).all().filter((r) => r.key.startsWith("install_state:"))).toHaveLength(0);
  });
});
