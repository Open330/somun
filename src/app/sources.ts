import { and, eq } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Source, SourceKind } from "../shared/types.js";
import { emit, NotFoundError, type AppContext } from "./context.js";

const toSource = (r: typeof schema.sources.$inferSelect): Source => ({ id: r.id, kind: r.kind as SourceKind, targets: r.targets, options: r.options ?? undefined, enabled: r.enabled, lastPolledAt: r.lastPolledAt ?? undefined, lastError: r.lastError ?? undefined });

export function listSources(ctx: AppContext, ownerId: string): Source[] {
  return ctx.db.select().from(schema.sources).where(eq(schema.sources.ownerId, ownerId)).all().map(toSource);
}

export function listEnabledSources(ctx: AppContext, opts: { ownerId?: string; kind?: SourceKind } = {}): (Source & { ownerId: string })[] {
  const rows = opts.ownerId ? ctx.db.select().from(schema.sources).where(eq(schema.sources.ownerId, opts.ownerId)).all() : ctx.db.select().from(schema.sources).all();
  return rows.filter((r) => r.enabled && (!opts.kind || r.kind === opts.kind)).map((r) => ({ ...toSource(r), ownerId: r.ownerId }));
}

export function upsertSource(ctx: AppContext, ownerId: string, input: { id?: number; kind: SourceKind; targets: string[]; options?: Record<string, string>; enabled: boolean }): Source {
  // 설치 ID는 이 소유자가 연결한 설치만 가리킬 수 있다. 다른 사람의 설치 토큰으로 읽는 것을 막는다.
  const inst = input.options?.installationId;
  if (inst !== undefined) {
    const owner = ctx.db.select({ ownerId: schema.githubInstallations.ownerId }).from(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, Number(inst))).get()?.ownerId;
    if (owner !== ownerId) throw new NotFoundError("installation");
  }
  let id = input.id;
  if (id) {
    const existing = ctx.db.select().from(schema.sources).where(and(eq(schema.sources.id, id), eq(schema.sources.ownerId, ownerId))).get();
    if (!existing) throw new NotFoundError("source");
    ctx.db.update(schema.sources).set({ kind: input.kind, targets: input.targets, options: input.options ?? null, enabled: input.enabled }).where(eq(schema.sources.id, id)).run();
  } else {
    id = Number(ctx.db.insert(schema.sources).values({ ownerId, kind: input.kind, targets: input.targets, options: input.options ?? null, enabled: input.enabled }).run().lastInsertRowid);
  }
  emit(ctx, ownerId, { resource: "sources" });
  return toSource(ctx.db.select().from(schema.sources).where(eq(schema.sources.id, id)).get()!);
}

export function removeSource(ctx: AppContext, ownerId: string, id: number): void {
  const r = ctx.db.delete(schema.sources).where(and(eq(schema.sources.id, id), eq(schema.sources.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("source");
  emit(ctx, ownerId, { resource: "sources" });
}

export function markPolled(ctx: AppContext, id: number, error?: string): void {
  ctx.db.update(schema.sources).set({ lastPolledAt: Date.now(), lastError: error ?? null }).where(eq(schema.sources.id, id)).run();
}
