/** 서버와 웹이 공유하는 도메인 타입. DB 행과 API 응답의 모양. */
import type { Channel, ChannelLangs } from "../core/channels.js";
export type { Channel, ChannelLangs } from "../core/channels.js";

export type SourceKind = "github" | "npm" | "blog" | "sessions" | "omp";
export type SignalKind = "release" | "pr_merged" | "repo_created" | "readme_changed" | "star_milestone" | "download_milestone" | "blog_post" | "omp_session";
export type CandidateType = "release" | "new-repo" | "milestone" | "blog" | "in-progress";
export type CandidateStatus = "new" | "judged" | "drafted" | "published" | "dropped" | "deferred";
export type Decision = "draft" | "defer" | "ask";
export type DraftStatus = "proposed" | "edited" | "copied" | "dropped";
export type FeedbackReason = "wrong_facts" | "voice" | "wrong_channel" | "not_yet" | "not_worth" | "other";
export type LlmProvider = "gemini" | "anthropic" | "openai" | "local-agent";
export type JobKind = "digest" | "judge" | "draft";
export type JobStatus = "pending" | "claimed" | "done" | "failed";

export type RubricScores = { runnable: number; numbers: number; lesson: number; novelty: number; audience: number };

export type Evidence = {
  repo: string; repoUrl: string; description?: string; version?: string; releaseNotes?: string; stars?: number; forks?: number;
  commitCount?: number; releaseCount?: number; firstReleaseAt?: string; language?: string; license?: string; homepage?: string;
  npmPackage?: string; npmMonthlyDownloads?: number; demoAsset?: string; limitations?: string[]; /** 한계의 출처. readme면 다음 수집 때 README 결과로 통째로 바뀐다. */ limitationsSource?: "readme" | "digest"; readmeExcerpt?: string;
  mergedPrTitles?: string[]; ompSummary?: string; commitSubjects?: string[]; highlights?: string[]; highlightsAt?: number;
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
  ui?: { onboardingDismissedAt?: number };
  /** 알림. Discord 웹훅 하나. weekly면 월요일 09:00 KST에 요약을 보낸다. */
  notify?: { discordWebhookUrl?: string; weekly: boolean; lastSentAt?: number };
};
export type WatchSettings = { mode: "manual" | "auto"; recentDays: number };
export type VoiceSettings = { preset: string; guide: string; useExamples: boolean; chosenAt?: number };

/** GitHub App 설치가 볼 수 있는 저장소 하나. 고르기 화면용. */
export type InstallationRepo = { fullName: string; description?: string; pushedAt?: number; stars: number; language?: string; fork: boolean; archived: boolean; isPrivate: boolean; watched: boolean };
/** 화면에 주는 설정. 키 원문 대신 설정 여부와 끝자리만. */
export type SettingsView = Omit<Settings, "llm" | "notify"> & { llm: Omit<LlmConfig, "apiKey"> & { apiKeySet: boolean; apiKeyHint?: string }; notify?: { weekly: boolean; lastSentAt?: number; discordWebhookSet: boolean } };

export type Source = { id: number; kind: SourceKind; targets: string[]; options?: Record<string, string>; enabled: boolean; lastPolledAt?: number; lastError?: string };

export type Judgment = { id: number; candidateId: number; scores: RubricScores; total: number; reasoning: string; decision: Decision; suggestedChannels: Channel[]; model: string; overriddenDecision?: "draft" | "drop"; overrideReason?: string; createdAt: number };

export type LintResult = { rule: string; ok: boolean; detail?: string };

export type Draft = { id: number; candidateId: number; channel: Channel; lang: string; version: number; title?: string; body: string; mediaHint?: string; lint: LintResult[]; status: DraftStatus; model: string; voice?: string; createdAt: number; updatedAt: number };

/** 지침 제안: 수정·버림에서 배운 한 줄 규칙. */
export type GuideSuggestion = { id: number; rule: string; category: "voice" | "structure" | "facts" | "format"; count: number; sources: { kind: "edit" | "drop"; draftId: number; at: number }[]; status: "pending" | "accepted" | "dismissed"; createdAt: number; updatedAt: number };

/** 발행 성과 요약. 채널·문체별 평균. */
export type PerformanceSummary = { byChannel: { key: string; label: string; count: number; avgStarDelta?: number; avgUniques?: number; avgLikes?: number }[]; byVoice: { key: string; count: number; avgStarDelta?: number; avgLikes?: number }[] };

export type Candidate = { id: number; type: CandidateType; title: string; repo: string; key: string; evidence: Evidence; status: CandidateStatus; latestJudgmentId?: number; createdAt: number; updatedAt: number };

export type CandidateListItem = Candidate & { judgment: Judgment | null };

export type AutoStats = { likes?: number; comments?: number; reposts?: number; views?: number; score?: number; source: string };
export type Publication = { id: number; candidateId: number; draftId?: number; channel: Channel; lang?: string; url: string; publishedAt: number; manualStats?: { likes?: number; comments?: number; reposts?: number }; autoStats?: AutoStats; autoStatsAt?: number };

export type MetricPoint = { at: number; stars: number; uniques?: number; downloads?: number };
export type PublicationWithMetrics = Publication & { candidateTitle: string; repo: string; baselineStars?: number; latestStars?: number; series: MetricPoint[]; voice?: string };

export type Example = { id: number; channel: Channel; lang: string; title?: string; body: string; source: "seed" | "approved" | "edited"; note?: string; active: boolean; createdAt: number };

export type KeyStatus = { label: string; todayCount: number; cap: number; cooldownUntil?: number; cooldownReason?: string; lastUsedAt?: number; lastQuotaId?: string };

export type GenerationPlan = { targets: { channel: Channel; lang: string }[]; instruction?: string };
export type JobProgress = { id: number; kind: JobKind; candidateId: number; channel?: Channel; lang?: string; status: JobStatus; executor: "local" | "server"; error?: string; createdAt: number; finishedAt?: number };

export type Job = { id: number; kind: JobKind; candidateId: number; channel?: Channel; lang?: string; system: string; user: string; schemaJson: string; status: JobStatus; runner?: string; error?: string; createdAt: number };

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

export type CandidateDetail = { candidate: Candidate; judgments: Judgment[]; drafts: Draft[]; publications: Publication[]; signals: { id: number; kind: SignalKind; title: string; occurredAt: number }[]; profile?: RepoProfileView; told: { text: string; publishedAt?: number; publishedChannel?: string; candidateId?: number }[]; consistency: { channel: Channel; langs: string[]; onlyIn: { lang: string; numbers: string[] }[] }[] };

/** SSE 이벤트: 어느 자원이 바뀌었는지만. 화면은 다시 fetch한다. */
export type ChangeEvent = { resource: "candidates" | "drafts" | "publications" | "settings" | "sources" | "examples" | "keys" | "jobs"; id?: number };

export type ConnectorsView = {
  github: { mode: "app" | "token" | "none"; appConfigured: boolean; appSlug?: string; installUrl?: string; installations: { id: number; account: string; repos: number; watched: number; updatedAt: number }[]; manualTargets: string[]; lastPolledAt?: number; lastError?: string };
  sessions: { lastUploadAt?: number; sessionCount14d: number; sources: string[] };
};
