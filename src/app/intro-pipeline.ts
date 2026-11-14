import { and, eq } from "drizzle-orm";
import { readmeBased } from "../core/condition-review.js";
import { framingText, FACTS_SCHEMA, FACTS_SYSTEM, factsPrompt, introFactsHash, introFactsSource, verifyFacts, type IntroFacts } from "../core/intro-facts.js";
import { draftLintFacts } from "../core/lint.js";
import { draftPurposeOf, instructionOf } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import type { LlmResult } from "../infra/llm/providers.js";
import type { Evidence, Job } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { emit } from "./context.js";
import { getProfile } from "./profiles.js";

type Call = (user: string, schemaJson?: string, system?: string) => Promise<LlmResult>;

/** 사실 힌트를 붙이는가: 서버에서 도는 X·Threads 첫 소개, 편집 지시 없음, README 근거 있음. */
export function introFactsEligible(ctx: AppContext, ownerId: string, job: Job): boolean {
  if (ctx.env.introPipeline === false || job.kind !== "draft" || !["x", "threads"].includes(job.channel ?? "") || job.sourceExcerpt) return false;
  if (draftPurposeOf(null, job.user) !== "introduction" || instructionOf(job.user, job)?.trim()) return false;
  const row = ctx.db.select({ evidence: schema.candidates.evidence }).from(schema.candidates).where(and(eq(schema.candidates.id, job.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  return Boolean(row && readmeBased(row.evidence as Evidence));
}


/**
 * 첫 소개 생성에 덧붙일 사실 힌트. 원문에서 사실을 뽑아(인용 문자열 검증) 필수 전제어·핵심 동작·문제 인용을 원래 소개 프롬프트에 붙인다.
 * 사실 추출은 한 번만 하고 같은 원문의 한국어·영어 초안이 공유한다(글감 근거에 저장).
 * 후보 여러 개 + 쌍 비교 구조는 고정 측정에서 오히려 나빴다(3회 평균 3.3/10 대 기준선 5.0/10, flash-lite 쌍 비교 정확도 55%).
 * 그래서 문장은 기존 생성·보정·비평 경로가 쓰고, 여기서는 그 경로가 놓치던 전제어(고정 점검표 C3)와 사실 관계만 보탠다.
 */
export async function introFactsHint(ctx: AppContext, ownerId: string, job: Job, call: Call): Promise<string> {
  const row = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, job.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  if (!row) return "";
  const ev = row.evidence as Evidence;
  const profile = getProfile(ctx, ownerId, row.repo)?.profile;
  const name = draftLintFacts({ title: row.title, type: row.type, evidence: ev }, profile, "introduction").publicName ?? row.repo.split("/").at(-1)!;
  const source = introFactsSource(ev);
  const hash = introFactsHash(name, ev);
  let facts: IntroFacts | undefined = ev.introFacts?.hash === hash ? ev.introFacts.facts : undefined;
  const cached = Boolean(facts);
  if (!facts) {
    const r = await call(factsPrompt(name, source), JSON.stringify(FACTS_SCHEMA), FACTS_SYSTEM);
    facts = verifyFacts(r.json, source, framingText({ description: ev.description, homepage: ev.homepageSource?.status === "ok" ? ev.homepageSource.text : undefined, readme: ev.readmeForChecks || ev.readmeExcerpt }));
    const fresh = ctx.db.select({ evidence: schema.candidates.evidence }).from(schema.candidates).where(eq(schema.candidates.id, row.id)).get();
    ctx.db.update(schema.candidates).set({ evidence: { ...(fresh?.evidence as Evidence), introFacts: { hash, facts } } as Record<string, unknown> }).where(eq(schema.candidates.id, row.id)).run();
    emit(ctx, ownerId, { resource: "candidates", id: row.id });
  }
  ctx.log.info({ jobId: job.id, prerequisites: facts.prerequisites.map((p) => p.term), actions: facts.actions.length, cached }, "introduction facts");
  return [
    facts.prerequisites.length ? `## Required words\nName where the product works using these words from the source: ${facts.prerequisites.map((p) => p.term).join(", ")}. Say it as the place it works, not as an installation requirement.` : "",
    facts.actions[0] ? `## Core (must be conveyed in full)\n"${facts.actions[0].quote}"` : "",
    facts.problem ? `## Problem as the source states it (if you use it, keep every place and relation as written; do not merge separate places into one)\n"${facts.problem.quote}"` : "",
    "## Source priority\nIf the repository description and the README or homepage disagree, follow the README and homepage; the description may be outdated.",
  ].filter(Boolean).map((block) => `\n\n${block}`).join("");
}
