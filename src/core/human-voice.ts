import { normalizeForMatch } from "./text-match.js";
import { say as sayIn, type Locale } from "../shared/locale.js";

/**
 * 사람이 쓴 글처럼 읽히는가. 2026-11-12 Threads 출시 글을 손으로 고친 다섯 가지를 규칙으로 옮겼다:
 * 콜론으로 시작하는 첫 줄, 기능 나열 목록, 자기 홍보 말투, 합니다체·해요체 혼용, 겪지 않은 1인칭 경험.
 * 관찰 가능한 표면 패턴만 본다. 글이 사람답다고 인증하지 않는다.
 */

type Result = { rule: string; ok: boolean; detail?: string; args?: Record<string, string> };
export type HumanVoiceFacts = { language?: string; editorInstruction?: string; sourceText?: string; why?: string; purpose?: "introduction" | "update" | null; publicName?: string; repo?: string };

/** 짧은 게시글 채널. 긴 글(Show HN·GN·블로그 개요)은 절과 목록이 형식의 일부다. */
const POST_CHANNELS = new Set(["x", "threads", "linkedin"]);
const isPost = (channel: string) => POST_CHANNELS.has(channel) || channel.startsWith("custom_");

const URL = /https?:\/\/\S+/g;
const segment = (text: string) => [...new Intl.Segmenter("ko", { granularity: "sentence" }).segment(text)].map((s) => s.segment.trim()).filter(Boolean);
/** 인용·코드는 작성자의 서술이 아니다. */
export const narration = (body: string) => body.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`]*`/g, "").replace(/^\s*>.*$/gm, "").replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"|「[^」]*」|(?<![A-Za-z])'[^'\n]*[가-힣][^'\n]*'/g, "").replace(URL, "");

/** 첫 줄이 콜론으로 시작하거나, 세 낱말 이하의 머리말 뒤 콜론으로 시작한다("Tend: …", "소개: …"). 시각(10:30)·URL은 아니다. */
// 낱말 안의 마침표(0.4.0)는 허용하되, 마침표로 끝난 낱말(이미 끝난 문장) 뒤로는 넘어가지 않는다.
const COLON_OPENING = /^(?:[:：]|[^\s:：!?。]{0,19}[^\s:：!?。.](?:\s[^\s:：!?。]{0,19}[^\s:：!?。.]){0,2}\s*[:：](?:\s|$))/u;

/** 기능을 글머리 목록으로 나열한 줄. 번호 목록은 순서가 있는 절차일 수 있어 보지 않는다. */
const BULLET = /^\s*[-*•·▪◦‣]\s+\S/;

/**
 * 독자에게 행동을 재촉하거나 제품을 치켜세우는 말. 평가 표현(정말 편해요)은 endorsement_need_review가 맡는다.
 * 사실을 전하는 "README에서 설치 방법을 볼 수 있습니다"는 잡지 않는다.
 */
const SELF_PROMOTION = /지금\s?바로|(?:꼭|한번|한\s번|지금)\s?(?:써|사용해|설치해|확인해|경험해)\s?보세요|놓치지\s?마세요|(?:많은\s?)?관심\s?(?:부탁|바랍니다)|기대해\s?주세요|강력\s?추천|게임\s?체인저|역대급|완벽한\s?(?:도구|해결|솔루션)|놀라운\s?(?:기능|도구)|\bcheck\s+it\s+out\b|\bgive\s+it\s+a\s+(?:try|spin|shot)\b|\bdon'?t\s+miss\b|\bmust[- ]have\b|\byou'?ll\s+love\b|\btry\s+it\s+(?:now|today)\b|\bgo\s+check\b/giu;

