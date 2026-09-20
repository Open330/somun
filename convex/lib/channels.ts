/**
 * 채널 어댑터 정의. 형식 제약과 초안 프롬프트 조각.
 * 순수 데이터 — Convex 런타임과 브라우저 양쪽에서 import 가능.
 */

export type Channel =
  | "x_en"
  | "x_ko"
  | "threads"
  | "linkedin_ko"
  | "show_hn"
  | "show_gn"
  | "blog_outline";

export type Lang = "ko" | "en";

export type ChannelSpec = {
  id: Channel;
  label: string;
  lang: Lang;
  maxChars: number | null;
  hasTitle: boolean;
  titleMaxChars?: number;
  /** 초안 작성 규칙 (LLM에 그대로 전달) */
  rules: string;
  /** 사람이 붙일 이미지 안내 */
  mediaHint: string;
  /** 발행 화면으로 가는 링크 */
  composeUrl: string;
};

export const CHANNELS: Record<Channel, ChannelSpec> = {
  x_en: {
    id: "x_en",
    label: "X (English)",
    lang: "en",
    maxChars: 280,
    hasTitle: false,
    rules: [
      "Exactly three short lines separated by blank lines.",
      "Line 1: the concrete problem, in first person, past tense, no adjectives.",
      "Line 2: what the tool does about it (one sentence).",
      "Line 3: one number or one limitation, then the link.",
      "No hashtags, no emoji, no exclamation marks, no 'excited', no 'introducing'.",
    ].join(" "),
    mediaHint: "터미널 GIF 또는 실제 출력 스크린샷 1장 (홈 경로·내부 브랜치명 가리기)",
    composeUrl: "https://x.com/compose/post",
  },
  x_ko: {
    id: "x_ko",
    label: "X (한국어)",
    lang: "ko",
    maxChars: 280,
    hasTitle: false,
    rules: [
      "세 줄. 빈 줄로 구분.",
      "1줄: 겪은 문제를 1인칭 과거형으로, 수식어 없이.",
      "2줄: 도구가 그 문제에 무엇을 하는지 한 문장.",
      "3줄: 숫자 하나 또는 한계 하나, 그리고 링크.",
      "존댓말 평서형('만들었습니다'). 해시태그·이모지·감탄부호 금지.",
    ].join(" "),
    mediaHint: "x_en과 같은 이미지",
    composeUrl: "https://x.com/compose/post",
  },
  threads: {
    id: "threads",
    label: "Threads",
    lang: "ko",
    maxChars: 500,
    hasTitle: false,
    rules: [
      "1~2문장. 대화체 반말 또는 가벼운 존댓말.",
      "정보 전달이 아니라 입장을 취하거나 질문으로 끝낸다.",
      "링크는 넣지 않는다 (댓글에 단다).",
    ].join(" "),
    mediaHint: "선택. 스크린샷 1장이면 충분",
    composeUrl: "https://www.threads.net/",
  },
  linkedin_ko: {
    id: "linkedin_ko",
    label: "LinkedIn (한국어)",
    lang: "ko",
    maxChars: 3000,
    hasTitle: false,
    rules: [
      "첫 줄은 결과 또는 문제 한 문장. 접힘선 위에서 끝나야 하므로 40자 이내.",
      "본문 3~5문단: 문제 → 만든 것 → 숫자/전후 → 배운 것 → 링크.",
      "문단당 2~3문장. 이모지 목록 금지. 해시태그는 마지막 줄에 최대 3개.",
      "존댓말. '공유드립니다', '소개합니다' 같은 관용구 금지.",
    ].join(" "),
    mediaHint: "실제 데이터가 보이는 스크린샷 1장 (대시보드, 터미널 출력, 전후 비교)",
    composeUrl: "https://www.linkedin.com/feed/?shareActive=true",
  },
  show_hn: {
    id: "show_hn",
    label: "Show HN",
    lang: "en",
    maxChars: 2000,
    hasTitle: true,
    titleMaxChars: 80,
    rules: [
      "Title: 'Show HN: <Name> – <plain one-line description>'. No adjectives, no hype, under 80 chars.",
      "Body is the author's first comment, posted right after submission.",
      "Paragraph 1: the specific problem and who has it.",
      "Paragraph 2: what it does and the mechanism, 2-3 sentences.",
      "Paragraph 3: design choices worth arguing about.",
      "Paragraph 4: 'Limitations:' followed by 2-3 honest ones.",
      "Last paragraph: one genuine open question for the reader.",
      "Never ask for upvotes. No emoji. No exclamation marks.",
    ].join(" "),
    mediaHint: "링크는 GitHub 저장소. README 상단에 데모 GIF가 있어야 함",
    composeUrl: "https://news.ycombinator.com/submit",
  },
  show_gn: {
    id: "show_gn",
    label: "Show GN (GeekNews)",
    lang: "ko",
    maxChars: 3000,
    hasTitle: true,
    titleMaxChars: 80,
    rules: [
      "제목: 'Show GN: <이름> - <한 줄 설명>'.",
      "본문 절 순서: 무엇을 만들었나 / 왜 / 기존 도구와 다른 점 / 기술 결정 / 한계 / 듣고 싶은 피드백.",
      "각 절은 소제목 한 줄과 항목 2~4개. 마케팅 어휘('혁신', '강력한', '손쉽게') 금지.",
      "사실만. 실행 명령 하나 포함. 투표·댓글 요청 금지.",
    ].join(" "),
    mediaHint: "링크는 GitHub 저장소 또는 데모 페이지",
    composeUrl: "https://news.hada.io/new",
  },
  blog_outline: {
    id: "blog_outline",
    label: "블로그 개요",
    lang: "ko",
    maxChars: 2000,
    hasTitle: true,
    titleMaxChars: 60,
    rules: [
      "본문을 쓰지 않는다. 개요만.",
      "제목 후보 3개(각 30자 이내, 숫자나 구체적 상황 포함).",
      "절 구조 4~6개, 각 절에 넣을 사실·숫자·스크린샷을 한 줄씩.",
      "마지막에 '독자에게 물을 것' 한 줄.",
    ].join(" "),
    mediaHint: "",
    composeUrl: "",
  },
};

export const ALL_CHANNELS = Object.keys(CHANNELS) as Channel[];
export const DEFAULT_ENABLED_CHANNELS: Channel[] = ["x_en", "x_ko", "linkedin_ko", "show_hn", "show_gn"];
