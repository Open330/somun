import { and, eq } from "drizzle-orm";
import { CHANNELS, type Channel } from "../core/channels.js";
import type { LintResult } from "../core/lint.js";
import { schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { NotFoundError } from "./context.js";
import { JOB_LEASE_MS } from "./jobs.js";
import { lintDraftFor } from "./pipeline.js";

/**
 * 초안 자동 보정. 생성한 초안이 모델이 고칠 수 있는 린트에 걸리면, 걸린 내용을 알려 주고 한 번 더 쓰게 한다.
 * 서버 작업자(generation-worker)와 로컬 에이전트 워커(scripts/agent-worker, /jobs/:id/check)가 같은 기준을 쓴다.
 */

/** 모델이 다시 쓰면 고칠 수 있는 린트. 사람이 판단할 일(사실 확인 등)이 아니라 형식·표현·근거 위반이다. */
export const REPAIRABLE = new Set(["length", "title_length", "outline_structure", "sections", "open_question", "avoid_terms", "no_transliterated_names", "mixed_korean_terms", "banned_phrases", "paragraphs", "has_link", "preferred_link", "no_exclamation", "no_emoji_bullets", "no_placeholder", "numbers_need_review", "author_role_need_review", "no_invented_limit", "repo_name", "no_vote_request"]);

type DraftJob = { id: number; candidateId: number; channel?: Channel | null; user: string };

export function readDraft(channel: Channel, json: unknown): { title?: string; body: string } {
  const r = (json ?? {}) as { title?: unknown; body?: unknown };
  return { title: CHANNELS[channel].hasTitle ? String(r.title ?? "").trim() || undefined : undefined, body: String(r.body ?? "").trim() };
}

/** 고칠 수 있는 린트 위반. 본문이 비었으면 null(비교할 수 없는 결과). */
export function draftIssues(ctx: AppContext, ownerId: string, job: DraftJob, json: unknown): LintResult[] | null {
  const channel = job.channel as Channel;
  const d = readDraft(channel, json);
  const purpose = job.user.includes("\n## First introduction\n") ? "introduction" : "update";
  return d.body ? lintDraftFor(ctx, ownerId, job.candidateId, channel, d.title, d.body, purpose).filter((l) => !l.ok && REPAIRABLE.has(l.rule)) : null;
}

/** 보정 요청 프롬프트: 원래 요청 + 직전 초안 + 고칠 점. */
export function repairPrompt(job: DraftJob, json: unknown, issues: LintResult[]): string {
  const prev = readDraft(job.channel as Channel, json);
  return [
    job.user,
    "",
    "## Your previous draft",
    prev.title ? `Title: ${prev.title}` : "",
    prev.body,
    "",
    "## Fix these problems",
    "Rewrite the previous draft so these checks pass. Keep every fact and link from Facts, and change only what is needed.",
    ...issues.map((l) => `- ${l.rule}${l.detail ? `: ${l.detail}` : ""}`),
    ...(issues.some((l) => l.rule === "numbers_need_review")
      ? ["For numbers_need_review: use the exact figure from Facts, or delete the claim. Never swap the number for vague size words (dramatically, significantly, halved, much faster, 대폭, 크게, 절반)."]
      : []),
  ].join("\n");
}

/** 기다리는 사이 글감을 버렸으면 다시 쓸 이유가 없다(결과는 반영 단계에서 어차피 거절된다). */
export function worthRepairing(ctx: AppContext, ownerId: string, candidateId: number): boolean {
  const status = ctx.db.select({ status: schema.candidates.status }).from(schema.candidates).where(and(eq(schema.candidates.id, candidateId), eq(schema.candidates.ownerId, ownerId))).get()?.status;
  return Boolean(status) && status !== "dropped";
}

/**
 * 로컬 워커가 제출 전에 결과를 확인한다. 고칠 점과 보정 프롬프트를 돌려주고, 다시 쓰는 시간을 위해 작업 임대를 연장한다.
 * 자기가 가져간(claim) 초안 작업에만 답한다.
 */
export function checkLocalResult(ctx: AppContext, ownerId: string, id: number, input: { claimToken: string; resultJson: string }): { issues: { rule: string; detail?: string }[]; repairUser?: string } {
  const j = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
  if (!j) throw new NotFoundError("job");
  const now = Date.now();
  if (j.executor !== "local" || j.claimToken !== input.claimToken || j.status !== "claimed" || j.claimedAt === null || j.claimedAt <= now - JOB_LEASE_MS) return { issues: [] };
  if (j.kind !== "draft" || !j.channel || !worthRepairing(ctx, ownerId, j.candidateId)) return { issues: [] };
  let json: unknown;
  try { json = JSON.parse(input.resultJson); } catch { return { issues: [] }; }
  const job = { id: j.id, candidateId: j.candidateId, channel: j.channel as Channel, user: j.user };
  const issues = draftIssues(ctx, ownerId, job, json);
  // 빈 본문은 고칠 대상이 아니라 쓸 수 없는 결과다. 보정본이 비었을 때 "문제 없음"으로 뽑히지 않게 한다.
  if (issues === null) return { issues: [{ rule: "empty_body" }] };
  if (!issues.length) return { issues: [] };
  ctx.db.update(schema.llmJobs).set({ claimedAt: now }).where(eq(schema.llmJobs.id, j.id)).run();
  return { issues: issues.map(({ rule, detail }) => ({ rule, detail })), repairUser: repairPrompt(job, json, issues) };
}
