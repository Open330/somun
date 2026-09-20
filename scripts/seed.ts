/** seeds/*.json 과 형식 예시를 examples(source=seed)로 넣는다.  npm run seed */
import { readFileSync } from "node:fs";
import { call } from "./_client.js";

type Item = { channel: string; lang: "ko" | "en"; title?: string; body: string; note?: string };
const items: Item[] = [];
for (const f of ["hn_seeds.json", "hn_seeds_devtools.json"]) {
  const rows = JSON.parse(readFileSync(new URL(`../seeds/${f}`, import.meta.url), "utf8")) as { title: string; points: number; hn: string; first_comment: string | null }[];
  for (const r of rows) if (r.first_comment && r.first_comment.length >= 120) items.push({ channel: "show_hn", lang: "en", title: r.title, body: r.first_comment, note: `${r.points}p · ${r.hn}` });
}
items.push(
  { channel: "x", lang: "en", body: "Ghostty devlog video: I'm working on search! Here's 15 minutes of me explaining why it has taken so long, what is hard about it, the architecture we're going for, and the big progress I've made recently. Progress PR if you'd rather read stuff: https://github.com/ghostty-org/ghostty", note: "Mitchell Hashimoto" },
  { channel: "x", lang: "en", body: "PRs on OpenClaw are growing at an *impossible* rate. Worked all day yesterday and got like 600 commits in. It was 2700; now it's over 3100. I need AI that scans every PR and Issue and de-dupes.", note: "Peter Steinberger" },
  { channel: "x", lang: "ko", body: "에이전트가 권한 확인에 걸려 멈춘 걸 30분 뒤에 아는 게 지겨워서 만들었습니다.\n\nmuxa: tmux 위에서 코딩 에이전트가 일하는 중인지, 기다리는 중인지 보여주고, 가장 오래 기다린 창으로 바로 점프합니다.\n\nRust, 릴리스 61회, 아직 Windows는 안 됩니다. https://github.com/Open330/muxa", note: "형식 예시" },
  { channel: "threads", lang: "ko", body: "에이전트 다섯 개 돌리면 패널 오버레이가 맞나, 아니면 '나를 기다리는 것 큐'만 보고 패널은 아예 안 보는 게 맞나. 후자로 기울고 있음.", note: "형식 예시" },
  { channel: "show_gn", lang: "ko", title: "Show GN: muxa - tmux에서 돌아가는 코딩 에이전트 관제 도구", body: "tmux 창마다 코딩 에이전트를 하나씩 띄워 놓고 일하다 보면, 어느 창의 에이전트가 권한 확인을 기다리며 멈춰 있는지 놓치게 됩니다. 그걸 알려주는 데몬과 CLI를 만들었습니다.\n\n무엇을 만들었나\n- Claude Code, Codex CLI, Gemini CLI의 훅/이벤트를 읽어 각 tmux 패널의 에이전트 상태를 추적\n- muxa peek: 모든 패널을 한 화면에 깔고 상태와 마지막 프롬프트 표시, 숫자 키로 점프\n- muxa attend: 가장 오래 입력을 기다린 에이전트로 이동\n\n기존 도구와 다른 점\n- tmux를 포크하거나 에이전트 바이너리를 수정하지 않습니다\n- 모든 데이터는 로컬에 남습니다\n\n기술\n- Rust, Apache-2.0, 릴리스 61회\n\n한계\n- 베타. 1.0 전에 API가 바뀔 수 있습니다\n- tmux 3.x 필요. Windows 미지원\n\n듣고 싶은 피드백\n- 에이전트를 3개 이상 동시에 돌리는 분들이 peek 화면에서 더 보고 싶은 정보\n\nhttps://github.com/Open330/muxa", note: "형식 예시" },
  { channel: "linkedin", lang: "ko", body: "에이전트가 멈춘 걸 30분 뒤에 알았습니다.\n\n코딩 에이전트를 tmux 창마다 하나씩 띄워 놓고 일한 지 반년쯤 됐습니다. 문제는 늘 같았습니다. 에이전트가 권한 확인을 기다리며 멈춰 있는데, 저는 다른 창을 보고 있어서 한참 뒤에야 압니다.\n\n그래서 muxa를 만들었습니다. tmux 위에서 에이전트 상태를 읽고, 가장 오래 기다린 창으로 바로 점프합니다. 4월에 시작해 릴리스 61회를 냈습니다.\n\n아직 안 되는 것도 있습니다. Windows는 없고, 훅이 없는 에이전트는 화면을 읽어 추정하므로 가끔 틀립니다.\n\n에이전트를 여러 개 돌리는 분이 써보고 무엇이 불편한지 알려주시면 고맙겠습니다.\nhttps://github.com/Open330/muxa\n\n#개발도구 #tmux #오픈소스", note: "형식 예시" },
);
items.push(
  // ── 한국어 형식 예시 (실제 게시물이 아니라 형식 예시. 숫자 1, 한계 1, 감탄 없음) ──
  { channel: "x", lang: "ko", body: "Claude Code 세션 300개를 훑어서 알게 된 것. 프롬프트가 길수록 다시 묻는 횟수가 늘었습니다. 짧게 쓰고 파일 경로를 붙이는 쪽이 재질문이 적었습니다.\n\n세션 로그를 로컬에서 요약하는 스크립트를 공개했습니다. Codex는 아직 안 됩니다. https://github.com/Open330/oh-my-prompt", note: "형식 예시 · 배움형" },
  { channel: "x", lang: "ko", body: "kiwimu 0.4: 한국어 형태소 사전을 12MB에서 3MB로 줄였습니다. 자주 안 쓰는 복합명사를 빼고 실행 시점에 합치는 방식입니다.\n\n대신 첫 검색이 40ms쯤 느려집니다. 브라우저 확장에 넣을 분께는 이득, 서버에서 쓰는 분께는 손해입니다. https://github.com/Open330/kiwimu", note: "형식 예시 · 트레이드오프형" },
  { channel: "threads", lang: "ko", body: "릴리스 노트를 60번 넘게 쓰다 보니 알게 된 것. '개선했습니다'는 아무도 안 읽고, '이제 X가 된다 / 아직 Y는 안 된다' 두 줄은 읽습니다.", note: "형식 예시 · 짧은 관찰" },
  { channel: "threads", lang: "ko", body: "코딩 에이전트 4개를 동시에 돌리면 문제는 속도가 아니라 '누가 나를 기다리는가'입니다. 알림을 모으는 것보다 기다리는 순서대로 줄 세우는 게 나았습니다. 아직 확신은 없고, 2주 더 써봅니다.", note: "형식 예시 · 미완 결론" },
  { channel: "show_gn", lang: "ko", title: "Show GN: kiwimu - 브라우저에서 돌아가는 한국어 형태소 분석기 (WASM)", body: "서버 없이 브라우저 안에서 한국어를 형태소 단위로 자르는 라이브러리입니다. Kiwi를 WASM으로 옮기고 사전을 줄였습니다.\n\n무엇을 만들었나\n- npm 패키지 하나. import 후 analyze(문장) 호출\n- 사전 3MB, 첫 로드 후 문장당 1ms 안팎\n\n왜 만들었나\n- 클라이언트 검색 하이라이트에 형태소 분석이 필요했는데 서버를 두기 싫었습니다\n\n한계\n- 신조어·고유명사 사전은 아직 얇습니다. 사용자 사전 추가는 다음 버전\n- Safari 16 이하에서 SIMD 미지원\n\n듣고 싶은 피드백\n- 검색 외에 브라우저에서 형태소 분석이 필요한 사례\n\nhttps://github.com/Open330/kiwimu", note: "형식 예시" },
  { channel: "linkedin", lang: "ko", body: "반년 동안 저장소 40개를 만들고 알린 건 두 번이었습니다.\n\n스타가 오른 날짜를 찾아보니 둘 다 트윗 한 개에서 시작했습니다. 만드는 속도보다 알리는 속도가 훨씬 느렸다는 뜻입니다.\n\n그래서 알릴 만한 변화가 생기면 알려주는 도구를 만들고 있습니다. 대신 올려주지는 않습니다. 문장은 제가 고치고, 도구는 근거에 있는 숫자만 씁니다.\n\n아직 GitHub만 봅니다. npm과 블로그는 다음입니다.\nhttps://github.com/Open330/somun\n\n#개발자 #오픈소스", note: "형식 예시 · 회고형" },
  { channel: "blog", lang: "ko", title: "에이전트 세션 로그 300개에서 배운 것", body: "## 왜 봤나\n\nClaude Code를 반년 썼는데 어떤 프롬프트가 잘 먹히는지 감으로만 알고 있었습니다. 로컬에 남은 세션 로그 300개를 읽어 봤습니다.\n\n## 세 가지\n\n1. 파일 경로를 붙인 프롬프트는 재질문이 평균 0.6회, 안 붙인 프롬프트는 1.8회였습니다.\n2. \"모두 고쳐줘\"류의 프롬프트는 되돌린 비율이 가장 높았습니다.\n3. 세션이 40턴을 넘으면 같은 설명을 다시 하는 빈도가 늘었습니다. 새 세션이 더 쌌습니다.\n\n## 한계\n\n제 로그 하나뿐입니다. 프로젝트 성격이 다르면 다를 수 있습니다.\n\n## 다음\n\n요약 스크립트는 공개했습니다. Codex 로그 형식은 아직 못 붙였습니다.", note: "형식 예시 · 배움형" },
);
const res = await call<{ inserted: number }>("/examples/import", { items });
console.log(`seed: ${items.length} candidates, inserted ${res.inserted}`);
