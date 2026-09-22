/**
 * 채널 = 플랫폼. 언어는 채널의 설정이다 (채널마다 여러 언어, 코드는 자유).
 * 초안은 (channel, lang) 쌍으로 만들어진다. Show HN처럼 언어가 고정된 채널도 있다.
 */
export type Channel = "x" | "threads" | "linkedin" | "show_hn" | "show_gn" | "blog";

export type ChannelSpec = {
  id: Channel;
  label: string;
  /** 고정 언어가 있으면 그 언어만. 없으면 사용자가 고른다. */
  fixedLang?: string;
  defaultLangs: string[];
  maxChars: number | null;
  hasTitle: boolean;
  titleMaxChars?: number;
  /** 언어와 무관한 형식 규칙 (LLM에 그대로 전달) */
  rules: string;
  mediaHint: string;
  composeUrl: string;
  /** 복사한 뒤 올리기 전에 확인할 것 */
  runbook: string[];
};

export const CHANNELS: Record<Channel, ChannelSpec> = {
  x: {
    id: "x", label: "X", defaultLangs: ["en", "ko"], maxChars: 280, hasTitle: false,
    rules: "Exactly three short lines separated by blank lines. Line 1: the concrete change or a problem explicitly supported by Facts, no adjectives. Use first-person experience only if Facts explicitly describes the author having that experience. Line 2: what changed for the user, one sentence. Line 3: a supplied number or limitation if available, then the link. Omit missing evidence rather than inventing it or inserting placeholders. No hashtags, no emoji, no exclamation marks, no 'excited', no 'introducing'.",
    mediaHint: "터미널 GIF 또는 실제 출력 스크린샷 1장 (홈 경로·내부 브랜치명 가리기)",
    composeUrl: "https://x.com/compose/post",
    runbook: ["영어 글은 화~목 미국 동부 오전 9~11시(한국 22~24시), 한국어 글은 평일 오전 8~9시나 저녁 21~22시", "이미지 1장: 터미널 GIF 또는 실제 출력 스크린샷 (홈 경로·내부 브랜치명 가리기)", "링크는 본문 마지막 줄에", "올린 뒤 첫 답글로 저장소 링크나 데모를 한 번 더"],
  },
  threads: {
    id: "threads", label: "Threads", defaultLangs: ["ko"], maxChars: 500, hasTitle: false,
    rules: "One or two sentences, conversational. Take a position or end with a question rather than informing. No link in the body (it goes in the first reply).",
    mediaHint: "선택. 스크린샷 1장이면 충분",
    composeUrl: "https://www.threads.net/",
    runbook: ["링크는 본문이 아니라 첫 댓글에", "올린 뒤 30~60분은 답글에 바로 반응 (초기 반응이 노출을 결정)"],
  },
  linkedin: {
    id: "linkedin", label: "LinkedIn", defaultLangs: ["ko"], maxChars: 3000, hasTitle: false,
    rules: "First line is the result or the problem in one sentence, under 40 characters so it ends above the fold. Then 3-5 paragraphs: problem → what was built → numbers or before/after → what was learned → link. 2-3 sentences per paragraph. No emoji bullets. Hashtags only on the last line, at most 3. No 'excited to share' phrasing.",
    mediaHint: "실제 데이터가 보이는 스크린샷 1장 (대시보드, 터미널 출력, 전후 비교)",
    composeUrl: "https://www.linkedin.com/feed/?shareActive=true",
    runbook: ["화~목 오전 7~9시가 도달이 가장 좋음. 주말은 피함", "첫 줄이 접힘선 위에서 끝나는지 확인 (40자)", "실제 데이터가 보이는 스크린샷 1장", "해시태그는 마지막 줄 최대 3개"],
  },
  show_hn: {
    id: "show_hn", label: "Show HN", fixedLang: "en", defaultLangs: ["en"], maxChars: 2000, hasTitle: true, titleMaxChars: 80,
    rules: "Title: 'Show HN: <Name> – <plain one-line description>', no adjectives, no hype, under 80 chars. Body is a suggested first comment. Open with the concrete change. Describe the problem and affected audience only if Facts explicitly supplies them. Paragraph 2: what it does and the mechanism, 2-3 sentences. Discuss only design choices explicitly supported by Facts; do not infer motivations or new consequences. If Facts supplies limitations, add a 'Limitations:' paragraph using only those. Omit it when none are supplied. Last paragraph: one genuine open question for the reader. Never ask for upvotes. No emoji. No exclamation marks.",
    mediaHint: "링크는 GitHub 저장소. README 상단에 데모 GIF가 있어야 함",
    composeUrl: "https://news.ycombinator.com/submit",
    runbook: ["화~목 미국 동부 오전 8~10시 (한국 저녁 21~23시), 또는 일요일 저녁", "제출 링크는 GitHub 저장소. README 상단에 데모 GIF가 있어야 함", "제출 직후 위 본문을 첫 댓글로", "48시간 동안 2시간 안에 모든 댓글에 답. 방어적이지 않게", "어디에도 투표 요청 금지. 삭제 후 재등록 금지"],
  },
  show_gn: {
    id: "show_gn", label: "Show GN", fixedLang: "ko", defaultLangs: ["ko"], maxChars: 3000, hasTitle: true, titleMaxChars: 80,
    rules: "Title: 'Show GN: <이름> - <한 줄 설명>'. Use short Korean sections grounded in Facts: 무엇이 달라졌나 / 변경 내용. Add 왜 / 기존 도구와 다른 점 / 기술 결정 / 한계 only when Facts explicitly supports that section. Do not present a release change as a comparison with other tools. Facts only, no marketing words. Include a runnable command only if Facts supplies that exact command. Omit unsupported sections. Never ask for votes or comments.",
    mediaHint: "링크는 GitHub 저장소 또는 데모 페이지",
    composeUrl: "https://news.hada.io/new",
    runbook: ["평일 오전 9~11시 등록이 첫 화면에 오래 남음", "사실만, 마케팅 어휘 없이 (GeekNews 가이드)", "지인에게 추천·댓글 부탁 금지", "버전마다 재등록 금지. 큰 변화가 있을 때만"],
  },
  blog: {
    id: "blog", label: "블로그 개요", defaultLangs: ["ko"], maxChars: 2000, hasTitle: true, titleMaxChars: 60,
    rules: "Do not write the article. Outline only: 3 title candidates (each under 30 characters, with a number or a concrete situation), 4-6 sections each with one line on which facts, numbers or screenshots go there, and a final line 'what to ask the reader'.",
    mediaHint: "",
    composeUrl: "",
    runbook: ["개요를 블로그 저장소의 초안으로 옮겨 본문을 씀", "발행 후 URL을 등록하면 다른 채널에 재배포 후보가 됨"],
  },
};

