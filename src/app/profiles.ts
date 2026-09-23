import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { profilePrompt, type ProfileMaterial } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import { modelFor, runLlm } from "../infra/llm/providers.js";
import { recordLlmUsage } from "./llm-usage.js";
import type { JobMeta, RepoProfile, RepoProfileView } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";
import { keyPoolOps } from "./keys.js";
import { getSettings } from "./settings.js";

/**
 * 저장소 프로필: 정체성의 기준선.
 * README 해시가 바뀌면 다시 만든다. 사용자가 고친 필드(edits)는 재생성 뒤에도 우선한다.
 */

const EMPTY: RepoProfile = { what: "", audience: "", claims: [], stage: "unknown", limitations: [], naming: "", avoid: [] };

export function readmeHash(readme: string, description?: string): string {
  return createHash("sha1").update(readme).update("\n").update(description ?? "").digest("hex").slice(0, 16);
}

function normalize(raw: unknown): RepoProfile {
  const r = (raw ?? {}) as Partial<RepoProfile>;
  const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()).slice(0, n) : []);
  const stage = ["experiment", "beta", "stable", "archived", "unknown"].includes(String(r.stage)) ? (r.stage as RepoProfile["stage"]) : "unknown";
  return { what: String(r.what ?? "").trim(), audience: String(r.audience ?? "").trim(), claims: strs(r.claims, 4), stage, limitations: strs(r.limitations, 5), naming: String(r.naming ?? "").trim(), avoid: strs(r.avoid, 8) };
}

function merged(row: typeof schema.repoProfiles.$inferSelect): RepoProfileView {
  const base = normalize(row.profile);
  const edits = (row.edits ?? {}) as Partial<RepoProfile>;
  const profile = { ...base, ...normalize({ ...base, ...edits }) };
  return { repo: row.repo, profile, editedFields: Object.keys(edits) as (keyof RepoProfile)[], model: row.model, updatedAt: row.updatedAt };
}

export function getProfile(ctx: AppContext, ownerId: string, repo: string): RepoProfileView | undefined {
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, repo))).get();
  return row ? merged(row) : undefined;
}

export function listProfiles(ctx: AppContext, ownerId: string): RepoProfileView[] {
  return ctx.db.select().from(schema.repoProfiles).where(eq(schema.repoProfiles.ownerId, ownerId)).all().map(merged);
}

/** 프로필 저장. 사용자가 고친 필드(edits)는 건드리지 않는다. */
function saveProfile(ctx: AppContext, ownerId: string, repo: string, hash: string, profile: RepoProfile, model: string): void {
  const now = Date.now();
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, repo))).get();
  if (row) ctx.db.update(schema.repoProfiles).set({ readmeHash: hash, profile: profile as Record<string, unknown>, model, updatedAt: now }).where(eq(schema.repoProfiles.id, row.id)).run();
  else ctx.db.insert(schema.repoProfiles).values({ ownerId, repo, readmeHash: hash, profile: profile as Record<string, unknown>, edits: null, model, createdAt: now, updatedAt: now }).run();
  emit(ctx, ownerId, { resource: "candidates" });
}

/** 이 저장소의 대기·진행 중인 프로필 작업. 저장소로 SQL에서 거르고, 프롬프트 원문은 읽지 않는다. */
export function pendingProfileJob(ctx: AppContext, ownerId: string, repo: string) {
  return ctx.db.select({ id: schema.llmJobs.id, status: schema.llmJobs.status, meta: schema.llmJobs.meta }).from(schema.llmJobs)
    .where(and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.kind, "profile"), inArray(schema.llmJobs.status, ["pending", "claimed"]), sql`json_extract(${schema.llmJobs.meta}, '$.repo') = ${repo}`)).get();
}

/**
 * local-agent 모드: 프로필 생성을 사용자의 워커에 맡긴다. 원자료(README 등)가 서버 모델로 가지 않는다.
 * 같은 README로 대기 중인 작업이 있으면 그대로 둔다. README가 바뀌었으면 아직 시작하지 않은 옛 작업을 새 작업으로 바꾼다.
 * 워커가 이미 잡은 작업이 있으면 끝날 때까지 기다린다("busy").
 */
function queueProfile(ctx: AppContext, ownerId: string, material: ProfileMaterial, hash: string): "queued" | "exists" | "busy" {
  const open = pendingProfileJob(ctx, ownerId, material.repo);
  if (open?.meta?.readmeHash === hash) return "exists";
  if (open?.status === "claimed") return "busy";
  if (open) ctx.db.update(schema.llmJobs).set({ status: "failed", error: "새 README로 다시 요청되어 대체되었습니다.", finishedAt: Date.now() }).where(and(eq(schema.llmJobs.id, open.id), eq(schema.llmJobs.status, "pending"))).run();
  const prompt = profilePrompt(material);
  const id = Number(ctx.db.insert(schema.llmJobs).values({ ownerId, kind: "profile", candidateId: 0, meta: { repo: material.repo, readmeHash: hash }, system: prompt.system, user: prompt.user, schemaJson: JSON.stringify(prompt.schema), executor: "local", status: "pending", createdAt: Date.now() }).run().lastInsertRowid);
  emit(ctx, ownerId, { resource: "jobs", id });
  return "queued";
}

