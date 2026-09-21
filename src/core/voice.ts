/**
 * 문체 프리셋. 초안 프롬프트에 "문체 지침"으로 들어간다.
 * 예시 문장(문체 예시)에서 문체를 유추하는 대신, 여기서 고른 지침이 문체를 정한다. 예시는 선택 사항이다.
 */
export type VoicePreset = { id: string; name: string; description: string; ko: string; en: string; sample: { ko: string; en: string } };

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "plain",
    name: "담백한 기록",
    description: "무엇을 왜 했고 아직 안 되는 것은 무엇인지. 감탄 없이 합니다체.",
    ko: "합니다체로 씁니다. 문장마다 주어와 목적어를 분명히 써서 무엇을 어떻게 했는지 한 번에 읽히게 합니다. 사실 → 이유 → 한계 순서로 씁니다. 형용사와 부사는 빼고 동사와 숫자로 말합니다.",
    en: "Plain declarative sentences. Say what changed, why, and one thing that still does not work. Prefer verbs and numbers over adjectives. No hype, no exclamation marks.",
    sample: {
      ko: "repopulse 0.4.0을 올렸습니다. 어느 저장소에 이번 주 스타가 붙었는지 터미널에서 보여주는 CLI입니다.\n\n이번 판은 조직 저장소도 읽습니다. 1주 단위 집계는 캐시해 두어 두 번째 실행부터는 API를 부르지 않습니다.\n\n아직 GitHub만 됩니다. GitLab은 다음 판입니다. https://github.com/example/repopulse",
      en: "repopulse 0.4.0 is out. It is a CLI that shows which of your repos got stars this week, in the terminal.\n\nThis release reads organization repos too, and caches weekly counts so the second run makes no API calls.\n\nGitHub only for now; GitLab is next. https://github.com/example/repopulse",
    },
  },
  {
    id: "notes",
    name: "작업 노트",
    description: "혼잣말에 가까운 개발 일지. 한다체, 1인칭, 배운 것 중심.",
    ko: "한다체('했다', '됐다')로 쓰는 1인칭 작업 노트입니다. 겪은 문제 하나로 시작해 무엇을 바꿨는지, 그래서 무엇을 배웠는지 순서로 씁니다. 독자를 설득하지 않고 기록하듯 씁니다.",
    en: "First-person work notes in past tense. Open with the concrete problem you hit, then what you changed, then what you learned. Record, don't persuade.",
    sample: {
      ko: "저장소 40개를 돌리다 보니 어디에 스타가 붙는지 놓치고 있었다. 그래서 repopulse를 만들었다.\n\n0.4.0에서 조직 저장소를 읽게 하고, 주간 집계를 캐시했다. 두 번째 실행부터는 API 호출이 0이다.\n\n배운 것 하나. GitHub 검색 API는 조직 필터를 붙이면 결과 순서가 바뀐다. 정렬을 클라이언트에서 다시 해야 했다.\n\nGitLab은 아직이다. https://github.com/example/repopulse",
      en: "I run about 40 repos and kept missing which ones were getting stars. So I wrote repopulse.\n\n0.4.0 reads organization repos and caches the weekly counts; the second run makes 0 API calls.\n\nOne thing I learned: the GitHub search API reorders results once you add an org filter, so I had to re-sort on the client.\n\nGitLab is not there yet. https://github.com/example/repopulse",
    },
  },
  {
    id: "question",
    name: "질문으로 닫기",
    description: "짧게 알리고 독자에게 하나를 묻는다. 피드백을 받는 글에 맞다.",
    ko: "두세 문장으로 무엇을 만들었는지 말하고, 마지막 문장은 독자에게 묻는 구체적인 질문 하나로 끝냅니다. 질문은 '어떻게 생각하세요'가 아니라 답할 수 있는 것이어야 합니다(예: 어떤 환경에서 쓰시나요).",
    en: "Two or three sentences on what you built, then end with one specific question a reader can actually answer (not 'what do you think?'). Written to get feedback, not applause.",
    sample: {
      ko: "repopulse 0.4.0: 이번 주 스타가 붙은 저장소를 터미널에서 보여줍니다. 조직 저장소도 읽고, 주간 집계는 캐시합니다.\n\n아직 GitHub만 됩니다.\n\n저장소가 열 개 넘는 분들은 스타 말고 무엇을 먼저 보시나요? https://github.com/example/repopulse",
      en: "repopulse 0.4.0 shows which repos got stars this week, in the terminal. Org repos are in, weekly counts are cached.\n\nGitHub only so far.\n\nIf you maintain more than ten repos, what do you check before stars? https://github.com/example/repopulse",
    },
  },
  {
    id: "announce",
    name: "제품 공지",
    description: "독자가 얻는 것부터. 이제 되는 것과 아직 안 되는 것을 나란히.",
    ko: "독자가 얻는 것을 첫 문장에 씁니다. 그다음 '이제 됩니다'와 '아직 안 됩니다'를 각각 한 문장씩 나란히 씁니다. 마케팅 어휘(혁신, 강력한, 손쉽게)는 쓰지 않고 동작을 그대로 씁니다.",
    en: "Lead with what the reader gets. Then one sentence of 'now works' and one of 'does not yet'. No marketing adjectives (powerful, seamless, effortless); describe the behavior instead.",
    sample: {
      ko: "이제 터미널에서 한 줄로 이번 주 스타가 붙은 저장소를 볼 수 있습니다.\n\n이제 됩니다: 조직 저장소 집계, 주간 캐시로 두 번째 실행부터 API 호출 없음.\n아직 안 됩니다: GitLab.\n\nrepopulse 0.4.0, 릴리스 3회째. https://github.com/example/repopulse",
      en: "You can now see which of your repos got stars this week with one command in the terminal.\n\nNow works: organization repos, cached weekly counts so the second run makes no API calls.\nNot yet: GitLab.\n\nrepopulse 0.4.0, third release. https://github.com/example/repopulse",
    },
  },
  {
    id: "terse",
    name: "한 줄씩",
    description: "문제 한 줄, 해결 한 줄, 링크. 가장 짧다.",
    ko: "세 줄 이하로 씁니다. 첫 줄은 문제, 둘째 줄은 만든 것, 셋째 줄은 숫자 하나와 링크입니다. 줄마다 완결된 문장으로 씁니다.",
    en: "Three lines at most: the problem, what you built, one number plus the link. Each line is a complete sentence.",
    sample: {
      ko: "저장소가 많으면 어디에 스타가 붙는지 놓칩니다.\nrepopulse는 이번 주 스타가 붙은 저장소를 터미널에 보여줍니다.\n0.4.0, 아직 GitHub만 됩니다. https://github.com/example/repopulse",
      en: "With many repos you miss which ones are getting stars.\nrepopulse lists this week's starred repos in the terminal.\n0.4.0, GitHub only for now. https://github.com/example/repopulse",
    },
  },
];

