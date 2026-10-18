/**
 * 채널 = 플랫폼. 언어는 채널의 설정이다 (채널마다 여러 언어, 코드는 자유).
 * 초안은 (channel, lang) 쌍으로 만들어진다. Show HN처럼 언어가 고정된 채널도 있다.
 */
export type BuiltinChannel = "x" | "threads" | "linkedin" | "show_hn" | "show_gn" | "blog";
export type Channel = BuiltinChannel | `custom_${string}`;
export type ChannelIdentity = { audience: string; purpose: string; tone: string; structure: string };

export type ChannelSpec = {
  id: Channel;
  label: string;
  identity?: ChannelIdentity;
  /** 고정 언어가 있으면 그 언어만. 없으면 사용자가 고른다. */
  fixedLang?: string;
  defaultLangs: string[];
  maxChars: number | null;
  /** 마침표·물음표 등으로 끝나는 본문의 최대 문장 수. 미설정이면 제한하지 않는다. */
  maxSentences?: number;
  hasTitle: boolean;
  titleMaxChars?: number;
  /** 언어와 무관한 형식 규칙 (LLM에 그대로 전달) */
  rules: string;
  mediaHint: string;
  composeUrl: string;
  linkPlacement?: "body" | "reply" | "none";
  /** 복사한 뒤 올리기 전에 확인할 것 */
  runbook: string[];
};

