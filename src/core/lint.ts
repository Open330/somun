import { CHANNELS, type Channel } from "./channels.js";
import { say as sayIn, type Locale } from "../shared/locale.js";
import { groundingText, type CandidateLike, type ProfileLike } from "./prompts.js";

/**
 * 슬롭 린트. 초안 저장 전에 돌리고 결과를 함께 저장한다.
 * 실패해도 저장은 되지만 화면에 표시되고, 판단 피드백의 근거가 된다.
 */

/** detail은 만들 때 계정 언어로 쓴 설명. args가 있으면 화면이 자기 언어로 다시 쓴다(수치 목록 등). */
export type LintResult = { rule: string; ok: boolean; detail?: string; args?: Record<string, string> };

export const DEFAULT_BANNED_PHRASES = [
  "excited to announce",
  "thrilled to",
  "introducing",
  "revolutionize",
  "game-changer",
  "game changer",
  "supercharge",
  "unleash",
  "seamless",
  "cutting-edge",
  "next-level",
  "🚀",
  "✨",
  "혁신적",
  "강력한",
  "손쉽게",
  "소개합니다",
  "공유드립니다",
  "드디어",
];

const EMOJI_BULLET = /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?)\s+\S/mu;
const LINK = /https?:\/\/\S+/;
const EXCLAMATION = /[!！]/;

/** 금지어 비교용. 전각·호환 문자, 보이지 않는 문자, 여러 칸 띄우기와 줄바꿈, 하이픈 변형으로 피해 가지 못하게 한다. */
export const normalizeForMatch = (value: string) =>
  value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").toLowerCase();

