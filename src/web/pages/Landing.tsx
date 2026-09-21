import shotInbox from "../assets/shots/inbox.jpg";
import shotCandidate from "../assets/shots/candidate.jpg";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth/context";
import { useReveal } from "../lib/useReveal";
import type React from "react";
import { Lockup, Mark } from "../components/Mark";
import { GithubButton } from "../components/GithubButton";

/** 로그아웃 상태의 첫 화면. 약속 한 문장, 실제 초안 예시, 어떻게 생각하는가, 로그인. */
export default function Landing({ onToken }: { onToken?: () => void }) {
  const auth = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  useReveal(ref);
  return (
    <div className="landing" ref={ref}>
      <nav>
        <div className="brand"><Lockup size={30} /></div>
        <div className="toolbar">
          <a className="btn ghost" href="https://github.com/Open330/somun" target="_blank" rel="noreferrer">GitHub</a>
          {auth.enabled ? <GithubButton onClick={() => auth.signIn("github")} label="GitHub로 로그인" /> : <button className="primary" onClick={onToken}>들어가기</button>}
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <h1>만들기는 매일 하는데,<br /><em>알리기</em>는 분기에 한 번.</h1>
          <p className="sub">소문은 저장소와 작업 세션을 지켜보다가 정말 알릴 만한 것이 생겼을 때만 채널별 초안을 건넵니다. 검수하고 복사해서 올리는 건 사용자 몫입니다. 대신 올리지 않고, 없는 숫자를 지어내지 않습니다.</p>
          <div className="toolbar">
            {auth.enabled ? (
              // 소문은 GitHub 저장소를 읽는 도구라 로그인도 GitHub 하나뿐이다. 다른 제공자로 들어오면 계정이 갈라져 설치 기록이 안 보인다.
              <GithubButton size="lg" onClick={() => auth.signIn("github")} label="GitHub로 시작하기" />
            ) : (
              <button className="primary" onClick={onToken}>토큰으로 들어가기</button>
            )}
            <a className="btn ghost" href="#how">어떻게 생각하는가 ↓</a>
          </div>
        </div>
        <Demo />
      </section>

      <section className="section" id="how" data-reveal>
        <h2>어떻게 생각하는가</h2>
        <p className="lede">커밋을 트윗으로 바꾸는 도구가 아닙니다. 원자료는 다이제스트만 보고, 판단과 초안은 추려진 사실과 숫자만 봅니다.</p>
        <div className="flow">
          <div className="st" style={{ "--i": 0 } as React.CSSProperties}><b>1 관찰</b><span>GitHub 릴리스·PR·커밋, npm, 코딩 에이전트 세션 요약</span></div>
          <div className="st" style={{ "--i": 1 } as React.CSSProperties}><b>2 다이제스트</b><span>바깥 독자가 관심 가질 변화·숫자·되돌린 결정만 남김</span></div>
          <div className="st" style={{ "--i": 2 } as React.CSSProperties}><b>3 판단</b><span>실행 가능·숫자·배움·새로움·청중, 각 0~2점과 반박 가능한 이유</span></div>
          <div className="st" style={{ "--i": 3 } as React.CSSProperties}><b>4 초안</b><span>채널마다 그 형식과 언어로. 슬롭 린트를 통과해야 보임</span></div>
          <div className="st" style={{ "--i": 4 } as React.CSSProperties}><b>5 검수</b><span>복사 · 수정 후 복사 · 버리기(사유) · 올린 URL 등록</span></div>
          <div className="st" style={{ "--i": 5 } as React.CSSProperties}><b>6 학습</b><span>수정은 문체 예시로, 버림은 판단 보정으로, URL은 지표로</span></div>
        </div>
      </section>

      <section className="section" id="shots" data-reveal>
        <h2>실제 화면</h2>
        <p className="lede">왼쪽은 오늘 검수할 글감 목록, 오른쪽은 한 글감의 사실·판단 이유·채널별 초안입니다. 초안 옆의 숫자는 근거에 있는 값만 씁니다.</p>
        <div className="shots">
          <figure><img src={shotInbox} alt="글감 목록: 검수할 초안 2개와 보류 5개, 각 행에 점수와 판단 요약" loading="lazy" width={1600} height={1025} /><figcaption>글감 · 점수순으로 검수할 것과 보류를 나눕니다</figcaption></figure>
          <figure><img src={shotCandidate} alt="글감 상세: 무엇이 달라졌나, 사실 칩, 판단 이유, 채널·언어별 초안 탭과 X 미리보기" loading="lazy" width={1600} height={1025} /><figcaption>글감 상세 · 사실과 판단 이유 옆에서 초안을 복사하거나 고칩니다</figcaption></figure>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>세 가지 원칙</h2>
        <div className="three">
          <div className="principle"><h3>사실은 시스템이, 목소리는 사람이</h3><p>초안은 근거에 있는 숫자만 씁니다. 없으면 지어내는 대신 빈칸으로 남깁니다. 문체는 사용자가 고친 문장에서만 배웁니다.</p></div>
          <div className="principle"><h3>글감이 아닐 수 있다</h3><p>"이번 주는 알릴 게 없다"가 정상 답입니다. 리팩터링과 잡일은 다이제스트에서 버려지고, 4점 미만은 묻기만 합니다.</p></div>
          <div className="principle"><h3>대신 올리지 않는다</h3><p>예약 발행이 없습니다. 복사 버튼과 각 채널의 작성 화면으로 가는 링크뿐입니다. 올린 뒤 URL을 붙여 넣으면 그때부터 잽니다.</p></div>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>채널</h2>
        <div className="channels">
          <div><span>X</span><span>세 줄: 문제 · 무엇 · 숫자 하나 + 링크</span></div>
          <div><span>Show HN</span><span>제목 + 작성자 첫 댓글, 한계와 질문 포함</span></div>
          <div><span>Show GN</span><span>무엇 / 왜 / 다른 점 / 한계 / 피드백</span></div>
          <div><span>LinkedIn</span><span>접힘선 위 훅, 3~5문단</span></div>
          <div><span>Threads</span><span>한두 문장, 입장이나 질문으로 끝</span></div>
          <div><span>블로그</span><span>개요만: 제목 후보와 절 구조</span></div>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>무엇을 읽는가</h2>
        <p className="lede">세 가지 커넥터. 프롬프트 원문은 사용자의 컴퓨터를 떠나지 않습니다.</p>
        <div className="three">
          <div className="principle"><h3>GitHub</h3><p>릴리스, 머지된 PR, 마지막 릴리스 이후 커밋, 스타와 다운로드 임계, README의 한계 문구.</p></div>
          <div className="principle"><h3>세션 업로더</h3><p><code>somun push</code>가 Claude Code, Codex, oh-my-prompt 세션을 로컬에서 요약해 요약만 올립니다.</p></div>
          <div className="principle"><h3>npm · 블로그</h3><p>월 다운로드 추이와 발행한 글. 마일스톤을 넘으면 글감 후보가 됩니다.</p></div>
        </div>
      </section>

      <footer className="landing-foot">
        <span className="row" style={{ gap: 8 }}><Mark size={18} /> 소문 · Open330 · Apache-2.0</span>
        <span><a href="https://github.com/Open330/somun">소스</a> · <a href="https://github.com/Open330/somun/blob/main/docs/spec.md">기획</a></span>
      </footer>
    </div>
  );
}