export const CHANNELS: Record<BuiltinChannel, ChannelSpec> = {
  x: {
    id: "x", label: "X", defaultLangs: ["en", "ko"], maxChars: 280, hasTitle: false,
    rules: "Default to ONE short factual sentence followed by the supplied link: name the project and what a reader can do. Use a second sentence only for a prerequisite or workflow step essential to understanding that SAME task. Keep a required threshold, flag or last-attempt condition attached to its operation. Do not append a separate disclaimer, a limitation about a different task, test counts, storage limits or another feature. No fixed paragraph count. Use first-person experience only if Facts explicitly describes the author having that experience. No hashtags, no emoji, no exclamation marks, no 'excited', no 'introducing'.",
    mediaHint: "터미널 GIF 또는 실제 출력 스크린샷 1장 (홈 경로·내부 브랜치명 가리기)",
    composeUrl: "https://x.com/compose/post",
    runbook: ["영어 글은 화~목 미국 동부 오전 9~11시(한국 22~24시), 한국어 글은 평일 오전 8~9시나 저녁 21~22시", "이미지 1장: 터미널 GIF 또는 실제 출력 스크린샷 (홈 경로·내부 브랜치명 가리기)", "링크는 본문 마지막 줄에", "올린 뒤 첫 답글로 저장소 링크나 데모를 한 번 더"],
  },
  threads: {
    id: "threads", label: "Threads", defaultLangs: ["ko"], maxChars: 500, maxSentences: 2, hasTitle: false,
    rules: "One or two sentences, conversational. Start with ONE concrete task or change, using an everyday action rather than a feature inventory. A second sentence may add an essential prerequisite or workflow step, or ask one specific question about that SAME task. Do not repeat a threshold or exception in different words. Do not append another change, an unrelated disclaimer or catalog metadata. A question is optional: omit it when it would only ask about general habits or repeat the opening. Do not invent an opinion or experience to sound conversational. No link in the body (it goes in the first reply).",
    mediaHint: "선택. 스크린샷 1장이면 충분",
    composeUrl: "https://www.threads.net/",
    runbook: ["링크는 본문이 아니라 첫 댓글에", "올린 뒤 30~60분은 답글에 바로 반응 (초기 반응이 노출을 결정)"],
  },
  linkedin: {
    id: "linkedin", label: "LinkedIn", defaultLangs: ["ko"], maxChars: 3000, hasTitle: false,
    rules: "First line is the concrete task or change in one sentence, under 40 characters so it ends above the fold. Use 2-5 short paragraphs including the link paragraph; one factual sentence per paragraph is enough. Add supporting details, a before/after, or a lesson only when Facts supplies them. When only one fact is supplied, the hook plus link is enough: never restate the hook to fill paragraphs. No emoji bullets. Hashtags only on the last line, at most 3. No 'excited to share' phrasing.",
    mediaHint: "실제 데이터가 보이는 스크린샷 1장 (대시보드, 터미널 출력, 전후 비교)",
    composeUrl: "https://www.linkedin.com/feed/?shareActive=true",
    runbook: ["화~목 오전 7~9시가 도달이 가장 좋음. 주말은 피함", "첫 줄이 접힘선 위에서 끝나는지 확인 (40자)", "실제 데이터가 보이는 스크린샷 1장", "해시태그는 마지막 줄 최대 3개"],
  },
  show_hn: {
    id: "show_hn", label: "Show HN", fixedLang: "en", defaultLangs: ["en"], maxChars: 2000, hasTitle: true, titleMaxChars: 80,
    rules: "Title: 'Show HN: <Name> – <plain one-line description>', no adjectives, no hype, under 80 chars. Body is a suggested first comment. Open with the concrete change. Describe the problem and affected audience only if Facts explicitly supplies them. Explain what it does using Facts. Include a mechanism or architecture paragraph only when Facts explicitly describes that mechanism; release bullet points do not establish an architecture. Omit this paragraph otherwise. Discuss only design choices explicitly supported by Facts; do not infer motivations or new consequences. Add a 'Limitations:' paragraph only for supplied constraints that affect trying or using the capability described in this post. Do not append unrelated retry, accounting or implementation caveats just because they appear in Facts. Omit the paragraph when no relevant limitation is supplied. Last paragraph: one genuine open question about the described task for the reader. Never ask for upvotes. No emoji. No exclamation marks.",
    mediaHint: "링크는 GitHub 저장소. README 상단에 데모 GIF가 있어야 함",
    composeUrl: "https://news.ycombinator.com/submit",
    runbook: ["화~목 미국 동부 오전 8~10시 (한국 저녁 21~23시), 또는 일요일 저녁", "제출 링크는 GitHub 저장소. README 상단에 데모 GIF가 있어야 함", "제출 직후 위 본문을 첫 댓글로", "48시간 동안 2시간 안에 모든 댓글에 답. 방어적이지 않게", "어디에도 투표 요청 금지. 삭제 후 재등록 금지"],
  },
  show_gn: {
    id: "show_gn", label: "Show GN", fixedLang: "ko", defaultLangs: ["ko"], maxChars: 3000, hasTitle: true, titleMaxChars: 80,
    rules: "Title: 'Show GN: <이름> - <한 줄 설명>'. Use one concise Korean section about the main change, with its heading on its own line (plain text or Markdown): 무엇이 달라졌나 or 변경 내용. Do not repeat the same fact under both headings or append the full release list unless the Editor instruction requests it. Add 왜 / 기존 도구와 다른 점 / 기술 결정 / 한계 only when Facts explicitly supports that section; the profile's 'why it exists' supports a 왜 section. Do not present a release change as a comparison with other tools. Facts only, no marketing words. Include a runnable command only if Facts supplies that exact command. Omit unsupported sections. Never ask for votes or comments.",
    mediaHint: "링크는 GitHub 저장소 또는 데모 페이지",
    composeUrl: "https://news.hada.io/new",
    runbook: ["평일 오전 9~11시 등록이 첫 화면에 오래 남음", "사실만, 마케팅 어휘 없이 (GeekNews 가이드)", "지인에게 추천·댓글 부탁 금지", "버전마다 재등록 금지. 큰 변화가 있을 때만"],
  },
  blog: {
    id: "blog", label: "블로그 개요", defaultLangs: ["ko"], maxChars: 2000, hasTitle: true, titleMaxChars: 60,
    rules: "Do not write the article. Outline only: 3 title candidates, each under 30 characters and describing a concrete task or change. Put each title on a separate line. Do not add numeric claims or title character counts to make titles concrete. Then write 4-6 short sections, each on its own line stating which supplied facts belong there, and a final line with an actual question to ask the reader, ending with a question mark.",
    mediaHint: "",
    composeUrl: "",
    runbook: ["개요를 블로그 저장소의 초안으로 옮겨 본문을 씀", "발행 후 URL을 등록하면 다른 채널에 재배포 후보가 됨"],
  },
};

