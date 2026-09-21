import { eq } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { getSettings, updateSettings } from "./settings.js";
import { listSuggestions } from "./learning.js";

/**
 * 주간 요약 알림. Discord 웹훅 하나. 수동 모드에서 "들어와야 아는" 문제를 푼다.
 * 내용: 새 글감, 검수 대기 초안, 지침 제안 수. 링크는 서비스 주소.
 */
export async function sendWeeklySummary(ctx: AppContext, ownerId: string, force = false): Promise<{ ok: boolean; reason?: string; sent?: string }> {
  const s = getSettings(ctx, ownerId);
  const url = s.notify?.discordWebhookUrl;
  if (!url) return { ok: false, reason: "Discord 웹훅 URL이 없습니다." };
  if (!force && !s.notify?.weekly) return { ok: false, reason: "주간 알림이 꺼져 있습니다." };
  const rows = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId)).all();
  const fresh = rows.filter((c) => c.status === "new" && !(c.evidence as { highlightsAt?: number }).highlightsAt);
  const review = rows.filter((c) => c.status === "drafted");
  const deferred = rows.filter((c) => c.status === "deferred");
  const sugg = listSuggestions(ctx, ownerId).length;
  const base = ctx.env.publicUrl ?? "https://somun.jiun.dev";
  const top = [...review, ...fresh].slice(0, 5).map((c) => `• ${c.title}  <${base}/c/${c.id}>`).join("\n");
  const content = [
    `**소문 주간 요약**`,
    `검수할 초안 ${review.length}개 · 새 글감 ${fresh.length}개 · 보류 ${deferred.length}개${sugg ? ` · 지침 제안 ${sugg}개` : ""}`,
    top || "이번 주는 알릴 게 없습니다. 정상입니다.",
    `<${base}/>`,
  ].join("\n");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  if (!r.ok) return { ok: false, reason: `Discord ${r.status}` };
  updateSettings(ctx, ownerId, { notify: { ...s.notify!, lastSentAt: Date.now() } });
  return { ok: true, sent: content };
}

/** 월요일 09:00 KST에 weekly가 켜진 모든 소유자에게. */
export async function sendWeeklySummaries(ctx: AppContext): Promise<number> {
  const owners = ctx.db.select({ ownerId: schema.settings.ownerId }).from(schema.settings).all();
  let n = 0;
  for (const { ownerId } of owners) {
    try { if ((await sendWeeklySummary(ctx, ownerId)).ok) n++; } catch (e) { ctx.log.warn({ ownerId, err: (e as Error).message }, "weekly summary failed"); }
  }
  return n;
}