/** 히어로의 살아 있는 데모: 같은 글감이 채널·언어마다 어떻게 달라지는지 4초마다 넘긴다. 손대면 멈춘다. */
const DEMO = [
  { tab: "X · EN", chars: "249/280", post: "I ran agents in tmux and lost track of their sessions.\n\nMuxa adds keyboard navigation and natural language automation rules to orchestrate agent sessions.\n\n61 releases, still 0.x: https://github.com/Open330/muxa" },
  { tab: "X · KO", chars: "138/280", post: "에이전트를 tmux 창마다 띄워 놓고 어느 창이 나를 기다리는지 놓치는 게 지겨웠습니다.\n\nmuxa: 상태를 읽고 가장 오래 기다린 창으로 바로 점프합니다.\n\n릴리스 61회, 아직 0.x: https://github.com/Open330/muxa" },
  { tab: "Show HN", chars: "제목 62자", post: "Show HN: Muxa – keep track of coding agents running in tmux\n\nAuthor here. I run several agents side by side and kept missing the one waiting on a permission prompt. Muxa reads each pane's state and jumps to the one that has waited longest.\n\nStill 0.x: the API may change before 1.0. No Windows support." },
  { tab: "LinkedIn · KO", chars: "4문단", post: "에이전트가 멈춘 걸 30분 뒤에 알았습니다.\n\n코딩 에이전트를 tmux 창마다 하나씩 띄워 놓고 일한 지 반년쯤 됐습니다. 문제는 늘 같았습니다.\n\n그래서 muxa를 만들었습니다. 4월에 시작해 릴리스 61회를 냈습니다. 아직 Windows는 없습니다." },
];
function Demo() {
  const [i, setI] = useState(0);
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (hold || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % DEMO.length), 4200);
    return () => clearInterval(t);
  }, [hold]);
  const d = DEMO[i];
  return (
    <div className="demo" aria-label="실제 초안 예시" onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}>
      <div className="bar"><b>Open330/muxa v0.8.47</b> · 릴리스 · 판단 6/10 · <span className="badge ok">초안 4</span></div>
      <div className="body">
        <div className="tabs" style={{ margin: 0 }}>{DEMO.map((x, k) => <button key={x.tab} className={`sm ${k === i ? "active" : ""}`} onClick={() => { setI(k); setHold(true); }}>{x.tab}</button>)}</div>
        <div className="post" key={i}>{d.post}</div>
        <div className="facts"><span>stars=28</span><span>commits=707</span><span>releases=61</span><span>limit: API may change before 1.0</span></div>
        <div className="row between"><span className="badge ok">린트 통과 · {d.chars}</span><div className="toolbar"><button className="sm">수정</button><button className="sm primary">복사</button></div></div>
        {!hold && <div className="demo-progress" key={`p${i}`} aria-hidden />}
      </div>
    </div>
  );
}