/** 샘플이 공통으로 쓰는 가상 작업물. 실제 저장소가 아니다. */
export const SAMPLE_WORK = {
  name: "repopulse",
  what: "이번 주 스타가 붙은 저장소를 터미널에서 보여주는 CLI (가상의 프로젝트)",
  facts: ["0.4.0 · 릴리스 3회", "조직 저장소 집계 추가", "주간 집계 캐시: 두 번째 실행부터 API 호출 0", "한계: GitHub만 지원, GitLab 미지원"],
};

export const DEFAULT_VOICE_PRESET = "plain";

export function voicePreset(id: string | undefined): VoicePreset {
  return VOICE_PRESETS.find((p) => p.id === id) ?? VOICE_PRESETS[0];
}

/** 프리셋 지침 + 사용자 자유 지침을 언어에 맞춰 합친다. */
export function voiceGuideFor(voice: { preset?: string; guide?: string } | undefined, lang: string): string {
  const p = voicePreset(voice?.preset);
  const base = lang === "ko" ? p.ko : p.en;
  const extra = voice?.guide?.trim();
  return extra ? `${base}\n\nAuthor's own guide (takes precedence where they conflict):\n${extra}` : base;
}

/**
 * 한국어 초안에서 흔한 실패(압축, 비유 동사, 성분 생략)를 막는 규칙. ~/.agents/KOREAN.md(fluent-korean 진단)에서 가져왔다.
 * "설정이 꼬여서 기기마다 다시 잡았습니다"처럼 무엇이 어떻게 됐는지 없는 문장을 막는 것이 목적이다.
 */
export const KO_FLUENCY_RULES = `Korean fluency rules (violations make the text read as machine-written):
- Every sentence ends with a full predicate. Keep subjects and objects explicit: say what was wrong with what, and what you did to it. Not "설정이 꼬여서 다시 잡았습니다" but "기기마다 설정 파일 경로가 달라 동기화가 실패해서, 경로를 한 곳으로 모았습니다".
- Use plain verbs, not figurative ones: 꼬이다/잡다/박다/때려넣다/터지다 → 맞지 않다/설정하다/명시하다/추가하다/실패하다.
- Do not stack nouns without particles. Do not chain '~의'. Do not use em dashes.
- One register throughout. Never mix 합니다체 and 한다체 in one post.
- Product names, APIs, paths and env vars stay in their original spelling. Repo names are copied exactly (jiunbae/settings, never ja/settings).
- Translate technical terms by their established Korean term or keep the English word; never replace them with a looser everyday word.`;
