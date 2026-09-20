import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * 소문 데이터 모델.
 *
 * 흐름: sources → signals → candidates → judgments → drafts → publications → metricSnapshots
 * 되먹임: draftEdits / feedback → examples(문체) · rubricWeights(판단)
 *
 * 모든 문서는 ownerId(JWT tokenIdentifier 또는 "anonymous")로 스코프된다.
 */

export const channelValidator = v.union(
  v.literal("x_en"),
  v.literal("x_ko"),
  v.literal("threads"),
  v.literal("linkedin_ko"),
  v.literal("show_hn"),
  v.literal("show_gn"),
  v.literal("blog_outline"),
);

export const candidateTypeValidator = v.union(
  v.literal("release"),
  v.literal("new-repo"),
  v.literal("milestone"),
  v.literal("blog"),
  v.literal("in-progress"),
);

export const candidateStatusValidator = v.union(
  v.literal("new"),
  v.literal("judged"),
  v.literal("drafted"),
  v.literal("published"),
  v.literal("dropped"),
  v.literal("deferred"),
);

/** 루브릭 다섯 항목. 각 0~2점. */
export const rubricScoresValidator = v.object({
  runnable: v.number(),
  numbers: v.number(),
  lesson: v.number(),
  novelty: v.number(),
  audience: v.number(),
});

export const evidenceValidator = v.object({
  repo: v.string(),
  repoUrl: v.string(),
  description: v.optional(v.string()),
  version: v.optional(v.string()),
  releaseNotes: v.optional(v.string()),
  stars: v.optional(v.number()),
  forks: v.optional(v.number()),
  commitCount: v.optional(v.number()),
  releaseCount: v.optional(v.number()),
  firstReleaseAt: v.optional(v.string()),
  language: v.optional(v.string()),
  license: v.optional(v.string()),
  homepage: v.optional(v.string()),
  npmPackage: v.optional(v.string()),
  npmMonthlyDownloads: v.optional(v.number()),
  demoAsset: v.optional(v.string()),
  limitations: v.optional(v.array(v.string())),
  readmeExcerpt: v.optional(v.string()),
  mergedPrTitles: v.optional(v.array(v.string())),
  /** omp 세션 요약: 같은 기간의 세션 수, 재시도 횟수, 오래 걸린 주제 */
  ompSummary: v.optional(v.string()),
  /** 마지막 릴리스 이후 커밋 제목 (원자료, 다이제스트 입력) */
  commitSubjects: v.optional(v.array(v.string())),
  /** 다이제스트: 원자료에서 추린 PR에 쓸 만한 사실만 (판단·초안은 이것을 본다) */
  highlights: v.optional(v.array(v.string())),
  highlightsAt: v.optional(v.number()),
});

export const llmProviderValidator = v.union(v.literal("gemini"), v.literal("anthropic"), v.literal("openai"), v.literal("local-agent"));

export const llmConfigValidator = v.object({
  provider: llmProviderValidator,
  /** 비우면 프로바이더 기본 모델 */
  model: v.optional(v.string()),
  /** 판단·초안 모델 (비우면 gemini는 3.7-flash, 나머지는 model). 다이제스트는 model을 쓴다 */
  draftModel: v.optional(v.string()),
  /** BYOK. 비우면 서버 키(gemini만) 사용 */
  apiKey: v.optional(v.string()),
  /** openai 호환 엔드포인트 (선택) */
  baseUrl: v.optional(v.string()),
  /** local-agent: 워커가 쓸 CLI */
  agentCli: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
});

