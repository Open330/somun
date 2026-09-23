import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /** 글이 잡을 한 문장 각도. 비어 있으면 없음. 예전 행(reasoning 끝의 "각도: …")은 마이그레이션 0010이 옮겼다. */
  angle: text("angle"),
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
  /** 생성 당시 문체 프리셋. 발행 성과를 문체별로 묶을 때 쓴다. */
  voice: text("voice"),
  /** 생성 당시 문체 설정(프리셋·지침·예시 사용)의 짧은 해시. 학습 효과를 설정 버전별로 비교할 때 쓴다. */
  styleKey: text("style_key"),
  /** 복사할 때 잰 수정량(생성 원문 → 복사본, 0~1). 학습 효과 지표. 복사 전이면 null. */
  editRatio: real("edit_ratio"),
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
  /** 이 예시를 만든 초안. 복사한 초안 하나당 예시 하나. */
  draftId: integer("draft_id"),
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
  /** 공개 엔드포인트에서 자동 수집한 반응. X(FxTwitter), Show HN(HN API). 없으면 null. */
  autoStats: json<{ likes?: number; comments?: number; reposts?: number; views?: number; score?: number; source: string }>("auto_stats"),
  autoStatsAt: integer("auto_stats_at"),
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
  /** "free-1" 또는 "free-1|gemini-3.7-flash" — 쿼터는 프로젝트·모델 단위라 모델별로 따로 센다. */
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
  claimToken: text("claim_token"),
  executor: text("executor").notNull().default("local"),
  continuation: json<import("../../shared/types.js").GenerationPlan>("continuation"),
  /** lesson 작업이 규칙을 뽑을 초안과, 수정(edit)에서 왔는지 버림(drop)에서 왔는지. 넣을 때 정한다. */
  draftId: integer("draft_id"),
  lessonKind: text("lesson_kind"),
  attempts: integer("attempts").notNull().default(0),
  resultJson: text("result_json"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  claimedAt: integer("claimed_at"),
  finishedAt: integer("finished_at"),
}, (t) => [index("jobs_owner_status").on(t.ownerId, t.status), index("jobs_candidate").on(t.candidateId), index("jobs_executor_status").on(t.executor, t.status, t.id)]);

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

/** jiun-api 사용량 이벤트 대기열. 전송이 확인된 행만 지운다. */
export const usageOutbox = sqliteTable("usage_outbox", {
  eventId: text("event_id").primaryKey(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAt: integer("next_at").notNull(),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("usage_outbox_next").on(t.nextAt)]);

/** 저장소 프로필. 정체성의 기준선. README 해시가 바뀌면 다시 만들고, 사용자가 고친 필드(edits)는 유지한다. */
export const repoProfiles = sqliteTable("repo_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  repo: text("repo").notNull(),
  readmeHash: text("readme_hash").notNull(),
  profile: json<Record<string, unknown>>("profile").notNull(),
  edits: json<Record<string, unknown>>("edits"),
  model: text("model").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("repo_profiles_owner_repo").on(t.ownerId, t.repo)]);

/** 변경 원장. 저장소별로 "이미 다이제스트한 변경"과 발행 여부. 다이제스트가 같은 말을 반복하지 않게 한다. */
export const changeLedger = sqliteTable("change_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  repo: text("repo").notNull(),
  text: text("text").notNull(),
  normalized: text("normalized").notNull(),
  source: text("source"),
  candidateId: integer("candidate_id"),
  firstSeenAt: integer("first_seen_at").notNull(),
  publishedAt: integer("published_at"),
  publishedChannel: text("published_channel"),
  /** 사용자가 "사실이 틀림"으로 버린 초안에 쓰인 변경. 다음 다이제스트·초안이 피한다. */
  disputedAt: integer("disputed_at"),
}, (t) => [index("ledger_owner_repo_time").on(t.ownerId, t.repo, t.firstSeenAt), index("ledger_candidate").on(t.candidateId)]);

/** 지침 제안. 수정 diff와 버림 사유에서 뽑은 재사용 가능한 한 줄 규칙. 승인하면 settings.voice.guide에 붙는다. */
export const guideSuggestions = sqliteTable("guide_suggestions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id").notNull(),
  rule: text("rule").notNull(),
  normalized: text("normalized").notNull(),
  category: text("category").notNull(),
  count: integer("count").notNull().default(1),
  sources: json<{ kind: "edit" | "drop"; draftId: number; at: number }[]>("sources").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("guide_sugg_owner_status").on(t.ownerId, t.status)]);
