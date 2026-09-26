/** 서버와 웹이 공유하는 도메인 타입. DB 행과 API 응답의 모양. */
import type { Channel, ChannelLangs } from "../core/channels.js";
import type { CheckItem } from "../core/launch-check.js";
export type { Channel, ChannelLangs } from "../core/channels.js";

export type SourceKind = "github" | "npm" | "blog" | "sessions" | "omp";
export type SignalKind = "release" | "pr_merged" | "repo_created" | "readme_changed" | "star_milestone" | "download_milestone" | "blog_post" | "omp_session";
export type CandidateType = "release" | "new-repo" | "milestone" | "blog" | "in-progress";
export type CandidateStatus = "new" | "judged" | "drafted" | "published" | "dropped" | "deferred";
export type Decision = "draft" | "defer" | "ask";
export type DraftStatus = "proposed" | "edited" | "copied" | "dropped";
export type FeedbackReason = "wrong_facts" | "voice" | "wrong_channel" | "not_yet" | "not_worth" | "other";
/** 화면 언어. 서버가 만드는 사용자용 문장(오류, 판단 이유, 알림)과 모델에게 시키는 설명 언어도 따른다. */
import type { Locale } from "./locale.js";
export type { Locale };
export type LlmProvider = "gemini" | "anthropic" | "openai" | "local-agent";
/**
 * lesson: 수정·버림에서 문체 규칙 한 줄을 뽑는다. profile: 저장소 프로필을 만든다(local-agent 모드).
 * 둘은 글감에 딸린 생성 단계가 아니라서 생성 진행 상태에 보이지 않는다.
 */
export type JobKind = "digest" | "judge" | "draft" | "lesson" | "profile";
/** 글감 생성 단계(digest → judge → draft)가 아닌 작업. */
export const SIDE_JOB_KINDS = ["lesson", "profile"] as const;
export type GenerationKind = Exclude<JobKind, (typeof SIDE_JOB_KINDS)[number]>;
export type DraftPurpose = "introduction" | "update";
/** llm_jobs.meta. 생성 당시 초안 목적 또는 프로필의 저장소·README 해시. */
export type JobMeta = { draftPurpose?: DraftPurpose; repo?: string; readmeHash?: string; /** 처음 요청한 시각. 다시 시도해도 유지된다. */ queuedAt?: number };
export type JobStatus = "pending" | "claimed" | "done" | "failed";

export type RubricScores = { runnable: number; numbers: number; lesson: number; novelty: number; audience: number };

export type Evidence = {
  repo: string; repoUrl: string; description?: string; version?: string; releaseNotes?: string; stars?: number; forks?: number;
  commitCount?: number; releaseCount?: number; firstReleaseAt?: string; language?: string; license?: string; homepage?: string;
  npmPackage?: string; npmMonthlyDownloads?: number; demoAsset?: string; limitations?: string[]; /** 한계의 출처. readme면 다음 수집 때 README 결과로 통째로 바뀐다. */ limitationsSource?: "readme" | "digest"; readmeExcerpt?: string;
  /** README가 실험·로컬 전용으로 표시한 기능(절 제목). */ experimental?: string[];
  mergedPrTitles?: string[]; ompSummary?: string; commitSubjects?: string[]; highlights?: string[]; highlightsAt?: number;
  /** 원자료에서 찾지 못한 수치가 있어 highlights에서 뺀 요약. 판단·초안에 들어가지 않는다. */
  unverifiedHighlights?: { text: string; numbers: string[] }[];
  /** 이 창에서 넘은 임계. 글감이 아니라 사실로 쓴다. */
  milestones?: { metric: "stars" | "downloads"; threshold: number; at: number }[];
};

export type LlmConfig = { provider: LlmProvider; model?: string; draftModel?: string; apiKey?: string; baseUrl?: string; agentCli?: "claude" | "codex" };