export const ALL_CHANNELS = Object.keys(CHANNELS) as BuiltinChannel[];

/** 기본 채널의 편집 정체성. 플랫폼의 자동 게시 규칙이 아닌 초안 프리셋이다. */
export const CHANNEL_IDENTITIES: Record<BuiltinChannel, ChannelIdentity> = {
  x: { audience: "빠르게 훑어보는 사용자와 개발자", purpose: "한 가지 변화와 실제로 할 수 있는 일을 짧게 알리기", tone: "직접적이고 간결한 평서문", structure: "독자가 할 수 있는 변화 한 문장 → 필요할 때만 같은 과업의 설명 한 문장 → 링크" },
  threads: { audience: "경험과 관점에 반응하는 대화 상대", purpose: "구체적인 변화나 관점을 편하게 나누기", tone: "편안한 대화체, 한국어는 해요체. 과장 없이", structure: "한두 문장으로 변화 또는 관점. 질문은 같은 과업에 관해 물을 내용이 있을 때만. 링크는 첫 답글" },
  linkedin: { audience: "직무와 업무 맥락을 중시하는 동료", purpose: "업무에서 달라진 점과 근거 있는 경험 공유", tone: "차분하고 구체적인 업무 설명", structure: "짧은 훅 → 사실과 업무 맥락 → 근거 있는 시사점 → 링크" },
  show_hn: { audience: "직접 써 보고 기술적 선택을 논의하는 개발자", purpose: "실행 가능한 제품과 구현 내용을 소개", tone: "사실 중심, 기술적이고 솔직하게", structure: "제목 + 첫 댓글: 기능 → 근거 있는 동작/설계 → 한계 → 열린 질문" },
  show_gn: { audience: "기술 뉴스와 직접 쓸 도구를 찾는 한국어 독자", purpose: "핵심 기능이나 변화를 사실 중심으로 설명", tone: "간결한 한국어, 홍보 어휘 없이", structure: "제목 → 무엇인가/변경 내용 → 근거 있는 한계. 댓글/추천 요청 없이" },
  blog: { audience: "배경과 과정을 자세히 이해하려는 독자", purpose: "근거를 배치한 긴 글의 개요 준비", tone: "설명 중심의 차분한 문장", structure: "제목 후보 3개 → 4~6개 절과 넣을 근거 → 실제 독자 질문" },
};

