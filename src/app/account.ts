import { eq, getTableName } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { removeVideoRenders } from "./videos.js";

/**
 * 계정 데이터 내보내기·삭제. 소유자(ownerId) 범위의 모든 표.
 * 서버 전역 표(llm_key_state, app_state, usage_outbox)는 계정 데이터가 아니라 건드리지 않는다.
 */
const OWNED = [
  schema.sources, schema.signals, schema.candidates, schema.judgments, schema.drafts, schema.draftEdits, schema.examples,
  schema.publications, schema.metricSnapshots, schema.feedback, schema.settings, schema.llmJobs, schema.githubInstallations,
  schema.repoProfiles, schema.changeLedger, schema.guideSuggestions, schema.videos,
] as const;

export function exportAccount(ctx: AppContext, ownerId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), ownerId };
  for (const t of OWNED) {
    const name = getTableName(t);
    const rows = ctx.db.select().from(t).where(eq(t.ownerId, ownerId)).all();
    // 설정의 비밀(키, 웹훅)은 내보내지 않는다.
    out[name] = name === "settings" ? rows.map((r) => { const d = { ...(r as { data: Record<string, unknown> }).data } as { llm?: Record<string, unknown>; notify?: Record<string, unknown> }; if (d.llm) d.llm = { ...d.llm, apiKey: undefined }; if (d.notify) d.notify = { ...d.notify, discordWebhookUrl: undefined }; return { ...r, data: d }; }) : rows;
  }
  return out;
}

export function deleteAccount(ctx: AppContext, ownerId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const renders = ctx.db.select({ renderId: schema.videos.renderId }).from(schema.videos).where(eq(schema.videos.ownerId, ownerId)).all().map((r) => r.renderId);
  ctx.db.transaction((tx) => {
    for (const t of OWNED) {
      const name = getTableName(t);
      counts[name] = tx.delete(t).where(eq(t.ownerId, ownerId)).run().changes;
    }
  });
  ctx.log.info({ ownerId, counts }, "account deleted");
  // 영상 파일은 영상 서버에 있다. 행을 지운 뒤 따로 지운다.
  void removeVideoRenders(ctx, renders);
  return counts;
}