/**
 * 워커가 돌려준 프로필 반영. 작업을 넣을 때의 README 해시로 저장한다(그 뒤 README가 바뀌면 다음 수집이 다시 만든다).
 * 그 사이 더 새 프로필이 저장됐으면(다른 경로로 재생성, 모드 전환) 덮지 않는다. meta가 없으면 false.
 */
export function applyProfile(ctx: AppContext, ownerId: string, meta: JobMeta, result: unknown, model: string, queuedAt: number): boolean {
  if (!meta.repo || !meta.readmeHash) return false;
  const row = ctx.db.select({ updatedAt: schema.repoProfiles.updatedAt }).from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, meta.repo))).get();
  if (row && row.updatedAt > queuedAt) return true;
  saveProfile(ctx, ownerId, meta.repo, meta.readmeHash, normalize(result), model);
  return true;
}

const isLocal = (ctx: AppContext, ownerId: string) => getSettings(ctx, ownerId).llm.provider === "local-agent";

/** 없거나 README가 바뀐 경우에만 생성. 반환값은 생성 여부(local-agent면 큐에 넣은 것). */
export async function ensureProfile(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<"kept" | "created" | "refreshed" | "queued"> {
  const hash = readmeHash(material.readme, material.description);
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, material.repo))).get();
  if (row && row.readmeHash === hash) return "kept";
  if (isLocal(ctx, ownerId)) return queueProfile(ctx, ownerId, material, hash) === "queued" ? "queued" : "kept";
  const profile = await generate(ctx, ownerId, material);
  saveProfile(ctx, ownerId, material.repo, hash, profile.profile, profile.model);
  return row ? "refreshed" : "created";
}

/**
 * 강제 재생성. 사용자가 고친 필드는 그대로 둔다.
 * local-agent면 큐에 넣고 지금의 프로필을 돌려준다. 워커가 같은 저장소를 이미 처리 중이면 busy.
 */
export async function regenerateProfile(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<{ queued: boolean; busy?: boolean; profile?: RepoProfileView }> {
  const hash = readmeHash(material.readme, material.description);
  if (isLocal(ctx, ownerId)) {
    // 같은 README여도 사용자가 다시 만들라고 한 것이므로, 아직 시작하지 않은 작업은 새로 넣는다.
    const open = pendingProfileJob(ctx, ownerId, material.repo);
    if (open?.status === "claimed") return { queued: false, busy: true, profile: getProfile(ctx, ownerId, material.repo) };
    if (open) ctx.db.update(schema.llmJobs).set({ status: "failed", error: "새 요청으로 대체되었습니다.", finishedAt: Date.now() }).where(and(eq(schema.llmJobs.id, open.id), eq(schema.llmJobs.status, "pending"))).run();
    queueProfile(ctx, ownerId, material, hash);
    return { queued: true, profile: getProfile(ctx, ownerId, material.repo) };
  }
  const profile = await generate(ctx, ownerId, material);
  saveProfile(ctx, ownerId, material.repo, hash, profile.profile, profile.model);
  return { queued: false, profile: getProfile(ctx, ownerId, material.repo) };
}

export function editProfile(ctx: AppContext, ownerId: string, repo: string, edits: Partial<RepoProfile>): RepoProfileView {
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, repo))).get();
  const now = Date.now();
  const clean = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined));
  if (row) ctx.db.update(schema.repoProfiles).set({ edits: { ...(row.edits ?? {}), ...clean }, updatedAt: now }).where(eq(schema.repoProfiles.id, row.id)).run();
  else ctx.db.insert(schema.repoProfiles).values({ ownerId, repo, readmeHash: "", profile: EMPTY as unknown as Record<string, unknown>, edits: clean, model: "user", createdAt: now, updatedAt: now }).run();
  emit(ctx, ownerId, { resource: "candidates" });
  return getProfile(ctx, ownerId, repo)!;
}

/** 서버 모델로 바로 만든다(local-agent가 아닐 때만). 분석 모델(다이제스트와 같은 등급)을 쓴다. */
async function generate(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<{ profile: RepoProfile; model: string }> {
  const cfg = getSettings(ctx, ownerId).llm;
  const startedAt = Date.now();
  let res;
  try { res = await runLlm({ ...cfg }, profilePrompt(material), "digest", keyPoolOps(ctx), ctx.env.geminiKeys); }
  catch (err) { recordLlmUsage(ctx, ownerId, cfg, startedAt, { failedModel: modelFor(cfg, "digest") }); throw err; }
  recordLlmUsage(ctx, ownerId, cfg, startedAt, { res });
  return { profile: normalize(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` };
}