export default defineSchema({
  sources: defineTable({
    ownerId: v.string(),
    kind: v.union(v.literal("github"), v.literal("npm"), v.literal("blog"), v.literal("omp")),
    /** github: "owner" 또는 "owner/repo" 목록. npm: 패키지명. blog: 레포. omp: 접속 정보 */
    config: v.object({
      targets: v.array(v.string()),
      options: v.optional(v.record(v.string(), v.string())),
    }),
    enabled: v.boolean(),
    lastPolledAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_owner", ["ownerId"]),

  signals: defineTable({
    ownerId: v.string(),
    sourceId: v.id("sources"),
    kind: v.union(
      v.literal("release"),
      v.literal("pr_merged"),
      v.literal("repo_created"),
      v.literal("readme_changed"),
      v.literal("star_milestone"),
      v.literal("download_milestone"),
      v.literal("blog_post"),
      v.literal("omp_session"),
    ),
    repo: v.string(),
    /** 소스별 고유 키 (중복 수집 방지) */
    ref: v.string(),
    title: v.string(),
    payload: v.any(),
    occurredAt: v.number(),
    candidateId: v.optional(v.id("candidates")),
  })
    .index("by_owner_ref", ["ownerId", "ref"])
    .index("by_owner_repo_time", ["ownerId", "repo", "occurredAt"])
    .index("by_owner_unassigned", ["ownerId", "candidateId"]),

  candidates: defineTable({
    ownerId: v.string(),
    type: candidateTypeValidator,
    title: v.string(),
    repo: v.string(),
    /** 묶음 기준 키. release: repo@tag, new-repo: repo, milestone: repo#stars-100 ... */
    key: v.string(),
    evidence: evidenceValidator,
    status: candidateStatusValidator,
    latestJudgmentId: v.optional(v.id("judgments")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_owner_updated", ["ownerId", "updatedAt"]),

  judgments: defineTable({
    ownerId: v.string(),
    candidateId: v.id("candidates"),
    scores: rubricScoresValidator,
    total: v.number(),
    reasoning: v.string(),
    /** 판단 결과: draft(초안 작성) / defer(보류) / ask(묻기만) */
    decision: v.union(v.literal("draft"), v.literal("defer"), v.literal("ask")),
    /** 채널 추천 (판단 시점의 청중 항목에서) */
    suggestedChannels: v.array(channelValidator),
    model: v.string(),
    overriddenDecision: v.optional(v.union(v.literal("draft"), v.literal("drop"))),
    overrideReason: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_candidate", ["candidateId"]),

  drafts: defineTable({
    ownerId: v.string(),
    candidateId: v.id("candidates"),
    channel: channelValidator,
    version: v.number(),
    /** 제목이 있는 채널(show_hn, show_gn, blog_outline)만 */
    title: v.optional(v.string()),
    body: v.string(),
    /** 이미지/GIF 슬롯 안내 */
    mediaHint: v.optional(v.string()),
    lint: v.array(v.object({ rule: v.string(), ok: v.boolean(), detail: v.optional(v.string()) })),
    status: v.union(
      v.literal("proposed"),
      v.literal("edited"),
      v.literal("copied"),
      v.literal("dropped"),
    ),
    model: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_candidate", ["candidateId"])
    .index("by_owner_status", ["ownerId", "status"]),

  draftEdits: defineTable({
    ownerId: v.string(),
    draftId: v.id("drafts"),
    channel: channelValidator,
    before: v.string(),
    after: v.string(),
    promotedExampleId: v.optional(v.id("examples")),
    createdAt: v.number(),
  }).index("by_draft", ["draftId"]),

  /** 채널별 문체 예시. seed(초기 best practice) → approved/edited(사용자 것)로 교체된다. */
  examples: defineTable({
    ownerId: v.string(),
    channel: channelValidator,
    lang: v.union(v.literal("ko"), v.literal("en")),
    title: v.optional(v.string()),
    body: v.string(),
    source: v.union(v.literal("seed"), v.literal("approved"), v.literal("edited")),
    note: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_owner_channel_active", ["ownerId", "channel", "active"]),

  publications: defineTable({
    ownerId: v.string(),
    candidateId: v.id("candidates"),
    draftId: v.optional(v.id("drafts")),
    channel: channelValidator,
    url: v.string(),
    publishedAt: v.number(),
    /** 수동 입력 반응 지표 */
    manualStats: v.optional(v.object({ likes: v.optional(v.number()), comments: v.optional(v.number()), reposts: v.optional(v.number()) })),
  })
    .index("by_candidate", ["candidateId"])
    .index("by_owner_time", ["ownerId", "publishedAt"]),

  metricSnapshots: defineTable({
    ownerId: v.string(),
    repo: v.string(),
    candidateId: v.optional(v.id("candidates")),
    at: v.number(),
    stars: v.number(),
    forks: v.number(),
    viewsUniques14d: v.optional(v.number()),
    referrers: v.optional(v.array(v.object({ referrer: v.string(), uniques: v.number() }))),
    npmDownloadsMonth: v.optional(v.number()),
  })
    .index("by_owner_repo_time", ["ownerId", "repo", "at"])
    .index("by_candidate_time", ["candidateId", "at"]),

  feedback: defineTable({
    ownerId: v.string(),
    targetType: v.union(v.literal("judgment"), v.literal("draft"), v.literal("candidate")),
    targetId: v.string(),
    reason: v.union(
      v.literal("wrong_facts"),
      v.literal("voice"),
      v.literal("wrong_channel"),
      v.literal("not_yet"),
      v.literal("not_worth"),
      v.literal("other"),
    ),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_owner_time", ["ownerId", "createdAt"]),

  settings: defineTable({
    ownerId: v.string(),
    rubricWeights: rubricScoresValidator,
    draftThreshold: v.number(),
    deferThreshold: v.number(),
    enabledChannels: v.array(channelValidator),
    bannedPhrases: v.array(v.string()),
    /** (구) 모델 ID. llm.model로 이전됨 */
    model: v.string(),
    llm: v.optional(llmConfigValidator),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  /**
   * 서버 Gemini 키 풀 상태. 액션은 무상태라 쿨다운·일일 사용량을 여기 둔다.
   * label = free-N. 유료 키는 이 테이블에 오지 않는다.
   */
  llmKeyState: defineTable({
    label: v.string(),
    lastUsedAt: v.number(),
    /** 이 시각까지 순환에서 제외 */
    cooldownUntil: v.optional(v.number()),
    cooldownReason: v.optional(v.string()),
    /** PT 기준 날짜 키(YYYY-MM-DD)와 그날 요청 수 */
    dayKey: v.string(),
    dayCount: v.number(),
    /** 마지막 429의 quotaId / retryDelay (관찰용) */
    lastQuotaId: v.optional(v.string()),
    lastRetryDelay: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
  }).index("by_label", ["label"]),

  /** LLM 작업 큐. local-agent 프로바이더는 워커(scripts/agent-worker.mjs)가 가져가서 처리한다. */
  llmJobs: defineTable({
    ownerId: v.string(),
    kind: v.union(v.literal("digest"), v.literal("judge"), v.literal("draft")),
    candidateId: v.id("candidates"),
    channel: v.optional(channelValidator),
    system: v.string(),
    user: v.string(),
    schemaJson: v.string(),
    status: v.union(v.literal("pending"), v.literal("claimed"), v.literal("done"), v.literal("failed")),
    runner: v.optional(v.string()),
    resultJson: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_candidate", ["candidateId"]),
});