export type Settings = {
  rubricWeights: RubricScores;
  draftThreshold: number;
  deferThreshold: number;
  /** 채널별 활성 언어. 비어 있으면 그 채널은 꺼진 것. */
  channelLangs: ChannelLangs;
  bannedPhrases: string[];
  llm: LlmConfig;
  /** 새 글감 처리 방식. manual: 모아만 두고 사용자가 고른 것만 판단. auto: 최근 recentDays 안에 갱신된 글감은 자동으로 판단·초안. */
  watch: WatchSettings;
  /** 문체: 프리셋 + 자유 지침. useExamples가 꺼져 있으면 문체 예시는 프롬프트에 넣지 않는다. */
  voice: VoiceSettings;
  /** 화면 상태. 온보딩 체크리스트를 닫은 시각 등. */
  ui?: { onboardingDismissedAt?: number; locale?: Locale };
  /** 알림. Discord 웹훅 하나. weekly면 월요일 09:00 KST에 요약을 보낸다. */
  notify?: { discordWebhookUrl?: string; weekly: boolean; lastSentAt?: number };
  /** 복사할 때 홈페이지·App Store 링크에 채널 표시(utm, ct)를 붙인다. 기본 켜짐. */
  trackLinks?: boolean;
};
export type WatchSettings = { mode: "manual" | "auto"; recentDays: number };
export type VoiceSettings = { preset: string; guide: string; useExamples: boolean; chosenAt?: number };

/** GitHub App 설치가 볼 수 있는 저장소 하나. 고르기 화면용. */
export type InstallationRepo = { fullName: string; description?: string; pushedAt?: number; stars: number; language?: string; fork: boolean; archived: boolean; isPrivate: boolean; watched: boolean };
/** 화면에 주는 설정. 키 원문 대신 설정 여부와 끝자리만. */
export type SettingsView = Omit<Settings, "llm" | "notify"> & { llm: Omit<LlmConfig, "apiKey"> & { apiKeySet: boolean; apiKeyHint?: string }; notify?: { weekly: boolean; lastSentAt?: number; discordWebhookSet: boolean } };

export type Source = { id: number; kind: SourceKind; targets: string[]; options?: Record<string, string>; enabled: boolean; lastPolledAt?: number; lastError?: string };

export type Judgment = { id: number; candidateId: number; scores: RubricScores; total: number; reasoning: string; angle?: string; decision: Decision; suggestedChannels: Channel[]; model: string; overriddenDecision?: "draft" | "drop"; overrideReason?: string; createdAt: number };

/** 올리기 전 홈페이지 점검. items가 비어 있으면 점검할 홈페이지가 없거나(GitHub 페이지 포함) 열리지 않은 것. */
export type LaunchCheck = { homepage?: string; items: CheckItem[]; checkedAt?: number; unreachable?: boolean };

export type LintResult = { rule: string; ok: boolean; detail?: string };

export type Draft = { purpose?: DraftPurpose; id: number; candidateId: number; channel: Channel; lang: string; version: number; title?: string; body: string; mediaHint?: string; lint: LintResult[]; status: DraftStatus; model: string; voice?: string; createdAt: number; updatedAt: number };

/** 지침 제안: 수정·버림에서 배운 한 줄 규칙. */
export type GuideSuggestion = { id: number; rule: string; category: "voice" | "structure" | "facts" | "format"; count: number; sources: { kind: "edit" | "drop"; draftId: number; at: number }[]; status: "pending" | "accepted" | "dismissed"; createdAt: number; updatedAt: number };

/** 발행 성과 요약. 채널·문체별 평균. */
/** avgStarDelta: 발행 후 7일 스타 증가 평균. avgExcessStars: 그중 발행 전 추세를 뺀 증가(발행 효과) 평균. */
export type PerformanceSummary = { byChannel: { key: string; label: string; count: number; avgStarDelta?: number; avgExcessStars?: number; avgUniques?: number; avgLikes?: number }[]; byVoice: { key: string; count: number; avgStarDelta?: number; avgExcessStars?: number; avgLikes?: number }[] };

export type Candidate = { id: number; type: CandidateType; title: string; repo: string; key: string; evidence: Evidence; status: CandidateStatus; latestJudgmentId?: number; createdAt: number; updatedAt: number };

export type CandidateListItem = Candidate & { unpublishedDraftCount?: number; judgment: Judgment | null };

