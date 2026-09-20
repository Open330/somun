import type { Auth } from "convex/server";

declare const process: { env: Record<string, string | undefined> };

/**
 * 소유권 규칙 (daily와 동일).
 * 인증 배포에서는 JWT tokenIdentifier, 로컬 익명 모드(SOMUN_ALLOW_ANONYMOUS=true)에서는 "anonymous".
 */
export const ANONYMOUS_OWNER_ID = "anonymous";

export function resolveOwnerId(tokenIdentifier: string | null, allowAnonymous: boolean): string {
  if (tokenIdentifier) return tokenIdentifier;
  if (allowAnonymous) return ANONYMOUS_OWNER_ID;
  throw new Error("인증이 필요합니다 (SOMUN_ALLOW_ANONYMOUS 미설정).");
}

export async function getOwnerId(ctx: { auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  return resolveOwnerId(identity?.tokenIdentifier ?? null, process.env.SOMUN_ALLOW_ANONYMOUS === "true");
}

export function assertOwned<T extends { ownerId: string }>(doc: T | null, ownerId: string, what: string): asserts doc is T {
  if (!doc || doc.ownerId !== ownerId) throw new Error(`${what} not found`);
}