export const ALL_CHANNELS = Object.keys(CHANNELS) as Channel[];

/** 채널별 언어 설정. 기본값. */
export type ChannelLangs = Partial<Record<Channel, string[]>>;
export const DEFAULT_CHANNEL_LANGS: ChannelLangs = { x: ["en", "ko"], linkedin: ["ko"], show_hn: ["en"], show_gn: ["ko"] };

/** 설정에서 활성화된 (channel, lang) 쌍. 고정 언어 채널은 설정과 무관하게 그 언어. */
export function enabledTargets(langs: ChannelLangs): { channel: Channel; lang: string }[] {
  const out: { channel: Channel; lang: string }[] = [];
  for (const ch of ALL_CHANNELS) {
    const spec = CHANNELS[ch];
    const list = langs[ch];
    if (!list || list.length === 0) continue;
    for (const lang of spec.fixedLang ? [spec.fixedLang] : list) out.push({ channel: ch, lang });
  }
  return out;
}

/** 언어 코드 → 이름과 문체 힌트. 목록에 없는 코드도 쓸 수 있다 (이름은 코드 그대로). */
export const LANGS: Record<string, { name: string; nativeName: string; style: string }> = {
  en: { name: "English", nativeName: "English", style: "Plain, direct, no exclamation marks." },
  ko: { name: "Korean", nativeName: "한국어", style: "존댓말 평서형('만들었습니다'). 감탄사 없음. 번역투 금지, 짧은 문장." },
  ja: { name: "Japanese", nativeName: "日本語", style: "です・ます調。誇張なし。" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文", style: "平实直接，避免营销用语。" },
  es: { name: "Spanish", nativeName: "Español", style: "Registro neutro, sin exclamaciones." },
  de: { name: "German", nativeName: "Deutsch", style: "Sachlich, ohne Superlative." },
  fr: { name: "French", nativeName: "Français", style: "Ton sobre, sans superlatifs." },
  pt: { name: "Portuguese", nativeName: "Português", style: "Registro neutro, sem exclamações." },
};
export function langName(code: string): string { return LANGS[code]?.nativeName ?? code; }
export function langInstruction(code: string): string {
  const l = LANGS[code];
  return l ? `Write in ${l.name}. ${l.style}` : `Write in the language with code "${code}".`;
}
export const targetKey = (channel: string, lang: string) => `${channel}:${lang}`;