export type AutoStats = { likes?: number; comments?: number; reposts?: number; views?: number; score?: number; source: string };
export type Publication = { id: number; candidateId: number; draftId?: number; channel: Channel; lang?: string; url: string; publishedAt: number; manualStats?: { likes?: number; comments?: number; reposts?: number }; autoStats?: AutoStats; autoStatsAt?: number };

export type MetricPoint = { at: number; stars: number; uniques?: number; downloads?: number };
export type PublicationWithMetrics = Publication & {
  candidateTitle: string; repo: string; baselineStars?: number; latestStars?: number; series: MetricPoint[]; voice?: string;
  /** 발행 후 7일 스타 증가, 발행 전 추세로 기대한 증가, 그 차이(발행 효과). 자료가 모자라면 없음. */
  starDelta7d?: number; expectedStarDelta7d?: number; excessStars7d?: number;
};

export type Example = { id: number; channel: Channel; lang: string; title?: string; body: string; source: "seed" | "approved" | "edited"; note?: string; active: boolean; createdAt: number };

export type KeyStatus = { label: string; todayCount: number; cap: number; cooldownUntil?: number; cooldownReason?: string; lastUsedAt?: number; lastQuotaId?: string };

export type GenerationPlan = { introduction?: boolean; targets: { channel: Channel; lang: string }[]; instruction?: string };
export type JobProgress = { id: number; kind: JobKind; candidateId: number; /** profile 작업의 저장소. */ repo?: string; channel?: Channel; lang?: string; status: JobStatus; executor: "local" | "server"; error?: string; createdAt: number; finishedAt?: number };

export type Job = { continuation?: GenerationPlan; id: number; kind: JobKind; candidateId: number; channel?: Channel; lang?: string; system: string; user: string; schemaJson: string; status: JobStatus; runner?: string; error?: string; createdAt: number };

/** 저장소 프로필: 정체성의 기준선. 다이제스트·판단·초안이 "이 프로젝트는 이런 것"으로 받는다. */
export type RepoProfile = {
  what: string;
  audience: string;
  claims: string[];
  stage: "experiment" | "beta" | "stable" | "archived" | "unknown";
  limitations: string[];
  naming: string;
  avoid: string[];
};
export type RepoProfileView = { repo: string; profile: RepoProfile; editedFields: (keyof RepoProfile)[]; model: string; updatedAt: number };

export type CandidateDetail = { unpublishedDraftCount?: number; candidate: Candidate; judgments: Judgment[]; drafts: Draft[]; publications: Publication[]; signals: { id: number; kind: SignalKind; title: string; occurredAt: number }[]; profile?: RepoProfileView; told: { text: string; publishedAt?: number; publishedChannel?: string; candidateId?: number }[]; consistency: { channel: Channel; langs: string[]; onlyIn: { lang: string; numbers: string[] }[] }[] };

/** SSE 이벤트: 어느 자원이 바뀌었는지만. 화면은 다시 fetch한다. */
export type ChangeEvent = { resource: "candidates" | "drafts" | "publications" | "settings" | "sources" | "examples" | "keys" | "jobs"; id?: number };

export type ConnectorsView = {
  github: { mode: "app" | "token" | "none"; appConfigured: boolean; appSlug?: string; installUrl?: string; installations: { id: number; account: string; repos: number; watched: number; updatedAt: number }[]; manualTargets: string[]; lastPolledAt?: number; lastError?: string };
  sessions: { lastUploadAt?: number; sessionCount14d: number; sources: string[] };
};

/** 학습 효과. 복사한 초안 기준: 고치지 않고 쓴 비율과 평균 수정량(0~1). 낮아질수록 초안이 내 문체에 가까워진 것. */
export type LearningBucket = { copied: number; unchangedRate: number; avgEditRatio: number };
export type LearningStats = LearningBucket & {
  byWeek: (LearningBucket & { week: string })[];
  /** 문체 설정 버전별. 처음 쓰인 순서. 설정을 바꾼 뒤 수정량이 줄었는지 본다. */
  byStyle: (LearningBucket & { styleKey: string; firstAt: number; current: boolean })[];
  byChannel: (LearningBucket & { channel: Channel })[];
  guideLines: number;
  activeOwnExamples: number;
};