/** 숫자 없이 하는 최상급·최초·유일 주장. 원자료에 같은 말이 없으면 근거 없는 주장이다. */
const SUPERLATIVE_CLAIMS = /\b(?:the (?:fastest|first|only|best|smallest|lightest|simplest)|fastest|world'?s first|first-ever|best-in-class|industry-leading|unmatched|unrivall?ed|blazing(?:ly)?[ -]fast|zero bugs|used by thousands)\b|최초의?|유일한|가장 (?:빠른|가벼운|작은|쉬운|강력한)|업계 최고|세계 최초/gi;

/** 근거 없이 덧붙이기 쉬운 한계 표현. 원자료에 같은 말이 있으면 근거가 있는 것이다. */
const INVENTED_LIMITS = /API가 바뀔|API may (?:still )?change|아직 (?:0\.x|베타|실험)|still (?:0\.x|beta|experimental)|not yet tested|(?:is|are) (?:still )?experimental|in (?:early )?beta|may break|(?:API|it) is unstable|실험 단계/gi;

export type LintFacts = { repo?: string; limitations?: string[]; sourceText?: string; avoid?: string[]; preferLink?: string; why?: string };

/** 한글로 음역한 제품·채널·도구 이름. 이름은 원래 철자로 쓴다(채널 규칙, KO_FLUENCY_RULES). 조사가 붙어도 잡고, 더 긴 낱말(엑스포)은 건너뛴다. */
const TRANSLITERATED: [RegExp, string][] = ([
  ["엑스", "X"], ["링크드인", "LinkedIn"], ["쇼 ?(?:에이치엔|에이치 엔|핸|에이낸)", "Show HN"], ["쇼 ?지엔", "Show GN"], ["긱 ?뉴스", "GeekNews"],
  ["깃 ?허브", "GitHub"], ["제미나이", "Gemini"], ["에이피아이", "API"], ["씨엘아이", "CLI"], ["엔피엠", "npm"], ["알에스에스", "RSS"],
  ["클로드 ?코드", "Claude Code"], ["코덱스", "Codex"], ["타입스크립트", "TypeScript"],
] as const).map(([ko, en]) => [new RegExp(`(?<![가-힣])${ko}(?=(?:에서|으로|에게|까지|처럼|보다|[와과는은이가를을에의도로만])?(?![가-힣]))`, "g"), en]);
/**
 * Show GN 본문에 있어야 할 절(채널 규칙). 무엇을 했는지는 항상, 왜는 프로필에 만든 이유가 있을 때만, 한계는 근거에 한계가 있을 때만 요구한다.
 * 왜·다른 점·기술 결정은 근거가 있을 때만 쓰는 절이라 요구하지 않는다(요구하면 지어내게 된다). 댓글 요청은 규칙이 금한다.
 */
const SHOW_GN_SECTIONS: [string, RegExp][] = [["무엇", /^[\t ]*(?:#{1,6}[\t ]+)?(?:\*\*)?(무엇|변경 내용|what)/im]];

/**
 * 생성과 사용자 수정에 같은 근거를 적용한다. 숫자는 요약이 아니라 원자료와 맞춰 본다.
 * 첫 소개 글은 홈페이지가 있으면 홈페이지로 보낸다(처음 보는 사람에게 저장소보다 서비스가 먼저다).
 */
export function draftLintFacts(candidate: CandidateLike, profile?: ProfileLike, purpose?: "introduction" | "update" | null): LintFacts {
  const preferLink = purpose === "introduction" ? candidate.evidence.homepage : undefined;
  return { repo: candidate.evidence.repo, limitations: [...(candidate.evidence.limitations ?? []), ...(profile?.limitations ?? [])], sourceText: groundingText(candidate, profile), avoid: profile?.avoid ?? [], preferLink, why: profile?.why || undefined };
}

/**
 * 링크 경로와 목록 번호는 주장 수치로 취급하지 않는다. "40 percent", "40 퍼센트"는 40%와 같다.
 * 단위가 붙은 숫자(800ms, 3GB, 12개)는 단위를 떼어 "800 ms"와 같게 본다. 배수(3x, 3배)는 그대로 둔다.
 */
const prose = (value: string) => value.replace(/https?:\/\/[^\s)]+/g, "").replace(/^\s*\d+[.)]\s+/gm, "").replace(/(?:(?:\btitle[\t ]+candidate|(?:제목|타이틀)[\t ]*후보)|\bsection|섹션)[\t ]*\d+[\t ]*[:：][\t ]*/gi, "").replace(/(\d)\s*(?:percent|퍼센트|%)/gi, "$1%")
  .replace(/(?<![\w.])(v?\d+(?:[.,]\d+)*)(?![x×](?![\w-])|배)([a-wyzA-WYZ가-힣]+)/g, "$1 $2");
/** v1.2 = 1.2 */
const canonical = (value: string) => value.replace(/^v/, "");

/**
 * text의 수치 중 source에서 찾지 못한 것. 순수 함수라 다이제스트 검증과 초안 린트가 같이 쓴다.
 * 단위가 붙은 수치(2s)는 같은 단위로만 맞는다(2ms와 다르다). 단위 없이 쓴 수치는 원자료의 같은 수에 단위가 붙어 있어도 맞는 것으로 본다.
 */
export function unsupportedNumbers(text: string, source: string): string[] {
  const tokens = numberTokens(prose(source)).map(canonical);
  const supported = new Set([...tokens, ...tokens.map(withoutUnit)]);
  return numberTokens(prose(text)).filter((value) => !supported.has(canonical(value)));
}

const withoutUnit = (token: string) => token.replace(/(?<=\d)(?:ms|s|min|h|kb|mb|gb|tb)$/, "");

export function lintDraft(channel: Channel, title: string | undefined, body: string, banned: string[] = DEFAULT_BANNED_PHRASES, facts: LintFacts = {}, locale: Locale = "ko"): LintResult[] {
  const say = (ko: string, en: string) => sayIn(locale, ko, en);
  const spec = CHANNELS[channel];
  const text = `${title ?? ""}\n${body}`;
  const lower = text.toLowerCase();
  const normalized = normalizeForMatch(text);
  const results: LintResult[] = [];

  const hits = banned.filter((p) => normalizeForMatch(p).trim() && normalized.includes(normalizeForMatch(p).trim()));
  results.push({ rule: "banned_phrases", ok: hits.length === 0, detail: hits.length ? hits.join(", ") : undefined });

  results.push({ rule: "no_emoji_bullets", ok: !EMOJI_BULLET.test(body) });

  // 프로필의 "글에 쓰지 않을 말". 프롬프트에만 두면 약한 모델이 그대로 쓴다.
  if (facts.avoid?.length) {
    const used = facts.avoid.filter((w) => w.trim() && lower.includes(w.trim().toLowerCase()));
    results.push({ rule: "avoid_terms", ok: used.length === 0, detail: used.length ? say(`프로필에서 쓰지 않기로 한 말: ${used.join(", ")}`, `Words the profile says to avoid: ${used.join(", ")}`) : undefined });
  }
  if (/[가-힣]/.test(body)) {
    const found = TRANSLITERATED.flatMap(([re, en]) => [...text.matchAll(re)].map((m) => `${m[0]} → ${en}`));
    results.push({ rule: "no_transliterated_names", ok: found.length === 0, detail: found.length ? say(`이름은 원래 철자로 씁니다: ${[...new Set(found)].join(", ")}`, `Keep names in their original spelling: ${[...new Set(found)].join(", ")}`) : undefined });
    const mixed = [...text.matchAll(/소셜[\t ]+media\b|마케팅[\t ]+copy\b/gi)].map((m) => m[0]);
    results.push({ rule: "mixed_korean_terms", ok: mixed.length === 0, detail: mixed.length ? say(`한국어 표현으로 고쳐 주세요: ${[...new Set(mixed)].join(", ")} (소셜 미디어·홍보 문구)`, `Use consistent Korean terms: ${[...new Set(mixed)].join(", ")} (소셜 미디어·홍보 문구)`) : undefined });
  }

  if (facts.sourceText !== undefined) {
    const roleClaims = [...text.matchAll(/\b(?:I|we)\s+(?:built|made|developed|released|launched)\b|(?:만들|개발|출시|공개)(?:했습니다|했어요|하였습니다|하였어요|했으며)/gi)].map((m) => m[0]);
    results.push({ rule: "author_role_need_review", ok: roleClaims.length === 0, detail: roleClaims.length ? say(`작성자 역할 확인: ${roleClaims.join(", ")}. 저장소 연결만으로 직접 개발·출시한 역할이 확인되지는 않으니 원문과 작성자의 역할을 확인해 주세요.`, `Review author role: ${roleClaims.join(", ")}. A connected repository does not establish that the poster developed or released the project; review the source and the poster's role.`) : undefined, args: roleClaims.length ? { phrases: roleClaims.join(", ") } : undefined });
  }

  if (facts.sourceText !== undefined) {
    const missing = unsupportedNumbers(text, facts.sourceText);
    results.push({ rule: "numbers_need_review", ok: missing.length === 0, detail: missing.length ? say(`제공된 근거에서 찾지 못한 수치: ${missing.join(", ")}. 원문과 단위를 확인해 주세요.`, `Numbers not found in the evidence: ${missing.join(", ")}. Check the source and units.`) : undefined, args: missing.length ? { numbers: missing.join(", ") } : undefined });
  }
  if (facts.sourceText !== undefined) {
    const source = normalizeForMatch(facts.sourceText);
    const claims = [...new Set([...normalizeForMatch(text).matchAll(SUPERLATIVE_CLAIMS)].map((m) => m[0]))].filter((c) => !source.includes(c));
    results.push({ rule: "claims_need_review", ok: claims.length === 0, detail: claims.length ? say(`근거에서 찾지 못한 최상급·최초 주장: ${claims.join(", ")}. 원문에 있는 사실로 바꾸거나 빼 주세요.`, `Superlative or "first" claims not found in the evidence: ${claims.join(", ")}. Replace them with sourced facts or remove them.`) : undefined, args: claims.length ? { phrases: claims.join(", ") } : undefined });
  }
  const placeholder = /\[(number needed|숫자 확인)\]/i.test(body);
  results.push({ rule: "no_placeholder", ok: !placeholder, detail: placeholder ? say("채우지 못한 숫자가 있습니다", "There is an unfilled number placeholder") : undefined });

  // 저장소 이름 왜곡: 사실의 repo가 owner/name일 때, 같은 name을 다른 owner로 쓴 토큰 (예: ja/settings) 을 잡는다.
  if (facts.repo && facts.repo.includes("/")) {
    const [owner, name] = facts.repo.split("/");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 문장 끝 마침표(evil/somun.)와 GitHub 주소 안(github.com/evil/somun)도 잡는다. 이름이 비슷한 다른 저장소(somun-cli)는 건너뛴다.
    const re = new RegExp(`(?:(?<![\\w./-])|(?<=github\\.com/))([\\w.-]+)/${escaped}(?![\\w-]|\\.\\w)`, "gi");
    const wrong = [...text.matchAll(re)].map((m) => m[1]).filter((o) => o.toLowerCase() !== owner.toLowerCase());
    results.push({ rule: "repo_name", ok: wrong.length === 0, detail: wrong.length ? `${wrong[0]}/${name} ≠ ${facts.repo}` : undefined });
  }
  // 지어낸 한계: 사실에 한계가 없는데 "API가 바뀔 수 있다" 류를 쓴 경우.
  if (facts.limitations !== undefined && facts.limitations.length === 0) {
    const source = (facts.sourceText ?? "").toLowerCase();
    const invented = [...body.matchAll(INVENTED_LIMITS)].some((m) => !source.includes(m[0].toLowerCase()));
    results.push({ rule: "no_invented_limit", ok: !invented, detail: invented ? say("제공된 근거에 없는 한계 표현입니다. 원문을 확인해 주세요.", "This limitation is not in the evidence. Check the source.") : undefined });
  }

  if (channel === "x" || channel === "linkedin") {
    results.push({ rule: "has_link", ok: LINK.test(body) });
  }
  if (facts.preferLink && channel !== "blog") {
    const link = facts.preferLink.replace(/\/+$/, "");
    results.push({ rule: "preferred_link", ok: text.includes(link), detail: say(`소개 글은 홈페이지로 연결해 주세요: ${link}`, `Link an introduction to the homepage: ${link}`) });
  }

  // LinkedIn은 접힘선 위 한 줄 뒤에 3~5문단(채널 규칙). 한 덩어리 글은 모바일에서 읽히지 않는다.
  if (channel === "linkedin") {
    const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim()).length;
    results.push({ rule: "paragraphs", ok: paragraphs >= 3 && paragraphs <= 7, detail: say(`문단 ${paragraphs}개. 3~5문단으로 나눠 주세요.`, `${paragraphs} paragraph(s). Split into 3-5 paragraphs.`) });
  }

  if (channel === "show_hn" || channel === "x") {
    results.push({ rule: "no_exclamation", ok: !EXCLAMATION.test(text) });
  }

  // 채널 규칙의 필수 구성. Show GN은 절, Show HN 작성자 댓글은 열린 질문으로 끝난다.
  if (channel === "blog") {
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    const outline = lines.length >= 8 && /[?？]$/.test(lines.at(-1) ?? "");
    results.push({ rule: "outline_structure", ok: outline, detail: outline ? undefined : say("개요로 작성해 주세요: 제목 후보 3줄, 사실을 배치할 절 4~6줄, 마지막에 독자에게 물을 실제 질문 1줄. 문단형 본문을 쓰지 말고 각 항목을 줄바꿈해 주세요.", "Write an outline: three title candidates, four to six section lines assigning supplied facts, and an actual reader question on the last line. Put each item on its own line rather than writing the article.") });
  }

  if (channel === "show_gn") {
    const need: [string, RegExp][] = [...SHOW_GN_SECTIONS, ...(facts.why ? [["왜", /^[\t ]*(?:#{1,6}[\t ]+)?(?:\*\*)?(왜|why)/im] as [string, RegExp]] : []), ...(facts.limitations?.length ? [["한계", /^[\t ]*(?:#{1,6}[\t ]+)?(?:\*\*)?(한계|limitations?)/im] as [string, RegExp]] : [])];
    const missing = need.filter(([, re]) => !re.test(body)).map(([name]) => name);
    results.push({ rule: "sections", ok: missing.length === 0, detail: missing.length ? say(`빠진 절: ${missing.join(", ")}`, `Missing sections: ${missing.join(", ")}`) : undefined });
  }
  if (channel === "show_hn") {
    results.push({ rule: "open_question", ok: /\?/.test(body), detail: say("작성자 댓글을 열린 질문 하나로 끝내 주세요.", "End the author comment with one open question.") });
  }

  if (spec.maxChars !== null) {
    const len = [...body].length;
    results.push({ rule: "length", ok: len <= spec.maxChars, detail: `${len}/${spec.maxChars}` });
  }
  if (spec.hasTitle && spec.titleMaxChars) {
    const len = [...(title ?? "")].length;
    results.push({ rule: "title_length", ok: len > 0 && len <= spec.titleMaxChars, detail: `${len}/${spec.titleMaxChars}` });
  }
  if (channel === "show_hn" || channel === "show_gn") {
    const asksVotes = /\b(?:up-?votes?|vote (?:for|on|it|this|us)|please vote|give (?:it|us|the repo) a star|star (?:it|this|the repo))\b|추천\s?부탁|추천(?:을|해)?\s?(?:눌러|주세요)|투표\s?(?:부탁|해\s?주세요)|좋아요\s?(?:부탁|눌러)/i.test(normalizeForMatch(text));
    results.push({ rule: "no_vote_request", ok: !asksVotes });
  }
  return results;
}

export function lintPassed(results: LintResult[]): boolean {
  return results.every((r) => r.ok);
}

/**
 * 초안에 쓰인 숫자 토큰. 버전(v1.2.0, 0.x), 횟수(61), 퍼센트(40%), 천 단위(4,102)를 하나의 토큰으로 본다.
 * 언어 간 비교용이라 단위 단어는 뺀다.
 */
export function numberTokens(input: string): string[] {
  const text = input.normalize("NFKC");
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])v?\d+(?:[.,]\d+)*(?:\.x)?%?(?![\w.])/gi)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    // 배수(3x, 3×, 3배)의 숫자는 아래에서 배수 토큰으로만 센다.
    if (MULTIPLIER_SUFFIX.test(rest)) continue;
    const raw = m[0].toLowerCase();
    // 천 단위 쉼표(4,102)만 붙여 읽는다. 1,5나 1,2,3은 하나의 큰 수가 아니다.
    const parts = /^v?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(raw) ? [raw.replace(/,/g, "")] : raw.split(",");
    const last = parts.length - 1;
    parts.forEach((part, i) => {
      // 크기 단어(1k, 1 million, 1만)는 값으로 바꾸고, 시간·용량 단위(2s, 800MB)는 붙여 둔다. 단위가 다르면 다른 주장이다.
      const unit = i === last ? unitAfter(rest) : undefined;
      if (unit?.scale && /^\d+(?:\.\d+)?$/.test(part)) { out.add(String(Math.round(Number(part) * unit.scale * 1000) / 1000)); return; }
      if (/^\d{1,2}$/.test(part) && Number(part) <= 1) return; // 0, 1 은 문장 안 조사·순서일 때가 많다
      out.add(unit?.suffix && /^\d+(?:\.\d+)?$/.test(part) ? `${part}${unit.suffix}` : part);
    });
  }
  // 배수는 별도 토큰으로 본다. 원문에 없는 "3배 빨라짐"을 잡기 위해.
  for (const m of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?=[xX×](?![\w-])|\s?times\b|\s?배(?![포치열경송달너터정우려]))/g)) out.add(`${m[1]}x`);
  for (const [re, token] of MULTIPLIER_WORDS) if (re.test(text)) out.add(token);
  return [...out];
}

