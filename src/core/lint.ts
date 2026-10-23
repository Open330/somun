import { postLength } from "./post-length.js";
import { normalizeForMatch } from "./text-match.js";
import { channelSpec, draftChannelSpec, type Channel, type ChannelSpec } from "./channels.js";
import { say as sayIn, type Locale } from "../shared/locale.js";
import { groundingText, sourceConditionPrNumbers, type CandidateLike, type ProfileLike } from "./prompts.js";

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
  "소개해요",
  "공유드립니다",
  "드디어",
];

const EMOJI_BULLET = /^\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?)\s+\S/mu;
const LINK = /https?:\/\/\S+/;
const EXCLAMATION = /[!！]/;

export { normalizeForMatch } from "./text-match.js";

/** 숫자 없이 하는 최상급·최초·유일 주장. 원자료에 같은 말이 없으면 근거 없는 주장이다. */
const SUPERLATIVE_CLAIMS = /\b(?:the (?:fastest|first|only|best|smallest|lightest|simplest)|fastest|world'?s first|first-ever|best-in-class|industry-leading|unmatched|unrivall?ed|blazing(?:ly)?[ -]fast|zero bugs|used by thousands)\b|최초의?|유일한|가장 (?:빠른|가벼운|작은|쉬운|강력한)|업계 최고|세계 최초/gi;

/** 생성 모델이 대화체에 섞는 평가·추천. 모든 의미 오류를 판별하는 규칙은 아니다. */
const ENDORSEMENT = /(?:정말|매우|아주|엄청(?:나게)?|너무)\s*(?:편(?:하|해|할)|편리|유용|좋|훌륭)[가-힣 ]{0,24}|(?:편(?:하|해|할)|편리|유용|좋|훌륭)[가-힣 ]{0,12}(?:것\s*같(?:아|습)|듯(?:해|합)|거(?:예요|에요)|겁니다)|(?:꼭|강력히|적극)\s*추천(?:해|합)|\b(?:i|we)\s+(?:really\s+)?(?:love|recommend)\b|\b(?:(?:really|extremely|incredibly)\s+(?:useful|convenient|helpful|easy)|(?:would|will|must)\s+(?:be\s+)?(?:really\s+)?(?:useful|convenient|helpful|great|easy))\b/giu;
// 검토 신호일 뿐 효과의 참/거짓이나 번역의 정당성을 인증하지 않는다.
const EFFECT_LANGUAGE = /안전하게|효율적으로|편리하게|간편하게|끊김\s*없이|쉽고\s*빠르게|언제\s*어디서나|\b(?:safely|efficiently|without interruptions?|quickly and easily|anytime,? anywhere|anywhere,? anytime)\b/giu;

function unsupportedEndorsements(text: string, source: string): string[] {
  const evidence = normalizeForMatch(source);
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)].map((s) => s.segment.trim());
  return [...new Set(sentences.filter((sentence) => {
    // 독자에게 묻는 실제 질문은 작성자의 추천이나 감상 진술과 구분한다.
    if (/[?？]["'”’]*$/.test(sentence)) return false;
    const value = normalizeForMatch(sentence);
    const matches = [...value.matchAll(ENDORSEMENT), ...value.matchAll(EFFECT_LANGUAGE)].filter((m) => !/않|아니/.test(m[0]) && !/\b(?:not|never)\s*$/.test(value.slice(0, m.index)));
    // '유용' 같은 낱말만 근거에 있다는 이유로 평가를 통과시키지 않는다. 같은 진술이 있어야 한다.
    return matches.length > 0 && !evidence.includes(value.replace(/[.!。！]+$/, ""));
  }))];
}

/** 근거 없이 덧붙이기 쉬운 한계 표현. 원자료에 같은 말이 있으면 근거가 있는 것이다. */
const INVENTED_LIMITS = /API가 바뀔|API may (?:still )?change|아직 (?:0\.x|베타|실험)|still (?:0\.x|beta|experimental)|not yet tested|(?:is|are) (?:still )?experimental|in (?:early )?beta|may break|(?:API|it) is unstable|실험 단계/gi;

export type LintFacts = { purpose?: "introduction" | "update" | null; language?: string; editorInstruction?: string; repo?: string; limitations?: string[]; sourceText?: string; avoid?: string[]; preferLink?: string; why?: string; sourceConditionPrs?: number[] };

/** 원문의 조건 유무만 알린다. 문안이 조건을 보존했는지 자동 인증하지 않는다. */
export function sourceConditionReview(prNumbers: number[], locale: Locale = "ko"): LintResult | undefined {
  if (!prNumbers.length) return undefined;
  const sources = prNumbers.map((n) => `#${n}`).join(", ");
  return { rule: "source_conditions_need_review", ok: false,
    detail: sayIn(locale, `PR ${sources} 원문에 적용 조건이 있거나 본문이 잘렸습니다. ‘문장과 원자료 대조’에서 이 글의 주장에 해당하는 전제·제외 조건을 확인하세요. 조건 누락을 자동 판정한 결과는 아닙니다.`, `PR ${sources} contains possible conditions or truncated text. In the source comparison, check which prerequisites and exclusions apply to this post. This is not an automated finding of missing conditions.`) };
}

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
  return { purpose, repo: candidate.evidence.repo, limitations: [...(candidate.evidence.limitations ?? []), ...(profile?.limitations ?? [])], sourceText: groundingText(candidate, profile), avoid: profile?.avoid ?? [], preferLink, why: profile?.why || undefined, sourceConditionPrs: sourceConditionPrNumbers(candidate.evidence) };
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

/** 명시적인 한국어 해요체 채널만 검사한다. 문체 지시·모호한 커스텀 톤은 자동 해석하지 않는다. */
function registerCheck(body: string, spec: ChannelSpec, facts: LintFacts, locale: Locale): LintResult | undefined {
  if (facts.language?.toLowerCase().split("-")[0] !== "ko") return undefined;
  const tone = spec.identity?.tone ?? "";
  if (!/해요체(?=$|[.,;·\s])/.test(tone) || /합니다체|하십시오체|반말|해요체\s*(?:금지|아님|아닌|말고|대신|사용하지)/.test(tone)) return undefined;
  // 명시 지시의 문체 명칭은 채널보다 우선한다. 부정·인용까지 자연어로 추론하지 않고 보수적으로 건너뛴다.
  if (/해요체|합니다체|하십시오체|합쇼체|하오체|하게체|해라체|반말|존댓말|\b(?:haeyo|formal|informal|register)\b/i.test(facts.editorInstruction ?? "")) return undefined;
  const prose = body.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`]*`/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/g, "");
  // 받침 ㅂ + 니다/니까인 확실한 격식 종결만 찾는다. URL·코드·인용문 내부는 제외했다.
  const formal = [...prose.matchAll(/[가-힣]니(?:다|까)(?=\s*(?:[.!?。？！]|$))/g)]
    .filter((m) => (m[0].charCodeAt(0) - 0xac00) % 28 === 17);
  return { rule: "register_mismatch", ok: formal.length === 0, detail: formal.length ? sayIn(locale,
    "선택 채널은 한국어 해요체를 요구합니다. 합니다/됩니다/입니다/습니다 종결을 해요/돼요/예요/있어요로 고치되 사실·수치·조건은 유지하세요.",
    "This channel requires Korean 해요체. Replace formal 합니다/됩니다/입니다/습니다 endings while preserving facts, numbers and conditions.") : undefined };
}