/** 사용자 프리셋은 계정 설정에 저장한다. 기본 채널을 수정하거나 전역 레지스트리에 추가하지 않는다. */
export type CustomChannel = ChannelSpec & { id: `custom_${string}`; identity: ChannelIdentity };
export function channelSpec(channel: Channel, customChannels: readonly CustomChannel[] = []): ChannelSpec {
  const base = CHANNELS[channel as BuiltinChannel];
  if (base) return { ...base, linkPlacement: channel === "threads" ? "reply" : "body", identity: CHANNEL_IDENTITIES[channel as BuiltinChannel] };
  const custom = customChannels.find((c) => c.id === channel);
  if (custom) return custom;
  // 비활성화된 과거 초안은 이름 없이도 읽을 수 있다. API에서 새 요청은 등록된 채널만 허용한다.
  return { id: channel, label: channel, defaultLangs: ["ko"], maxChars: null, hasTitle: false, rules: "Facts only.", mediaHint: "", composeUrl: "", runbook: [] };
}
/** 소개는 변경 알림보다 맥락이 필요하다. 플랫폼 글자 수·링크 위치와 커스텀 프리셋은 보존한다. */
export function draftChannelSpec(spec: ChannelSpec, purpose?: "introduction" | "update" | null): ChannelSpec {
  if (purpose !== "introduction" || (spec.id !== "threads" && spec.id !== "x")) return spec;
  const threads = spec.id === "threads";
  return {
    ...spec,
    maxSentences: spec.maxSentences !== undefined && spec.maxSentences !== CHANNELS[spec.id as "threads" | "x"].maxSentences
      ? Math.min(spec.maxSentences, threads ? 6 : 4) : threads ? 6 : 4,
    rules: `Introduce the project in ${threads ? "3-5 short sentences in 2-3 short paragraphs when supported facts are available" : "2-4 short sentences within the configured character limit, with a supplied link"}. Start with a supported use situation or reader task, name the project and explain one core capability, then explain the input, action and result of that SAME task as needed. Do not select a separate capability to fill the sentence target. Each sentence must add information about that one workflow. Use fewer sentences when evidence is sparse; never pad the post. Preserve prerequisites and exclusions with the chosen capability. Do not end with a generic question about the reader's habits. Do not invent the author's experience, ownership, motivation, comparisons or outcomes. No hashtags, emoji or exclamation marks. ${spec.linkPlacement === "reply" || spec.linkPlacement === "none" ? "No URLs in the body." : "Use a supplied link in the body."}`,
    identity: spec.identity ? {
      ...spec.identity,
      purpose: "처음 보는 독자가 사용 상황과 핵심 기능을 이해할 수 있게 프로젝트 소개",
      structure: threads ? "근거 있는 사용 상황 → 프로젝트의 한 핵심 작업 → 그 작업의 입력·처리·결과. 짧은 문단, 습관 질문 없이. 링크는 첫 답글" : "사용 상황 또는 과업 → 프로젝트의 한 핵심 작업과 입력·처리·결과 → 링크. 글자 수 안에서, 습관 질문 없이",
    } : undefined,
  };
}

export function channelCatalog(customChannels: readonly CustomChannel[] = []): ChannelSpec[] {
  return [...ALL_CHANNELS.map((id) => channelSpec(id)), ...customChannels];
}
export function knownChannel(channel: string, customChannels: readonly CustomChannel[] = []): boolean {
  return Object.hasOwn(CHANNELS, channel) || customChannels.some((c) => c.id === channel);
}

/** 채널별 언어 설정. 기본값. */
export type ChannelLangs = Partial<Record<Channel, string[]>>;
/** 처음에는 초안 하나만 검토한다. 저장된 기존 채널 선택에는 영향을 주지 않는다. */
export const DEFAULT_CHANNEL_LANGS: ChannelLangs = { x: ["ko"] };

/** 설정에서 활성화된 (channel, lang) 쌍. 고정 언어 채널은 설정과 무관하게 그 언어. */
export function enabledTargets(langs: ChannelLangs, customChannels: readonly CustomChannel[] = []): { channel: Channel; lang: string }[] {
  const out: { channel: Channel; lang: string }[] = [];
  for (const spec of channelCatalog(customChannels)) {
    const ch = spec.id;
    const list = langs[ch];
    if (!list || list.length === 0) continue;
    for (const lang of spec.fixedLang ? [spec.fixedLang] : list) out.push({ channel: ch, lang });
  }
  return out;
}

/** 언어 코드 → 이름과 문체 힌트. 목록에 없는 코드도 쓸 수 있다 (이름은 코드 그대로). */
export const LANGS: Record<string, { name: string; nativeName: string; style: string }> = {
  en: { name: "English", nativeName: "English", style: "Plain, direct, no exclamation marks." },
  ko: { name: "Korean", nativeName: "한국어", style: "말투는 선택한 채널의 어조를 따릅니다. 감탄사 없음. 번역투 금지, 짧은 문장." },
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
