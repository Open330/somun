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
const EXCLAMATION = /!/;

export type LintFacts = { repo?: string; limitations?: string[]; sourceText?: string };

/** 생성과 사용자 수정에 같은 근거를 적용한다. 숫자는 요약이 아니라 원자료와 맞춰 본다. */
export function draftLintFacts(candidate: CandidateLike, profile?: ProfileLike): LintFacts {
  return { repo: candidate.evidence.repo, limitations: [...(candidate.evidence.limitations ?? []), ...(profile?.limitations ?? [])], sourceText: groundingText(candidate, profile) };
}

/**
 * 링크 경로와 목록 번호는 주장 수치로 취급하지 않는다. "40 percent", "40 퍼센트"는 40%와 같다.
 * 단위가 붙은 숫자(800ms, 3GB, 12개)는 단위를 떼어 "800 ms"와 같게 본다. 배수(3x, 3배)는 그대로 둔다.
 */
const prose = (value: string) => value.replace(/https?:\/\/[^\s)]+/g, "").replace(/^\s*\d+[.)]\s+/gm, "").replace(/(\d)\s*(?:percent|퍼센트|%)/gi, "$1%")
  .replace(/(?<![\w.])(v?\d+(?:[.,]\d+)*)(?![x×](?![\w-])|배)([a-wyzA-WYZ가-힣]+)/g, "$1 $2");
/** v1.2 = 1.2 */
const canonical = (value: string) => value.replace(/^v/, "");

/** text의 수치 중 source에서 찾지 못한 것. 순수 함수라 다이제스트 검증과 초안 린트가 같이 쓴다. */
export function unsupportedNumbers(text: string, source: string): string[] {
  const supported = new Set(numberTokens(prose(source)).map(canonical));
  return numberTokens(prose(text)).filter((value) => !supported.has(canonical(value)));
}

export function lintDraft(channel: Channel, title: string | undefined, body: string, banned: string[] = DEFAULT_BANNED_PHRASES, facts: LintFacts = {}, locale: Locale = "ko"): LintResult[] {
  const say = (ko: string, en: string) => sayIn(locale, ko, en);
  const spec = CHANNELS[channel];
  const text = `${title ?? ""}\n${body}`;
  const lower = text.toLowerCase();
  const results: LintResult[] = [];

  const hits = banned.filter((p) => lower.includes(p.toLowerCase()));
  results.push({ rule: "banned_phrases", ok: hits.length === 0, detail: hits.length ? hits.join(", ") : undefined });

  results.push({ rule: "no_emoji_bullets", ok: !EMOJI_BULLET.test(body) });

  if (facts.sourceText !== undefined) {
    const missing = unsupportedNumbers(text, facts.sourceText);
    results.push({ rule: "numbers_need_review", ok: missing.length === 0, detail: missing.length ? say(`제공된 근거에서 찾지 못한 수치: ${missing.join(", ")}. 원문과 단위를 확인해 주세요.`, `Numbers not found in the evidence: ${missing.join(", ")}. Check the source and units.`) : undefined, args: missing.length ? { numbers: missing.join(", ") } : undefined });
  }
  const placeholder = /\[(number needed|숫자 확인)\]/i.test(body);
  results.push({ rule: "no_placeholder", ok: !placeholder, detail: placeholder ? say("채우지 못한 숫자가 있습니다", "There is an unfilled number placeholder") : undefined });

  // 저장소 이름 왜곡: 사실의 repo가 owner/name일 때, 같은 name을 다른 owner로 쓴 토큰 (예: ja/settings) 을 잡는다.
  if (facts.repo && facts.repo.includes("/")) {
    const [owner, name] = facts.repo.split("/");
    const re = new RegExp(`(?<![\\w./-])([\\w.-]+)/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
    const wrong = [...text.matchAll(re)].map((m) => m[1]).filter((o) => o !== owner);
    results.push({ rule: "repo_name", ok: wrong.length === 0, detail: wrong.length ? `${wrong[0]}/${name} ≠ ${facts.repo}` : undefined });
  }
  // 지어낸 한계: 사실에 한계가 없는데 "API가 바뀔 수 있다" 류를 쓴 경우.
  if (facts.limitations !== undefined && facts.limitations.length === 0) {
    const invented = /(API가 바뀔|API may (still )?change|아직 (0\.x|베타)|still (0\.x|beta)|not yet tested)/i.test(body);
    results.push({ rule: "no_invented_limit", ok: !invented, detail: invented ? say("제공된 근거에 없는 한계 표현입니다. 원문을 확인해 주세요.", "This limitation is not in the evidence. Check the source.") : undefined });
  }

  if (channel === "x" || channel === "linkedin") {
    results.push({ rule: "has_link", ok: LINK.test(body) });
  }

  if (channel === "show_hn" || channel === "x") {
    results.push({ rule: "no_exclamation", ok: !EXCLAMATION.test(body) });
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
    const asksVotes = /(upvote|vote|추천 부탁|투표|좋아요 부탁)/i.test(text);
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
export function numberTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])v?\d+(?:[.,]\d+)*(?:\.x)?%?(?![\w.])/gi)) {
    // 배수(3x, 3×, 3배)의 숫자는 아래에서 배수 토큰으로만 센다.
    if (MULTIPLIER_SUFFIX.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    let t = m[0].toLowerCase();
    if (/^\d{1,2}$/.test(t) && Number(t) <= 1) continue; // 0, 1 은 문장 안 조사·순서일 때가 많다
    t = t.replace(/,/g, "");
    out.add(t);
  }
  // 배수는 별도 토큰으로 본다. 원문에 없는 "3배 빨라짐"을 잡기 위해.
  for (const m of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?=[x×](?![\w-])|배(?![포치열경송달너터정우려]))/g)) out.add(`${m[1]}x`);
  for (const [re, token] of MULTIPLIER_WORDS) if (re.test(text)) out.add(token);
  return [...out];
}

/**
 * 숫자 바로 뒤(띄어쓰기 없이)의 배수 표시. 소문자 x·× 뒤에 영숫자나 하이픈이 오면 배수가 아니다(1920x1080, 0x1F, 3 X-ray).
 * "배" 뒤에 포·치·열처럼 다른 낱말이 이어지면 배수가 아니다(배포, 배치, 배열).
 */
const MULTIPLIER_SUFFIX = /^(?:[x×](?![\w-])|배(?![포치열경송달너터정우려]))/;

/** 숫자 없이 쓰는 배수 표현. 원문에 같은 배수가 없으면 지어낸 주장이다. 합성어(twice-weekly, 스물두 배)는 배수로 보지 않는다. */
const MULTIPLIER_WORDS: [RegExp, string][] = [
  [/\b(?:twice|two-?fold)\b(?!-)/i, "2x"],
  [/\b(?:tripled|three-?fold)\b(?!-)/i, "3x"],
  [/(?<![가-힣])두\s?배(?![포치열경송달너터정우려])/, "2x"], [/(?<![가-힣])세\s?배(?![포치열경송달너터정우려])/, "3x"],
  [/(?<![가-힣])네\s?배(?![포치열경송달너터정우려])/, "4x"], [/(?<![가-힣])다섯\s?배(?![포치열경송달너터정우려])/, "5x"],
  [/(?<![가-힣])열\s?배(?![포치열경송달너터정우려])/, "10x"],
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
