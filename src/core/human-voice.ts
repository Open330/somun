import { normalizeForMatch } from "./text-match.js";
import { say as sayIn, type Locale } from "../shared/locale.js";

/**
 * 사람이 쓴 글처럼 읽히는가. 2026-11-12 Threads 출시 글을 손으로 고친 다섯 가지를 규칙으로 옮겼다:
 * 콜론으로 시작하는 첫 줄, 기능 나열 목록, 자기 홍보 말투, 합니다체·해요체 혼용, 겪지 않은 1인칭 경험.
 * 관찰 가능한 표면 패턴만 본다. 글이 사람답다고 인증하지 않는다.
 */

type Result = { rule: string; ok: boolean; detail?: string; args?: Record<string, string> };
export type HumanVoiceFacts = { language?: string; editorInstruction?: string; sourceText?: string; why?: string };

/** 짧은 게시글 채널. 긴 글(Show HN·GN·블로그 개요)은 절과 목록이 형식의 일부다. */
const POST_CHANNELS = new Set(["x", "threads", "linkedin"]);
const isPost = (channel: string) => POST_CHANNELS.has(channel) || channel.startsWith("custom_");

const URL = /https?:\/\/\S+/g;
const segment = (text: string) => [...new Intl.Segmenter("ko", { granularity: "sentence" }).segment(text)].map((s) => s.segment.trim()).filter(Boolean);
/** 인용·코드는 작성자의 서술이 아니다. */
const narration = (body: string) => body.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`]*`/g, "").replace(/^\s*>.*$/gm, "").replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"|「[^」]*」/g, "").replace(URL, "");

/** 첫 줄이 콜론으로 시작하거나, 세 낱말 이하의 머리말 뒤 콜론으로 시작한다("Tend: …", "소개: …"). 시각(10:30)·URL은 아니다. */
const COLON_OPENING = /^(?:[:：]|[^\s:：!?。]{1,20}(?:\s[^\s:：!?。]{1,20}){0,2}\s*[:：](?:\s|$))/u;

/** 기능을 글머리 목록으로 나열한 줄. 번호 목록은 순서가 있는 절차일 수 있어 보지 않는다. */
const BULLET = /^\s*[-*•·▪◦‣]\s+\S/;

/**
 * 독자에게 행동을 재촉하거나 제품을 치켜세우는 말. 평가 표현(정말 편해요)은 endorsement_need_review가 맡는다.
 * 사실을 전하는 "README에서 설치 방법을 볼 수 있습니다"는 잡지 않는다.
 */
const SELF_PROMOTION = /지금\s?바로|(?:꼭|한번|한\s번|지금)\s?(?:써|사용해|설치해|확인해|경험해)\s?보세요|놓치지\s?마세요|(?:많은\s?)?관심\s?(?:부탁|바랍니다)|기대해\s?주세요|강력\s?추천|게임\s?체인저|역대급|완벽한\s?(?:도구|해결|솔루션)|놀라운\s?(?:기능|도구)|\bcheck\s+it\s+out\b|\bgive\s+it\s+a\s+(?:try|spin|shot)\b|\bdon'?t\s+miss\b|\bmust[- ]have\b|\byou'?ll\s+love\b|\btry\s+it\s+(?:now|today)\b|\bgo\s+check\b/giu;

/** 겪지 않으면 쓸 수 없는 1인칭 경험. "써 보니", "팔다 보니", "써 봤더니", "직접 써", "I've been using". */
const FIRST_PERSON = /[가-힣]\s?보니(?:까)?(?=[\s,.!?]|$)|[가-힣]\s?봤(?:더니|는데|어요|습니다|다)|직접\s?(?:써|쓰|사용|운영|팔)|제\s?경험|경험상|(?:매일|요즘|늘)\s?(?:쓰고|써요|씁니다|사용하고)|\bI(?:'ve|\s+have)?\s+(?:been\s+)?(?:using|tried|used|running)\b|\bin\s+my\s+experience\b|\bafter\s+(?:using|trying)\s+it\b|\bwe(?:'ve|\s+have)\s+been\s+using\b|\bI\s+found\s+(?:that|it)\b/giu;
/** 편집 지시가 작성자의 경험을 직접 요청하면 그 경험은 작성자가 준 것이다. */
const ASKS_EXPERIENCE = /경험|겪은|1인칭|일인칭|\bfirst[- ]person\b|\bexperience\b|\bmy story\b/i;

