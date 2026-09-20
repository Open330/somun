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
const res = await call<{ inserted: number }>("/examples/import", { items });
console.log(`seed: ${items.length} candidates, inserted ${res.inserted}`);
