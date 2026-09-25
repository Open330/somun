/**
 * somun ↔ 영상 서버가 주고받는 모양. 영상 서버는 somun DB를 모르고, 이 기획서만 받는다.
 * 기획서는 somun이 글감의 근거 사실·검수한 초안·프로필로 채운다. 모델은 기획서 밖의 사실을 쓰지 않는다.
 */
export const VIDEO_DURATIONS = [10, 15, 20] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];
export const VIDEO_ASPECTS = ["16:9", "1:1"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];
export const DEFAULT_VIDEO_DURATION: VideoDuration = 15;

export const VIDEO_SIZE: Record<VideoAspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

export type VideoBrief = {
  /** 화면에 쓸 이름(프로필의 naming 또는 저장소 이름). */
  project: string;
  repoUrl: string;
  /** 화면 글자의 언어. */
  lang: string;
  durationSec: VideoDuration;
  aspect: VideoAspect;
  /** 글감 제목과 한 줄 요약. */
  headline: string;
  /** 모델이 읽는 사실 목록(프로필, 이번 변화, 숫자, 한계). */
  facts: string;
  /** 화면의 숫자를 맞춰 볼 원문. 초안 린트와 같은 근거다. */
  grounding: string;
  /** 사용자가 검수한 초안. 영상의 대본 뼈대로 쓴다. */
  script?: string;
  /** 문체 지침(문체 프리셋 + 사용자 지침). */
  voice: string;
  bannedPhrases: string[];
  /** 저장소 홈페이지에서 읽은 색·글꼴. 색 코드와 글꼴 이름만 담긴다. */
  brand?: { accents: string[]; background?: string; ink?: string; fonts: string[]; source: string };
};

export type RenderStatus = "queued" | "working" | "done" | "failed";
/** done이지만 모델의 메모를 아직 기다리는 단계. 세션이 끝나면 "Done"이 된다. */
export const RENDER_SETTLED_PHASE = "Done";
/** 더 볼 것이 남았는가: 진행 중이거나, 영상은 나왔는데 메모를 기다리는 중. */
export const renderUnsettled = (v: { status: RenderStatus; phase: string }) => v.status === "queued" || v.status === "working" || (v.status === "done" && v.phase !== RENDER_SETTLED_PHASE);

/** 영상 서버의 렌더 상태. somun이 이것을 받아 자기 행에 옮긴다. */
export type RenderView = {
  id: string;
  status: RenderStatus;
  phase: string;
  /** 모델이 끝에 남긴 메모(기획서 밖에서 정한 것이 있으면 여기에 적는다). */
  note?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** somun 화면이 보는 영상 한 건. */
export type VideoItem = {
  id: number;
  candidateId: number;
  draftId?: number;
  lang: string;
  durationSec: number;
  aspect: VideoAspect;
  status: RenderStatus;
  phase: string;
  note?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** 영상 서버가 아는 bridge 연결 상태. */
export type BridgeStatus = { id: string; owner: string; lastSeenAt?: number; connected: boolean };

/** somun 설정 화면의 bridge 토큰 한 줄. */
export type BridgeTokenView = { id: string; label: string; createdAt: number; lastSeenAt?: number; connected: boolean };

/** GET /api/video: 영상 기능 켜짐, bridge가 접속할 주소, 지금 연결된 bridge가 있는가. */
export type VideoConfigView = { enabled: boolean; bridgeUrl?: string; bridgeConnected?: boolean };
