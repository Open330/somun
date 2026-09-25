import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { BridgeStatus, BridgeTokenView, VideoConfigView } from "../shared/video.js";
import { GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "./context.js";

/**
 * 영상 bridge 토큰. 사용자마다 자기 컴퓨터의 Claude Code를 영상 서버에 붙일 때 쓴다.
 * 원문은 발급 응답에만 있고, somun은 해시만 둔다. 발급·폐기는 한 건씩 영상 서버에 반영하고, 전체 목록은 주기적으로 맞춘다.
 */
const MAX_ACTIVE_PER_OWNER = 5;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * 영상 서버로 가는 토큰 변경은 한 줄로 세운다. 먼저 보낸 요청이 나중에 도착해 폐기한 토큰을 되살리지 않게.
 * 전체 맞추기는 줄 안에서 DB를 읽으므로 늘 그 시점의 최신 목록을 보낸다.
 */
let line: Promise<unknown> = Promise.resolve();
function inLine<T>(fn: () => Promise<T>): Promise<T> {
  const run = line.then(fn, fn);
  line = run.catch(() => undefined);
  return run;
}

/** 모든 소유자의 유효 토큰으로 영상 서버의 목록을 맞춘다. 서버 시작 때와 5분마다(놓친 변경을 메운다). */
export function syncBridgeTokens(ctx: AppContext): Promise<void> {
  return inLine(async () => {
    const client = ctx.env.video;
    if (!client) return;
    const rows = ctx.db.select().from(schema.bridgeTokens).where(isNull(schema.bridgeTokens.revokedAt)).all();
    await client.putBridgeTokens(rows.map((r) => ({ id: r.id, owner: r.ownerId, tokenHash: r.tokenHash })));
  });
}

/** 폐기한 토큰을 영상 서버에서 뺀다(계정 삭제에도 쓴다). 실패하면 다음 전체 맞추기가 뺀다. */
export function removeBridgeTokens(ctx: AppContext, ids: string[]): Promise<void> {
  return inLine(async () => {
    const client = ctx.env.video;
    if (!client) return;
    for (const id of ids) await client.removeBridgeToken(id);
  });
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
  const tokenHash = hash(token);
  ctx.db.insert(schema.bridgeTokens).values({ id, ownerId, label: clean, tokenHash, createdAt: Date.now() }).run();
  try {
    await inLine(() => ctx.env.video!.addBridgeToken({ id, owner: ownerId, tokenHash }));
  } catch (err) {
    ctx.db.delete(schema.bridgeTokens).where(eq(schema.bridgeTokens.id, id)).run();
    ctx.log.warn({ err: (err as Error).message }, "bridge token sync failed");
    throw new UnavailableError("the video server is not reachable");
  }
  return { id, token, label: clean };
}

/** 폐기는 somun에 먼저 남긴다. 영상 서버에 닿지 않으면 다음 전체 맞추기(서버 시작, 5분마다) 때 빠진다. */
export async function revokeBridgeToken(ctx: AppContext, ownerId: string, id: string): Promise<{ synced: boolean }> {
  const row = ctx.db.select().from(schema.bridgeTokens).where(and(eq(schema.bridgeTokens.id, id), eq(schema.bridgeTokens.ownerId, ownerId), isNull(schema.bridgeTokens.revokedAt))).get();
  if (!row) throw new NotFoundError("bridge token");
  ctx.db.update(schema.bridgeTokens).set({ revokedAt: Date.now() }).where(eq(schema.bridgeTokens.id, id)).run();
  try {
    await removeBridgeTokens(ctx, [id]);
    return { synced: true };
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, "bridge token sync failed after revoke");
    return { synced: false };
  }
}
