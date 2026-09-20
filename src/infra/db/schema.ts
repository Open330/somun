import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite 스키마 (Drizzle). JSON 컬럼은 text에 mode "json".
 * 모든 행은 ownerId로 스코프된다 (단일 사용자 모드는 "local").
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").notNull(),
  targets: json<string[]>("targets").notNull(),
  options: json<Record<string, string>>("options"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastPolledAt: integer("last_polled_at"),
  lastError: text("last_error"),
}, (t) => [index("sources_owner").on(t.ownerId)]);

export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  sourceId: integer("source_id").notNull(),
  kind: text("kind").notNull(),
  repo: text("repo").notNull(),
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  payload: json<unknown>("payload"),
  occurredAt: integer("occurred_at").notNull(),
  candidateId: integer("candidate_id"),
}, (t) => [uniqueIndex("signals_owner_ref").on(t.ownerId, t.ref), index("signals_owner_repo_time").on(t.ownerId, t.repo, t.occurredAt), index("signals_candidate").on(t.candidateId)]);

export const candidates = sqliteTable("candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  repo: text("repo").notNull(),
  key: text("key").notNull(),
  evidence: json<Record<string, unknown>>("evidence").notNull(),
  status: text("status").notNull().default("new"),
  latestJudgmentId: integer("latest_judgment_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("candidates_owner_key").on(t.ownerId, t.key), index("candidates_owner_status").on(t.ownerId, t.status), index("candidates_owner_updated").on(t.ownerId, t.updatedAt)]);

export const judgments = sqliteTable("judgments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  candidateId: integer("candidate_id").notNull(),
  scores: json<Record<string, number>>("scores").notNull(),
  total: integer("total").notNull(),
  reasoning: text("reasoning").notNull(),
  decision: text("decision").notNull(),
  suggestedChannels: json<string[]>("suggested_channels").notNull(),
  model: text("model").notNull(),
  overriddenDecision: text("overridden_decision"),
  overrideReason: text("override_reason"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("judgments_candidate").on(t.candidateId)]);

export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  candidateId: integer("candidate_id").notNull(),
  channel: text("channel").notNull(),
  lang: text("lang").notNull().default("en"),
  version: integer("version").notNull(),
  title: text("title"),
  body: text("body").notNull(),
  mediaHint: text("media_hint"),
  lint: json<{ rule: string; ok: boolean; detail?: string }[]>("lint").notNull(),
  status: text("status").notNull().default("proposed"),
  model: text("model").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("drafts_candidate").on(t.candidateId), index("drafts_owner_status").on(t.ownerId, t.status)]);

export const draftEdits = sqliteTable("draft_edits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  draftId: integer("draft_id").notNull(),
  channel: text("channel").notNull(),
  before: text("before").notNull(),
  after: text("after").notNull(),
  promotedExampleId: integer("promoted_example_id"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("draft_edits_draft").on(t.draftId)]);

export const examples = sqliteTable("examples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  channel: text("channel").notNull(),
  lang: text("lang").notNull(),
  title: text("title"),
  body: text("body").notNull(),
  source: text("source").notNull(),
  note: text("note"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("examples_owner_channel_active").on(t.ownerId, t.channel, t.active)]);

export const publications = sqliteTable("publications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  candidateId: integer("candidate_id").notNull(),
  draftId: integer("draft_id"),
  channel: text("channel").notNull(),
  lang: text("lang"),
  url: text("url").notNull(),
  publishedAt: integer("published_at").notNull(),
  manualStats: json<{ likes?: number; comments?: number; reposts?: number }>("manual_stats"),
}, (t) => [index("publications_candidate").on(t.candidateId), index("publications_owner_time").on(t.ownerId, t.publishedAt)]);

export const metricSnapshots = sqliteTable("metric_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  repo: text("repo").notNull(),
  at: integer("at").notNull(),
  stars: integer("stars").notNull(),
  forks: integer("forks").notNull(),
  viewsUniques14d: integer("views_uniques_14d"),
  referrers: json<{ referrer: string; uniques: number }[]>("referrers"),
  npmDownloadsMonth: integer("npm_downloads_month"),
}, (t) => [index("metrics_owner_repo_time").on(t.ownerId, t.repo, t.at)]);

export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("feedback_owner_time").on(t.ownerId, t.createdAt)]);

export const settings = sqliteTable("settings", {
  ownerId: text("owner_id").primaryKey(),
  data: json<Record<string, unknown>>("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const llmKeyState = sqliteTable("llm_key_state", {
  label: text("label").primaryKey(),
  lastUsedAt: integer("last_used_at").notNull(),
  cooldownUntil: integer("cooldown_until"),
  cooldownReason: text("cooldown_reason"),
  dayKey: text("day_key").notNull(),
  dayCount: integer("day_count").notNull().default(0),
  lastQuotaId: text("last_quota_id"),
  lastRetryDelay: text("last_retry_delay"),
  lastErrorAt: integer("last_error_at"),
});

export const llmJobs = sqliteTable("llm_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").notNull(),
  candidateId: integer("candidate_id").notNull(),
  channel: text("channel"),
  lang: text("lang"),
  system: text("system").notNull(),
  user: text("user").notNull(),
  schemaJson: text("schema_json").notNull(),
  status: text("status").notNull().default("pending"),
  runner: text("runner"),
  resultJson: text("result_json"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  claimedAt: integer("claimed_at"),
  finishedAt: integer("finished_at"),
}, (t) => [index("jobs_owner_status").on(t.ownerId, t.status), index("jobs_candidate").on(t.candidateId)]);

/** GitHub App 설치. 사용자(ownerId)가 설치한 계정/저장소. */
export const githubInstallations = sqliteTable("github_installations", {
  installationId: integer("installation_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  account: text("account").notNull(),
  accountType: text("account_type").notNull(),
  repos: json<string[]>("repos").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("gh_inst_owner").on(t.ownerId)]);

/** 서버 전역 키-값 (매니페스트로 만든 GitHub App 자격 증명 등). 값은 평문이므로 DATA_DIR 보호가 전제. */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