/** 겪지 않으면 쓸 수 없는 1인칭 경험. "써 보니", "팔다 보니", "써 봤더니", "직접 써", "I've been using". */
// "직접 사용할 수 있습니다"처럼 독자가 할 수 있는 일을 말하는 문장은 경험이 아니다. 겪은 일을 전하는 활용형만 본다.
const FIRST_PERSON = /[가-힣]\s?보니(?:까)?(?=[\s,.!?]|$)|[가-힣]\s?봤(?:더니|는데|어요|습니다|다)|제\s?경험|경험상|\bI(?:'ve|\s+have)?\s+(?:been\s+)?(?:using|tried|used|running)\b|\bin\s+my\s+experience\b|\bafter\s+(?:using|trying)\s+it\b|\bwe(?:'ve|\s+have)\s+been\s+using\b|\bI\s+found\s+(?:that|it)\b/giu;
/** 편집 지시가 작성자의 경험을 직접 요청하면 그 경험은 작성자가 준 것이다. */
const ASKS_EXPERIENCE = /경험|겪은|1인칭|일인칭|\bfirst[- ]person\b|\bexperience\b|\bmy story\b/i;
/** "경험은 넣지 마세요", "Do not invent personal experience"는 요청이 아니라 금지다. */
const FORBIDS_EXPERIENCE = /(?:경험|겪은|1인칭|일인칭).{0,16}(?:없이|말고|말아|마세요|금지|빼|제외|삭제|않|넣지|쓰지|지어내지)|\b(?:no|not|don'?t|do not|without|avoid|never|invent(?:ed)?)\b.{0,30}(?:experience|first[- ]person|my story)/i;
const asksExperience = (instruction = "") => ASKS_EXPERIENCE.test(instruction) && !FORBIDS_EXPERIENCE.test(instruction);

/** 문장 끝 종결. 받침 ㅂ + 니다/니까(합니다체)와 요(해요체)만 센다. 문장 부호가 없는 줄 끝도 끝으로 본다. */
const END = String.raw`(?=\s*(?:[.!?。？！…]|$))`;
const FORMAL = new RegExp(`[가-힣]니(?:다|까)${END}`, "gmu");
// 서술문만 센다. 필요·중요·주요·수요처럼 '요'로 끝나는 명사는 종결이 아니고, '-세요'는 합니다체 글에서도 흔한 권유·명령이다.
// 질문(-나요?)은 따로 빼고 본다(아래 narrationStatements).
// 가요·동요·민요·담요·개요처럼 흔한 '-요' 명사도 뺀다. 놓치는 혼용이 있어도 바른 글을 고치게 하지 않는 쪽을 택했다.
const POLITE = new RegExp(`(?![필중주수개강세가동민담]요)[가-힣]요${END}|[가-힣]죠${END}`, "gmu");
const REGISTER_INSTRUCTION = /해요체|합니다체|하십시오체|합쇼체|반말|존댓말|\b(?:haeyo|formal|informal|register)\b/i;

function formalEndings(text: string): string[] {
  return [...text.matchAll(FORMAL)].filter((m) => (m[0].charCodeAt(0) - 0xac00) % 28 === 17).map((m) => m[0]);
}

/**
 * 첫 소개에서 사람이 지운 문장 유형(2026-11-12 Tend·haejo·aas·barshelf 실측). 모두 생성 결과를 고치게 하는 규칙이다.
 * - 요구 사항: 설치 조건·지원 OS·버전·하드웨어·가격은 링크한 페이지의 몫이다.
 * - 권유: "사용해 보세요", "~하세요", "use X to", "try X".
 */
const REQUIREMENT = /\b(?:requires?|required|prerequisites?|supports? (?:macOS|Linux|Windows))\b|(?:macOS|iOS|Windows|Linux|Node(?:\.js)?|Rust|Python|tmux)\s?\d+(?:\.\d+|\.x)*\+?|Apple Silicon|Unix-like|유닉스 계열|이상(?:의|에서|이 필요|을 지원)|필요합니다|무료로|\bfor free\b|\bfree of charge\b/iu;
const INVITATION_KO = /[가-힣](?:해|어|아|여|워|써|봐)\s?보세요|만나\s?보세요|보시기\s?바랍니다|[가-힣]하세요(?=\s*(?:[.!]|$))|[가-힣](?:어|아|여)\s?주세요(?=\s*(?:[.!]|$))/u;
const INVITATION_EN = /(?:^|[,;:]\s*)(?:try|use|check out|install|get started with|meet)\b|\bgive it a (?:try|spin)\b|\bcheck it out\b/iu;
/** 주어 없이 여는 첫 문장. 질문(“Running several agents?”)은 독자에게 묻는 말이라 허용한다. */
const DANGLING_EN = /^(?:(?:When|While|After|Before|By|If|Once)\s+\w+ing\b|To\s+\w+\b[^,]*,|\w+ing\b[^,?]*,)/u;
/** 서술어 없이 끝난 한국어 문장("…상호작용할 때.", "…를 위해."). 2026-11-12 실측 3회차. */
const FRAGMENT_KO = /(?:때|위해|통해|경우|위한|면서|으며|하며|하고|에서|으로|에게)\s*[.。]?\s*$/u;
const DANGLING_KO = /^[^.?!]{0,80}(?:하려는 분을 위해|하려는 분들을 위해|하려면|하고 싶다면|하고 싶을 때)/u;

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

  // 문장마다 보는 규칙은 인용·코드를 뺀 서술문으로 본다.
  const statements = segment(narration(body));
  const introduction = facts.purpose === "introduction" && isPost(channel);
  if (introduction) {
    const requirement = statements.filter((sentence) => REQUIREMENT.test(sentence));
    results.push({ rule: "introduction_requirements", ok: requirement.length === 0, detail: requirement.length ? say(`첫 소개에 설치 요구 사항·지원 환경·가격 문장이 있습니다: ${requirement.map((x) => `“${x}”`).join(" ")} 이 내용은 링크한 페이지에 맡기고 빼 주세요.`, `The introduction states requirements, supported environments or pricing: ${requirement.map((x) => `“${x}”`).join(" ")} Leave this to the linked page.`) : undefined, args: requirement.length ? { phrases: requirement.join(" / ") } : undefined });
    const invitation = statements.filter((sentence) => !/[?？]["'”’)]*$/.test(sentence) && (INVITATION_KO.test(sentence) || INVITATION_EN.test(sentence)));
    results.push({ rule: "introduction_invitation", ok: invitation.length === 0, detail: invitation.length ? say(`독자에게 써 보라고 권하는 문장입니다: ${invitation.map((x) => `“${x}”`).join(" ")} 제품이 하는 일을 평서문으로 써 주세요.`, `This invites the reader to try or use it: ${invitation.map((x) => `“${x}”`).join(" ")} State what the product does instead.`) : undefined, args: invitation.length ? { phrases: invitation.join(" / ") } : undefined });
  }
  if (isPost(channel)) {
    const name = facts.publicName?.trim() || facts.repo?.split("/").at(-1);
    if (name) {
      const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // "~할 수 있는 tend입니다", "CLI 도구 aas를", "도구인 BarShelf를": 이름으로 끝나거나 분류어가 이름을 꾸미는 번역투.
      const predicate = new RegExp(`(?:[가-힣]\\s|^)${n}(?:입니다|이에요|예요)(?=\\s*(?:[.!]|$))|(?:도구|툴|플랫폼|앱|CLI|서비스)인?\\s+${n}(?![A-Za-z])`, "iu");
      const labelled = statements.filter((sentence) => predicate.test(sentence));
      results.push({ rule: "name_predicate", ok: labelled.length === 0, detail: labelled.length ? say(`이름으로 끝나거나 분류어가 이름을 꾸미는 문장입니다: ${labelled.map((x) => `“${x}”`).join(" ")} "${name}는/은 …합니다"처럼 이름을 주어로 써 주세요.`, `The sentence ends on the name or labels it with a category: ${labelled.map((x) => `“${x}”`).join(" ")} Make ${name} the subject.`) : undefined, args: labelled.length ? { phrases: labelled.join(" / "), name } : undefined });
      // 같은 제품의 명령을 둘 이상 늘어놓으면 하는 일이 아니라 명령 목록이 된다.
      const cli = (facts.repo?.split("/").at(-1) ?? name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 명령으로 보는 것: 백틱 안의 `cli sub`, 또는 소문자 cli 뒤 하위 명령에 한국어 조사가 바로 붙은 것(tend watch로). "Tend watches"는 문장이다.
      const commands = [...new Set([...body.replace(URL, "").matchAll(new RegExp(`\`${cli}\\s+([a-z][a-z-]*)[^\`]*\`|(?<![\\w-])${cli}\\s+([a-z][a-z-]*)(?=[가-힣])`, "gu"))].map((m) => (m[1] ?? m[2]).toLowerCase()))];
      results.push({ rule: "command_list", ok: commands.length < 2, detail: commands.length >= 2 ? say(`명령어를 ${commands.length}개 나열했습니다(${commands.join(", ")}). 하는 일을 설명하고 명령은 하나만 남겨 주세요.`, `The post lists ${commands.length} commands (${commands.join(", ")}). Describe what it does and keep at most one command.`) : undefined, args: commands.length >= 2 ? { commands: commands.join(", ") } : undefined });
    }
    if (korean) {
      const fragments = statements.filter((sentence) => /[가-힣]/.test(sentence) && !/[?？]["'”’)]*$/.test(sentence) && FRAGMENT_KO.test(sentence));
      results.push({ rule: "sentence_fragment", ok: fragments.length === 0, detail: fragments.length ? say(`서술어 없이 끝난 문장입니다: ${fragments.map((x) => `“${x}”`).join(" ")} 완결된 문장으로 써 주세요.`, `A sentence ends without a predicate: ${fragments.map((x) => `“${x}”`).join(" ")} Write a complete sentence.`) : undefined, args: fragments.length ? { phrases: fragments.join(" / ") } : undefined });
    }
    const first = statements[0] ?? "";
    const dangling = !/[?？]["'”’)]*$/.test(first) && (DANGLING_EN.test(first) || DANGLING_KO.test(first));
    results.push({ rule: "dangling_opener", ok: !dangling, detail: dangling ? say(`첫 문장이 주어 없는 조건절로 시작합니다: “${first}” 제품 이름을 주어로 하거나 상황을 평서문으로 써 주세요.`, `The first sentence opens with a clause that has no subject: “${first}” Make the product the subject or state the situation plainly.`) : undefined, args: dangling ? { sentence: first } : undefined });
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

  if (!asksExperience(facts.editorInstruction)) {
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

/** 사람 말투 규칙. 생성 결과의 문장을 고치게 하는 규칙이라, 다시 쓸 원자료(홈페이지 단락)를 고르는 데는 쓰지 않는다. */
export const HUMAN_VOICE_RULES = new Set(["colon_opening", "feature_list", "self_promotion", "register_mixed", "first_person_need_review", "introduction_requirements", "introduction_invitation", "name_predicate", "command_list", "dangling_opener", "sentence_fragment"]);
