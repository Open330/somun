import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { BridgeStatus, BridgeTokenView, VideoConfigView } from "../shared/video.js";
import { GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "./context.js";

/**
 * 영상 bridge 토큰. 사용자마다 자기 컴퓨터의 Claude Code를 영상 서버에 붙일 때 쓴다.
 * 원문은 발급 응답에만 있고, somun은 해시만 둔다. 유효한 해시 목록을 영상 서버에 통째로 보내 맞춘다.
 */
const MAX_ACTIVE_PER_OWNER = 5;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** 모든 소유자의 유효 토큰을 영상 서버에 보낸다. 서버 시작 때와 발급·폐기·계정 삭제 뒤에 부른다. */
export async function syncBridgeTokens(ctx: AppContext): Promise<void> {
  const client = ctx.env.video;
  if (!client) return;
  const rows = ctx.db.select().from(schema.bridgeTokens).where(isNull(schema.bridgeTokens.revokedAt)).all();
  await client.putBridgeTokens(rows.map((r) => ({ id: r.id, owner: r.ownerId, tokenHash: r.tokenHash })));
}

async function statusFor(ctx: AppContext, ownerId: string): Promise<BridgeStatus[]> {
  return ctx.env.video ? ctx.env.video.bridgeStatus(ownerId).catch(() => []) : [];
}

export async function videoConfig(ctx: AppContext, ownerId: string): Promise<VideoConfigView> {
  const client = ctx.env.video;
  if (!client) return { enabled: false };
  const status = await statusFor(ctx, ownerId);
  return { enabled: true, bridgeUrl: client.publicUrl, bridgeConnected: status.some((s) => s.connected) };
}

export async function listBridgeTokens(ctx: AppContext, ownerId: string): Promise<BridgeTokenView[]> {
  const rows = ctx.db.select().from(schema.bridgeTokens).where(and(eq(schema.bridgeTokens.ownerId, ownerId), isNull(schema.bridgeTokens.revokedAt))).all();
  const status = new Map((await statusFor(ctx, ownerId)).map((s) => [s.id, s]));
  return rows.sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastSeenAt: status.get(r.id)?.lastSeenAt, connected: status.get(r.id)?.connected ?? false }));
}

/** 새 토큰. 원문(token)은 이 응답에서만 볼 수 있다. 영상 서버에 등록되지 않으면 발급하지 않은 것으로 되돌린다. */
export async function issueBridgeToken(ctx: AppContext, ownerId: string, label: string): Promise<{ id: string; token: string; label: string }> {
  if (!ctx.env.video) throw new NotFoundError("video server");
  const active = ctx.db.select().from(schema.bridgeTokens).where(and(eq(schema.bridgeTokens.ownerId, ownerId), isNull(schema.bridgeTokens.revokedAt))).all();
  if (active.length >= MAX_ACTIVE_PER_OWNER) throw new GenerationConflictError(`at most ${MAX_ACTIVE_PER_OWNER} bridge tokens; revoke one first`);
  const id = randomBytes(6).toString("base64url");
  const token = `smb_${randomBytes(24).toString("base64url")}`;
  const clean = label.trim().slice(0, 60) || "bridge";
  ctx.db.insert(schema.bridgeTokens).values({ id, ownerId, label: clean, tokenHash: hash(token), createdAt: Date.now() }).run();
  try {
    await syncBridgeTokens(ctx);
  } catch (err) {
    ctx.db.delete(schema.bridgeTokens).where(eq(schema.bridgeTokens.id, id)).run();
    ctx.log.warn({ err: (err as Error).message }, "bridge token sync failed");
    throw new UnavailableError("the video server is not reachable");
  }
  return { id, token, label: clean };
}

/** 폐기는 somun에 먼저 남긴다. 영상 서버에 닿지 않으면 다음 동기화(서버 시작, 다른 발급·폐기) 때 빠진다. */
export async function revokeBridgeToken(ctx: AppContext, ownerId: string, id: string): Promise<{ synced: boolean }> {
  const row = ctx.db.select().from(schema.bridgeTokens).where(and(eq(schema.bridgeTokens.id, id), eq(schema.bridgeTokens.ownerId, ownerId), isNull(schema.bridgeTokens.revokedAt))).get();
  if (!row) throw new NotFoundError("bridge token");
  ctx.db.update(schema.bridgeTokens).set({ revokedAt: Date.now() }).where(eq(schema.bridgeTokens.id, id)).run();
  try {
    await syncBridgeTokens(ctx);
    return { synced: true };
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, "bridge token sync failed after revoke");
    return { synced: false };
  }
}