/** 수 바로 뒤의 단위. prose()가 "800ms"를 "800 ms"로 떼어 두므로 공백 하나를 허용한다. 한국어 단위는 조사가 붙어도 읽는다(2초로). */
function unitAfter(rest: string): { suffix?: string; scale?: number } | undefined {
  const en = /^\s?(milliseconds?|ms|secs?|seconds?|s|mins?|minutes?|hrs?|hours?|h|ki?b|mi?b|gi?b|tb|k|thousand|million|billion)(?![a-z])/i.exec(rest);
  const ko = /^\s?(밀리초|초|분|시간|천|만|억)(?=$|[^가-힣]|(?:로|에|만|은|는|이|가|을|를|도|의|씩)(?![가-힣]))/.exec(rest);
  const word = (en?.[1] ?? ko?.[1])?.toLowerCase();
  if (!word) return undefined;
  const scale: Record<string, number> = { k: 1e3, thousand: 1e3, 천: 1e3, 만: 1e4, million: 1e6, 억: 1e8, billion: 1e9 };
  if (scale[word]) return { scale: scale[word] };
  if (/^(?:ms|milliseconds?|밀리초)$/.test(word)) return { suffix: "ms" };
  if (/^(?:s|secs?|seconds?|초)$/.test(word)) return { suffix: "s" };
  if (/^(?:mins?|minutes?|분)$/.test(word)) return { suffix: "min" };
  if (/^(?:h|hrs?|hours?|시간)$/.test(word)) return { suffix: "h" };
  return { suffix: word.replace("i", "") };
}

