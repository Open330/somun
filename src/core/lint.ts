import { CHANNELS, type Channel } from "./channels.js";

/**
 * 슬롭 린트. 초안 저장 전에 돌리고 결과를 함께 저장한다.
 * 실패해도 저장은 되지만 화면에 표시되고, 판단 피드백의 근거가 된다.
 */

export type LintResult = { rule: string; ok: boolean; detail?: string };

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
const NUMBER = /\d/;
const LIMITATION_HINT = /(limit|doesn'?t|does not|not yet|no windows|beta|0\.\d+|may change|아직|안 됨|안 됩니다|한계|미지원|않습니다|못합니다|바뀔 수)/i;
const LINK = /https?:\/\/\S+/;
const EXCLAMATION = /!/;

export type LintFacts = { repo?: string; limitations?: string[] };

export function lintDraft(channel: Channel, title: string | undefined, body: string, banned: string[] = DEFAULT_BANNED_PHRASES, facts: LintFacts = {}): LintResult[] {
  const spec = CHANNELS[channel];
  const text = `${title ?? ""}\n${body}`;
  const lower = text.toLowerCase();
  const results: LintResult[] = [];

  const hits = banned.filter((p) => lower.includes(p.toLowerCase()));
  results.push({ rule: "banned_phrases", ok: hits.length === 0, detail: hits.length ? hits.join(", ") : undefined });

  results.push({ rule: "no_emoji_bullets", ok: !EMOJI_BULLET.test(body) });

  if (channel === "x") {
    const ok = NUMBER.test(body) || LIMITATION_HINT.test(body);
    results.push({ rule: "has_number_or_limit", ok, detail: ok ? undefined : "숫자 하나 또는 한계 하나가 필요합니다" });
  } else if (channel !== "threads" && channel !== "blog") {
    results.push({ rule: "has_number", ok: NUMBER.test(body), detail: NUMBER.test(body) ? undefined : "숫자 하나가 필요합니다" });
    results.push({ rule: "has_limitation", ok: LIMITATION_HINT.test(body), detail: LIMITATION_HINT.test(body) ? undefined : "한계 하나가 필요합니다" });
  }
  results.push({ rule: "no_placeholder", ok: !/\[(number needed|숫자 확인)\]/i.test(body), detail: "채우지 못한 숫자가 있습니다" });

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
    results.push({ rule: "no_invented_limit", ok: !invented, detail: invented ? "사실에 없는 한계를 지어냈습니다" : undefined });
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
