import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../infra/db/index.js";
import { schema } from "../infra/db/index.js";
import type { Evidence } from "../shared/types.js";
import { casesSchema, configSchema, type ExperimentCase, type ExperimentConfig } from "./drafts.js";

/**
 * 보류 평가 세트: 내가 실제로 복사한 초안에서 만든다. 프롬프트를 고칠 때 본 적 없는 실제 글감으로 평가하기 위해서다.
 * 사례 = 그 글감의 근거(현재 값) + 채널·언어. 기준 답 = 내가 복사한 최종본(replay 변형 "author-final").
 * 개인 원고가 들어가므로 저장소에 올리지 않는 위치(experiments/holdout/)에 쓴다.
 */

const EVIDENCE_KEYS = ["repo", "repoUrl", "description", "version", "releaseNotes", "readmeExcerpt", "highlights", "limitations", "stars", "forks", "commitCount", "releaseCount", "firstReleaseAt", "language", "license", "homepage", "npmPackage", "npmMonthlyDownloads", "demoAsset"] as const;

export function exportHoldout(db: Db, ownerId: string, opts: { max?: number; name?: string } = {}): { cases: ExperimentCase[]; config: ExperimentConfig; skipped: number } {
  const drafts = db.select().from(schema.drafts).where(and(eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.status, "copied"))).orderBy(desc(schema.drafts.updatedAt)).all();
  const candidates = new Map(drafts.length ? db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), inArray(schema.candidates.id, [...new Set(drafts.map((d) => d.candidateId))]))).all().map((c) => [c.id, c]) : []);
  const cases: ExperimentCase[] = [];
  const replay: Record<string, { title: string; body: string }> = {};
  let skipped = 0;
  for (const d of drafts) {
    if (cases.length >= (opts.max ?? 30)) break;
    const c = candidates.get(d.candidateId);
    const ev = c?.evidence as Evidence | undefined;
    // 다이제스트가 없는 글감은 초안 단계 평가의 입력을 만들 수 없다.
    if (!c || !ev?.highlights?.length || !/^https?:\/\//.test(ev.repoUrl ?? "")) { skipped++; continue; }
    const evidence = Object.fromEntries(EVIDENCE_KEYS.filter((k) => ev[k] !== undefined && ev[k] !== null).map((k) => [k, ev[k]])) as Partial<ExperimentCase["candidate"]["evidence"]>;
    const id = `${d.channel}-${d.lang.toLowerCase().replace(/[^a-z0-9]/g, "")}-d${d.id}`;
    cases.push({ id, channel: d.channel as ExperimentCase["channel"], lang: d.lang, candidate: { title: c.title, type: c.type, evidence: { limitations: [], ...evidence, repo: ev.repo, repoUrl: ev.repoUrl, highlights: ev.highlights } }, required: [], forbidden: [], reviewNotes: `실제 글감 #${c.id}. 기준 답은 작성자가 복사한 최종본(변형 author-final)이다. 근거는 내보낸 시점의 값이라 초안 생성 당시와 다를 수 있다.` });
    replay[id] = { title: d.title ?? "", body: d.body };
  }
  if (!cases.length) throw new Error("내보낼 사례가 없습니다. 다이제스트가 있는 글감에서 초안을 복사한 기록이 필요합니다.");
  const parsedCases = casesSchema.parse(cases);
  const config = configSchema.parse({ name: opts.name ?? "holdout", cases: "cases.json", variants: [{ id: "author-final", replay }] });
  return { cases: parsedCases, config, skipped };
}