/** 문장 끝 종결. 받침 ㅂ + 니다/니까(합니다체)와 요(해요체)만 센다. 문장 부호가 없는 줄 끝도 끝으로 본다. */
const END = String.raw`(?=\s*(?:[.!?。？！…]|$))`;
const FORMAL = new RegExp(`[가-힣]니(?:다|까)${END}`, "gmu");
// 서술문만 센다. 필요·중요·주요·수요처럼 '요'로 끝나는 명사는 종결이 아니고, '-세요'는 합니다체 글에서도 흔한 권유·명령이다.
// 질문(-나요?)은 따로 빼고 본다(아래 narrationStatements).
const POLITE = new RegExp(`(?![필중주수개강세]요)[가-힣]요${END}|[가-힣]죠${END}`, "gmu");
const REGISTER_INSTRUCTION = /해요체|합니다체|하십시오체|합쇼체|반말|존댓말|\b(?:haeyo|formal|informal|register)\b/i;

function formalEndings(text: string): string[] {
  return [...text.matchAll(FORMAL)].filter((m) => (m[0].charCodeAt(0) - 0xac00) % 28 === 17).map((m) => m[0]);
}

export function humanVoiceChecks(channel: string, body: string, facts: HumanVoiceFacts, locale: Locale, opts: { registerChecked: boolean }): Result[] {
  const say = (ko: string, en: string) => sayIn(locale, ko, en);
  const results: Result[] = [];
  const korean = /[가-힣]/.test(body);

  if (isPost(channel)) {
    const first = body.replace(URL, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    const colon = COLON_OPENING.test(first);
    results.push({ rule: "colon_opening", ok: !colon, detail: colon ? say("첫 줄이 '이름:'처럼 콜론으로 시작합니다. 제목 붙이듯 쓰지 말고 문장으로 시작해 주세요.", "The first line opens with a label and a colon. Start with a sentence instead of a heading.") : undefined });

    const bullets = body.split("\n").filter((line) => BULLET.test(line)).length;
    results.push({ rule: "feature_list", ok: bullets < 2, detail: bullets >= 2 ? say(`기능을 목록 ${bullets}줄로 나열했습니다. 가장 중요한 하나를 문장으로 풀고 나머지는 빼 주세요.`, `The post lists features in ${bullets} bullet lines. Explain the most important one in a sentence and drop the rest.`) : undefined, args: bullets >= 2 ? { count: String(bullets) } : undefined });
  }

  const promo = [...new Set([...normalizeForMatch(body.replace(URL, "")).matchAll(SELF_PROMOTION)].map((m) => m[0].trim()))];
  results.push({ rule: "self_promotion", ok: promo.length === 0, detail: promo.length ? say(`자기 홍보 말투: ${promo.join(", ")}. 독자를 재촉하지 말고 무엇을 할 수 있는지만 쓰세요.`, `Self-promotional wording: ${promo.join(", ")}. State what the reader can do instead of urging them.`) : undefined, args: promo.length ? { phrases: promo.join(", ") } : undefined });

  if (korean && !opts.registerChecked && !REGISTER_INSTRUCTION.test(facts.editorInstruction ?? "")) {
    // 질문은 문체를 섞어도 자연스럽다("…보시나요?"). 서술문 종결만 비교한다.
    const prose = segment(narration(body)).filter((sentence) => !/[?？]["'”’)]*$/.test(sentence)).join("\n");
    const formal = formalEndings(prose);
    const polite = [...prose.matchAll(POLITE)].map((m) => m[0]);
    const mixed = formal.length > 0 && polite.length > 0;
    const sample = mixed ? `${[...new Set(formal)].slice(0, 2).join(", ")} / ${[...new Set(polite)].slice(0, 2).join(", ")}` : "";
    results.push({ rule: "register_mixed", ok: !mixed, detail: mixed ? say(`합니다체와 해요체가 섞였습니다(${sample}). 한 문체로 맞춰 주세요.`, `Formal and polite Korean endings are mixed (${sample}). Use one register throughout.`) : undefined, args: mixed ? { sample } : undefined });
  }

  if (!ASKS_EXPERIENCE.test(facts.editorInstruction ?? "")) {
    const evidence = normalizeForMatch(`${facts.sourceText ?? ""}\n${facts.why ?? ""}`);
    const claims = segment(narration(body)).filter((sentence) => {
      const value = normalizeForMatch(sentence);
      if (!new RegExp(FIRST_PERSON.source, "iu").test(value)) return false;
      // 작성자가 README·프로필에 직접 적은 문장이면 그 경험은 근거가 있다.
      return !evidence.includes(value.replace(/[.!?。！？]+$/, ""));
    });
    // 문장 끝 마침표가 설명의 마침표와 겹치지 않게 따옴표로 감싼다.
    const quoted = claims.map((c) => `“${c}”`).join(" ");
    results.push({ rule: "first_person_need_review", ok: claims.length === 0, detail: claims.length ? say(`작성자의 경험으로 쓴 문장: ${quoted}. 근거 자료에 없는 경험입니다. 실제로 겪은 일인지 확인하고, 아니면 빼 주세요.`, `Written as the author's own experience: ${quoted}. The sources do not show this experience. Confirm it happened or remove it.`) : undefined, args: claims.length ? { phrases: quoted } : undefined });
  }
  return results;
}
