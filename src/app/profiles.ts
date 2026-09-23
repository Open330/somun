import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { profilePrompt, type ProfileMaterial } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import { modelFor, runLlm } from "../infra/llm/providers.js";
import { recordLlmUsage } from "./llm-usage.js";
import type { RepoProfile, RepoProfileView } from "../shared/types.js";
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

/** 없거나 README가 바뀐 경우에만 생성. 반환값은 생성 여부. */
export async function ensureProfile(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<"kept" | "created" | "refreshed"> {
  const hash = readmeHash(material.readme, material.description);
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, material.repo))).get();
  if (row && row.readmeHash === hash) return "kept";
  const profile = await generate(ctx, ownerId, material);
  const now = Date.now();
  if (row) ctx.db.update(schema.repoProfiles).set({ readmeHash: hash, profile: profile.profile as Record<string, unknown>, model: profile.model, updatedAt: now }).where(eq(schema.repoProfiles.id, row.id)).run();
  else ctx.db.insert(schema.repoProfiles).values({ ownerId, repo: material.repo, readmeHash: hash, profile: profile.profile as Record<string, unknown>, edits: null, model: profile.model, createdAt: now, updatedAt: now }).run();
  emit(ctx, ownerId, { resource: "candidates" });
  return row ? "refreshed" : "created";
}

/** 강제 재생성. 사용자가 고친 필드는 그대로 둔다. */
export async function regenerateProfile(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<RepoProfileView> {
  const profile = await generate(ctx, ownerId, material);
  const hash = readmeHash(material.readme, material.description);
  const now = Date.now();
  const row = ctx.db.select().from(schema.repoProfiles).where(and(eq(schema.repoProfiles.ownerId, ownerId), eq(schema.repoProfiles.repo, material.repo))).get();
  if (row) ctx.db.update(schema.repoProfiles).set({ readmeHash: hash, profile: profile.profile as Record<string, unknown>, model: profile.model, updatedAt: now }).where(eq(schema.repoProfiles.id, row.id)).run();
  else ctx.db.insert(schema.repoProfiles).values({ ownerId, repo: material.repo, readmeHash: hash, profile: profile.profile as Record<string, unknown>, edits: null, model: profile.model, createdAt: now, updatedAt: now }).run();
  emit(ctx, ownerId, { resource: "candidates" });
  return getProfile(ctx, ownerId, material.repo)!;
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

async function generate(ctx: AppContext, ownerId: string, material: ProfileMaterial): Promise<{ profile: RepoProfile; model: string }> {
  const settings = getSettings(ctx, ownerId);
  const startedAt = Date.now();
  // 분석 모델(다이제스트와 같은 등급)로 만든다. local-agent 설정이어도 프로필은 서버 Gemini 키로 만든다: 워커 큐를 타기엔 너무 잦다.
  const cfg = settings.llm.provider === "local-agent" ? { provider: "gemini" as const, model: "gemini-3.5-flash-lite" } : settings.llm;
  let res;
  try { res = await runLlm({ ...cfg }, profilePrompt(material), "digest", keyPoolOps(ctx), ctx.env.geminiKeys); }
  catch (err) { recordLlmUsage(ctx, ownerId, cfg, startedAt, { failedModel: modelFor(cfg, "digest") }); throw err; }
  recordLlmUsage(ctx, ownerId, cfg, startedAt, { res });
  return { profile: normalize(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` };
}
