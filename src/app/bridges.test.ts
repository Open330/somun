import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb } from "../infra/db/index.js";
import type { VideoClient } from "../infra/video.js";
import type { BridgeStatus } from "../shared/video.js";
import { deleteAccount } from "./account.js";
import { GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "./context.js";
import { issueBridgeToken, listBridgeTokens, revokeBridgeToken, videoConfig } from "./bridges.js";

function setup() {
  const video = {
    publicUrl: "http://192.168.32.55:8791", pushed: [] as { id: string; owner: string; tokenHash: string }[][], down: false, seen: new Map<string, number>(),
    async putBridgeTokens(tokens: { id: string; owner: string; tokenHash: string }[]) { if (video.down) throw new Error("down"); video.pushed.push(tokens); },
    async bridgeStatus(owner: string): Promise<BridgeStatus[]> { return (video.pushed.at(-1) ?? []).filter((t) => t.owner === owner).map((t) => ({ id: t.id, owner, lastSeenAt: video.seen.get(t.id), connected: video.seen.has(t.id) })); },
  };
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { video: video as unknown as VideoClient }, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
  return { ctx, video };
}

describe("bridge tokens", () => {
  it("issues a token once, registers only its hash, and shows connection state per owner", async () => {
    const { ctx, video } = setup();
    const a = await issueBridgeToken(ctx, "a", "맥북");
    await issueBridgeToken(ctx, "b", "other");
    expect(a.token).toMatch(/^smb_/);
    const pushed = video.pushed.at(-1)!;
    expect(pushed.map((t) => t.owner).sort()).toEqual(["a", "b"]);
    expect(pushed.find((t) => t.id === a.id)?.tokenHash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(JSON.stringify(video.pushed)).not.toContain(a.token);
    expect(await videoConfig(ctx, "a")).toEqual({ enabled: true, bridgeUrl: "http://192.168.32.55:8791", bridgeConnected: false });
    video.seen.set(a.id, Date.now());
    expect(await listBridgeTokens(ctx, "a")).toMatchObject([{ id: a.id, label: "맥북", connected: true }]);
    expect((await videoConfig(ctx, "a")).bridgeConnected).toBe(true);
    expect(await listBridgeTokens(ctx, "b")).toMatchObject([{ label: "other", connected: false }]);
  });

  it("revokes only the owner's token and drops it from the video server list", async () => {
    const { ctx, video } = setup();
    const a = await issueBridgeToken(ctx, "a", "x");
    await expect(revokeBridgeToken(ctx, "b", a.id)).rejects.toThrow(NotFoundError);
    expect(await revokeBridgeToken(ctx, "a", a.id)).toEqual({ synced: true });
    expect(video.pushed.at(-1)).toEqual([]);
    expect(await listBridgeTokens(ctx, "a")).toEqual([]);
  });

  it("does not issue a token the video server did not accept, and limits active tokens", async () => {
    const { ctx, video } = setup();
    video.down = true;
    await expect(issueBridgeToken(ctx, "a", "x")).rejects.toThrow(UnavailableError);
    expect(await listBridgeTokens(ctx, "a")).toEqual([]);
    video.down = false;
    for (let i = 0; i < 5; i++) await issueBridgeToken(ctx, "a", `t${i}`);
    await expect(issueBridgeToken(ctx, "a", "t6")).rejects.toThrow(GenerationConflictError);
  });

  it("removes tokens with the account and syncs the video server", async () => {
    const { ctx, video } = setup();
    await issueBridgeToken(ctx, "a", "x");
    expect(deleteAccount(ctx, "a").bridge_tokens).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(video.pushed.at(-1)).toEqual([]);
  });
});
