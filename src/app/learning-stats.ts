import { and, asc, eq, inArray } from "drizzle-orm";
import type { Channel } from "../core/channels.js";
import { editRatio } from "../core/metrics.js";
import { schema } from "../infra/db/index.js";
import type { LearningBucket, LearningStats } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { getSettings, styleKeyOf } from "./settings.js";

const DAY = 86_400_000;

/** 월요일 00:00 UTC 기준 주. */
function weekOf(at: number): string {
  const d = new Date(at);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return new Date(monday).toISOString().slice(0, 10);
}

function bucket(ratios: number[]): LearningBucket {
  const n = ratios.length;
  return {
    copied: n,
    unchangedRate: n ? Math.round((ratios.filter((r) => r === 0).length / n) * 100) / 100 : 0,
    avgEditRatio: n ? Math.round((ratios.reduce((a, b) => a + b, 0) / n) * 100) / 100 : 0,
  };
}

/**
 * 학습이 실제로 효과가 있는지. 복사한 초안마다 "생성된 원문 → 복사한 최종본" 수정량을 잰다.
 * 원문은 첫 수정 기록의 before, 수정이 없었으면 지금 본문이다. 값은 복사 시점에 drafts.edit_ratio로 저장된다.
 */
export function learningStats(ctx: AppContext, ownerId: string, weeks = 12): LearningStats {
  const drafts = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.status, "copied"))).orderBy(asc(schema.drafts.updatedAt)).all();
  // 수정량은 복사할 때 저장된다. 그 전에 복사된 초안만 여기서 계산해 채운다.
  const ids = drafts.filter((d) => d.editRatio === null).map((d) => d.id);
  const firstEdit = new Map<number, string>();
  if (ids.length) {
    for (const e of ctx.db.select().from(schema.draftEdits).where(and(eq(schema.draftEdits.ownerId, ownerId), inArray(schema.draftEdits.draftId, ids))).orderBy(asc(schema.draftEdits.createdAt), asc(schema.draftEdits.id)).all()) {
      if (!firstEdit.has(e.draftId)) firstEdit.set(e.draftId, e.before);
    }
  }
  // 마이그레이션 전에 복사된 초안은 한 번 계산해 저장한다. 다음 요청부터는 저장된 값만 읽는다.
  for (const d of drafts) {
    if (d.editRatio !== null) continue;
    d.editRatio = editRatio(firstEdit.get(d.id) ?? d.body, d.body);
    ctx.db.update(schema.drafts).set({ editRatio: d.editRatio }).where(eq(schema.drafts.id, d.id)).run();
  }
  const rows = drafts.map((d) => ({ at: d.updatedAt, createdAt: d.createdAt, channel: d.channel as Channel, styleKey: d.styleKey ?? "unknown", ratio: d.editRatio ?? 0 }));
  const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, typeof rows>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const since = Date.now() - weeks * 7 * DAY;
  const settings = getSettings(ctx, ownerId);
  const current = styleKeyOf(settings.voice);
  const activeOwnExamples = ctx.db.select({ source: schema.examples.source }).from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.active, true))).all().filter((e) => e.source !== "seed").length;
  return {
    ...bucket(rows.map((r) => r.ratio)),
    byWeek: [...group((r) => weekOf(r.at)).entries()].filter(([w]) => Date.parse(w) >= since - 7 * DAY).map(([week, rs]) => ({ week, ...bucket(rs.map((r) => r.ratio)) })).sort((a, b) => a.week.localeCompare(b.week)),
    byStyle: [...group((r) => r.styleKey).entries()].map(([styleKey, rs]) => ({ styleKey, firstAt: Math.min(...rs.map((r) => r.createdAt)), current: styleKey === current, ...bucket(rs.map((r) => r.ratio)) })).sort((a, b) => a.firstAt - b.firstAt),
    byChannel: [...group((r) => r.channel).entries()].map(([channel, rs]) => ({ channel, ...bucket(rs.map((r) => r.ratio)) })).sort((a, b) => b.copied - a.copied),
    guideLines: settings.voice.guide.split("\n").filter((l) => l.trim()).length,
    activeOwnExamples,
  };
}