/**
 * 숫자 바로 뒤(띄어쓰기 없이)의 배수 표시. 소문자 x·× 뒤에 영숫자나 하이픈이 오면 배수가 아니다(1920x1080, 0x1F, 3 X-ray).
 * "배" 뒤에 포·치·열처럼 다른 낱말이 이어지면 배수가 아니다(배포, 배치, 배열).
 */
const MULTIPLIER_SUFFIX = /^(?:[xX×](?![\w-])|\s?times\b|\s?배(?![포치열경송달너터정우려]))/;

/** 숫자 없이 쓰는 배수 표현. 원문에 같은 배수가 없으면 지어낸 주장이다. 합성어(twice-weekly, 스물두 배)는 배수로 보지 않는다. */
const MULTIPLIER_WORDS: [RegExp, string][] = [
  [/\b(?:twice|two-?fold)\b(?!-)/i, "2x"],
  [/\b(?:tripled|three-?fold)\b(?!-)/i, "3x"],
  [/(?<![가-힣])두\s?배(?![포치열경송달너터정우려])/, "2x"], [/(?<![가-힣])세\s?배(?![포치열경송달너터정우려])/, "3x"],
  [/(?<![가-힣])네\s?배(?![포치열경송달너터정우려])/, "4x"], [/(?<![가-힣])다섯\s?배(?![포치열경송달너터정우려])/, "5x"],
  [/(?<![가-힣])열\s?배(?![포치열경송달너터정우려])/, "10x"],
  [/\b(?:doubled|two times)\b(?!-)/i, "2x"], [/\bthree times\b/i, "3x"],
  [/\b(?:quadrupled|four-?fold|four times)\b(?!-)/i, "4x"], [/\bfive times\b/i, "5x"],
  [/\b(?:ten-?fold|ten times|an? order of magnitude)\b(?!-)/i, "10x"], [/\borders of magnitude\b/i, "100x"],
  [/\b(?:halved|cut (?:it )?in half|by half)\b/i, "0.5x"], [/절반|반으로\s?(?:줄|단축|감소)/, "0.5x"],
  [/(?<![가-힣])백\s?배(?![포치열경송달너터정우려])/, "100x"],
  // 막연한 크기. 원문에 같은 말이 없으면 지어낸 규모다.
  [/몇\s?배|수십\s?배|수백\s?배/, "N배"],
  [/\ba (?:million|billion)\b/i, "a million+"], [/(?<![가-힣\d]\s?)천\s?(?:명|개|건)/, "1000"],
  [/#\s?1\b|\bnumber one\b/i, "#1"], [/\b(?:zero|0) (?:dependencies|deps|bugs|config(?:uration)?)\b/i, "0"],
  [/\bhundreds of\b/i, "hundreds"], [/\bthousands of\b/i, "thousands"], [/\bdozens of\b/i, "dozens"], [/\bmillions of\b/i, "millions"],
  [/(?<![가-힣])수백(?=\s?[개명건곳줄번만%]|\s(?!배))/, "수백"], [/(?<![가-힣])수천(?=\s?[개명건곳줄번만%]|\s(?!배))/, "수천"], [/(?<![가-힣])수십(?=\s?[개명건곳줄번만%]|\s(?!배))/, "수십"],
];

/**
 * 같은 채널의 최신 초안들(언어별)에서 숫자 집합이 다르면 알린다. EN에 "61 releases"가 있는데 KO에 없으면 잡힌다.
 * 버림·이전 판은 제외. 언어가 하나면 비교하지 않는다.
 */
export function crossLangNumberDiff(drafts: { channel: string; lang: string; version: number; status: string; title?: string; body: string }[]): { channel: Channel; langs: string[]; onlyIn: { lang: string; numbers: string[] }[] }[] {
  const latest = new Map<string, typeof drafts[number]>();
  for (const d of drafts) {
    if (d.status === "dropped") continue;
    const k = `${d.channel}:${d.lang}`;
    const cur = latest.get(k);
    if (!cur || d.version > cur.version) latest.set(k, d);
  }
  const byChannel = new Map<string, typeof drafts>();
  for (const d of latest.values()) byChannel.set(d.channel, [...(byChannel.get(d.channel) ?? []), d]);
  const out: { channel: Channel; langs: string[]; onlyIn: { lang: string; numbers: string[] }[] }[] = [];
  for (const [channel, ds] of byChannel) {
    if (ds.length < 2) continue;
    const sets = ds.map((d) => ({ lang: d.lang, nums: new Set(numberTokens(`${d.title ?? ""}\n${d.body}`)) }));
    const onlyIn = sets.map((s) => ({ lang: s.lang, numbers: [...s.nums].filter((n) => sets.some((o) => o !== s && !o.nums.has(n))) })).filter((x) => x.numbers.length);
    if (onlyIn.length) out.push({ channel: channel as Channel, langs: ds.map((d) => d.lang), onlyIn });
  }
  return out;
}
