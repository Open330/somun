import { and, eq } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Evidence } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

export type RepoSessionInput = { repo: string; summary: string; sessions: { sessionId: string; source: string; startedAt: number; promptCount: number; retries?: number; topic: string }[] };

/** omp 세션 요약 수신. 단독 후보가 되지 않고 같은 저장소의 열린 후보에 근거로 붙는다. */
export function ingestSessions(ctx: AppContext, ownerId: string, repos: RepoSessionInput[]): { inserted: number; attached: number } {
  let source = ctx.db.select().from(schema.sources).where(and(eq(schema.sources.ownerId, ownerId), eq(schema.sources.kind, "sessions"))).get();
  if (!source) {
    const id = Number(ctx.db.insert(schema.sources).values({ ownerId, kind: "sessions", targets: ["local"], enabled: true }).run().lastInsertRowid);
    source = ctx.db.select().from(schema.sources).where(eq(schema.sources.id, id)).get()!;
  }
  let inserted = 0, attached = 0;
  for (const r of repos) {
    for (const s of r.sessions) {
      const ref = `omp:session:${s.sessionId}`;
      const dup = ctx.db.select({ id: schema.signals.id }).from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.ref, ref))).get();
      if (dup) continue;
      ctx.db.insert(schema.signals).values({ ownerId, sourceId: source.id, kind: "omp_session", repo: r.repo, ref, title: s.topic, payload: s, occurredAt: s.startedAt }).run();
      inserted++;
    }
    const open = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, r.repo))).all();
    for (const c of open) {
      if (["dropped", "published"].includes(c.status)) continue;
      ctx.db.update(schema.candidates).set({ evidence: { ...(c.evidence as Evidence), ompSummary: r.summary } as Record<string, unknown>, updatedAt: Date.now() }).where(eq(schema.candidates.id, c.id)).run();
      attached++;
    }
  }
  ctx.db.update(schema.sources).set({ lastPolledAt: Date.now() }).where(eq(schema.sources.id, source.id)).run();
  if (attached) emit(ctx, ownerId, { resource: "candidates" });
  return { inserted, attached };
}