/** 명시적인 질문 금지를 우선하는 간단한 편집 지시 검사. 자연어 전체의 의미 판정은 아니다. */
export function requestsQuestion(instruction = ""): boolean {
  if (/질문.{0,16}(?:없이|말|금지|빼|제외|삭제|않)|(?:no|without|avoid|omit|remove|do not|don't).{0,25}question/i.test(instruction)) return false;
  return /질문|question|[?？]/i.test(instruction);
}

export function lintDraft(channel: Channel, title: string | undefined, body: string, banned: string[] = DEFAULT_BANNED_PHRASES, facts: LintFacts = {}, locale: Locale = "ko", channelPreset?: ChannelSpec): LintResult[] {
  const say = (ko: string, en: string) => sayIn(locale, ko, en);
  const spec = draftChannelSpec(channelPreset ?? channelSpec(channel), facts.purpose);
  const text = `${title ?? ""}\n${body}`;
  const normalized = normalizeForMatch(text);
  const results: LintResult[] = [];
  // 관찰 가능한 편집 패턴만 검사한다. 연결 동사나 문장의 의미적 유사도를 판정하지 않는다.
  if (facts.purpose === "introduction" && (channel === "x" || channel === "threads") && !facts.editorInstruction?.trim()) {
    const prose = body.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/^\s*>.*$/gm, "").replace(/https?:\/\/\S+/g, "");
    const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(prose)].map((s) => s.segment.trim()).filter(Boolean);
    const normalizedSentences = sentences.map((s) => normalizeForMatch(s).replace(/[.!?。？！]+$/, "").trim()).filter(Boolean);
    const repeated = normalizedSentences.length !== new Set(normalizedSentences).size;
    results.push({ rule: "introduction_repeated_sentence", ok: !repeated, detail: repeated ? say("소개에 같은 문장이 반복됩니다. 중복 문장을 삭제하고 원문의 조건은 유지하세요.", "The introduction repeats an identical sentence. Remove the duplicate while preserving source conditions.") : undefined });
  }
  const register = registerCheck(body, spec, facts, locale);
  if (register) results.push(register);
  const conditionReview = sourceConditionReview(facts.sourceConditionPrs ?? [], locale);
  if (conditionReview) results.push(conditionReview);

  const hits = banned.filter((p) => normalizeForMatch(p).trim() && normalized.includes(normalizeForMatch(p).trim()));
  results.push({ rule: "banned_phrases", ok: hits.length === 0, detail: hits.length ? hits.join(", ") : undefined });

  results.push({ rule: "no_emoji_bullets", ok: !EMOJI_BULLET.test(body) });

  // 프로필의 "글에 쓰지 않을 말". 프롬프트에만 두면 약한 모델이 그대로 쓴다.
  if (facts.avoid?.length) {
    // Repository owners and paths in a required link are not editorial wording.
    const wording = text.replace(/https?:\/\/[^\s<>()\[\]{}]+/gi, "").toLowerCase();
    const used = facts.avoid.filter((w) => w.trim() && wording.includes(w.trim().toLowerCase()));
    results.push({ rule: "avoid_terms", ok: used.length === 0, detail: used.length ? say(`프로필에서 쓰지 않기로 한 말: ${used.join(", ")}`, `Words the profile says to avoid: ${used.join(", ")}`) : undefined });
  }
  if (/[가-힣]/.test(body)) {
    const found = TRANSLITERATED.flatMap(([re, en]) => [...text.matchAll(re)].map((m) => `${m[0]} → ${en}`));
    results.push({ rule: "no_transliterated_names", ok: found.length === 0, detail: found.length ? say(`이름은 원래 철자로 씁니다: ${[...new Set(found)].join(", ")}`, `Keep names in their original spelling: ${[...new Set(found)].join(", ")}`) : undefined });
    const mixed = [...text.matchAll(/소셜[\t ]+media\b|마케팅[\t ]+copy\b/gi)].map((m) => m[0]);
    const english = englishSentences(body);
    results.push({ rule: "mixed_language", ok: english.length === 0, detail: english.length ? say(`한국어 글에 영어 문장이 그대로 있습니다: ${english.join(" / ")}`, `An English sentence was left in the Korean post: ${english.join(" / ")}`) : undefined });
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
  if (facts.sourceText !== undefined) {
    const endorsements = unsupportedEndorsements(text, facts.sourceText);
    results.push({ rule: "endorsement_need_review", ok: endorsements.length === 0, detail: endorsements.length ? say(`근거에 없는 평가·추천 표현: ${endorsements.join(" / ")}. 확인된 기능이나 독자에게 묻는 질문으로 바꿔 주세요.`, `Evaluation or recommendation not found in the evidence: ${endorsements.join(" / ")}. Replace it with a supported capability or a question for the reader.`) : undefined, args: endorsements.length ? { phrases: endorsements.join(" / ") } : undefined });
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

  if (channel === "x" || channel === "linkedin" || (channel.startsWith("custom_") && spec.linkPlacement === "body")) {
    results.push({ rule: "has_link", ok: LINK.test(body) });
  }
  if (spec.linkPlacement === "reply" || spec.linkPlacement === "none") results.push({ rule: "no_body_link", ok: !LINK.test(body), detail: say("이 채널의 링크 위치 설정에 따라 본문에서 URL을 빼 주세요.", "Remove URLs from the body to match this channel’s link placement.") });
  if (facts.preferLink && channel !== "blog" && spec.linkPlacement !== "reply" && spec.linkPlacement !== "none" && channel !== "threads") {
    const link = facts.preferLink.replace(/\/+$/, "");
    const canonical = (value: string): string | undefined => {
      try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/+$/, "") || "/";
        url.hash = "";
        return url.href;
      } catch { return undefined; }
    };
    const expected = canonical(facts.preferLink);
    const matches = expected !== undefined && (body.match(/https?:\/\/[^\s<>"`]+/g) ?? []).some(token => {
      // Compare the complete token: an autolinker may stop at a known TLD inside another hostname.
      if (canonical(token) === expected) return true;
      let candidate = token.replace(/[.,;:!?，。；：！？]+$/u, "");
      const opens: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      const balance: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
      for (const ch of candidate) {
        if (Object.hasOwn(balance, ch)) balance[ch]++;
        else if (opens[ch]) balance[opens[ch]]--;
      }
      let end = candidate.length;
      while (end > 0 && opens[candidate[end - 1]] && balance[opens[candidate[end - 1]]] < 0) {
        balance[opens[candidate[end - 1]]]++;
        end--;
      }
      candidate = candidate.slice(0, end);
      return canonical(candidate) === expected;
    });
    results.push({ rule: "preferred_link", ok: matches, detail: say(`소개 글은 홈페이지로 연결해 주세요: ${link}`, `Link an introduction to the homepage: ${link}`) });
  }

  // 적은 근거를 문단 수에 맞춰 반복하지 않는다. 훅+링크의 두 문단도 유효하다.
  if (channel === "linkedin") {
    const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const ok = paragraphs >= 2 && paragraphs <= 7;
    results.push({ rule: "paragraphs", ok, detail: ok ? undefined : say(`문단 ${paragraphs}개. 근거가 적으면 훅과 링크만으로 2문단이면 충분합니다.`, `${paragraphs} paragraph(s). With limited evidence, a hook and a link in two paragraphs are enough.`) });
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

  if (channel === "threads") {
    const closing = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(body)].at(-1)?.segment.trim() ?? "";
    const opinion = /어떻게\s*생각(?:하|해)|\bwhat\s+do\s+you\s+think\b/i.test(closing);
    const trial = /(?:써|사용해)\s*보(?:셨|신)|사용(?:해|한)\s*적|\b(?:have|did)\s+you\s+(?:ever\s+)?(?:tried|used|try|use)\b/i.test(closing);
    const specific = /어떤|어떻게|언제|어디|무엇|얼마나|\b(?:which|how|when|where|what)\b/i.test(closing);
    // 사용 여부·일반 감상만 묻는 끝맺음은 작업 흐름을 묻도록 제안한다. 모든 질문의 의미를 판별하지는 않는다.
    const vague = /[?？]["'”’]*$/.test(closing) && (opinion || (trial && !specific));
    results.push({ rule: "question_specificity", ok: !vague, detail: vague ? say("제품 사용 여부나 일반 감상 대신, 어떤 입력·채널을 쓰거나 어떻게 검토하는지 구체적인 작업 흐름을 물어 주세요.", "Ask about a concrete workflow, such as inputs, channels or review steps, instead of a generic product-trial or opinion question.") : undefined });
  }

  if (facts.purpose === "introduction" && (channel === "x" || channel === "threads") && !requestsQuestion(facts.editorInstruction)) {
    // 반복적인 습관 질문의 알려진 표현만 검사한다. 모든 질문의 의미나 소개 품질을 인증하지 않는다.
    const closing = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(body)].at(-1)?.segment.trim() ?? "";
    const habit = /[?？]["'”’]*$/.test(closing) && /평소|보통|주로|어떤\s*(?:방식|방법)|\b(?:usually|normally|typically)\b|\bhow\s+do\s+you\b/i.test(closing);
    results.push({ rule: "introduction_habit_question", ok: !habit, detail: habit ? say("소개 끝의 일반적인 습관 질문을 삭제하세요. 근거가 있는 사용 흐름을 더하거나 간결하게 끝내세요.", "Remove the generic habit question. Add a supported workflow detail or finish concisely.") : undefined });
  }

  if (spec.maxSentences !== undefined) {
    // URL의 마침표나 버전·소수점은 문장 경계가 아니다. 표준 문장 분절로 본문만 센다.
    const text = body.replace(/https?:\/\/\S+/g, "").trim();
    const count = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)].filter((s) => s.segment.trim()).length;
    results.push({ rule: "sentence_count", ok: count <= spec.maxSentences, detail: say(`본문 ${count}문장 / 최대 ${spec.maxSentences}문장. 마지막 질문도 포함해 줄여 주세요.`, `Body: ${count} sentences / maximum ${spec.maxSentences}. Include the closing question in this limit.`) });
  }

  if (spec.maxChars !== null) {
    const len = postLength(channel, body);
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

/**
 * 한국어 글 안에 번역하지 않고 남은 영어 문장. 이름 나열("Claude Code, Codex, Gemini CLI")이나 명령은 문장이 아니므로,
 * 한글이 없고 영어 낱말이 다섯 개 이상이며 기능어(the, is, may…)가 있는 문장만 본다.
 */
export function englishSentences(body: string): string[] {
  return body.split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/https?:\/\/\S+/g, "").trim())
    .filter((s) => s && !/[가-힣]/.test(s) && !/[`$]/.test(s) && !/^#/.test(s))
    .filter((s) => (s.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length >= 5 && /\b(?:the|is|are|was|may|will|can|to|of|with|for|it|this|that|still|before|now)\b/i.test(s));
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
  // 문장 끝 마침표·쉼표(40 bugs., before 1.0.)는 수에 붙은 것이 아니다. 예전에는 이런 수를 아예 읽지 않아 문장 끝 수치가 검사를 빠져나갔다.
  for (const m of text.matchAll(/(?<![\w.])v?\d+(?:[.,]\d+)*(?:\.x)?%?(?!\w|[.,]\w)/gi)) {
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
