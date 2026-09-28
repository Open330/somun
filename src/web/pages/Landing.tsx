import shotInbox from "../assets/shots/inbox.jpg";
import shotCandidate from "../assets/shots/candidate.jpg";
import { useRef } from "react";
import { useAuth } from "../lib/auth/context";
import { useReveal } from "../lib/useReveal";
import type React from "react";
import { Lockup, Mark } from "../components/Mark";
import { GithubButton } from "../components/GithubButton";
import { t } from "../i18n";
import { tr } from "../i18n/rich";
import { LocaleSwitch } from "../components/LocaleSwitch";
import HeroFilm from "../components/HeroFilm";

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
          <LocaleSwitch compact />
          <a className="btn ghost" href="https://github.com/Open330/somun" target="_blank" rel="noreferrer">GitHub</a>
          {auth.enabled ? <GithubButton onClick={() => auth.signIn("github")} label={t("GitHub로 로그인")} /> : <button className="primary" onClick={onToken}>{t("들어가기")}</button>}
        </div>
      </nav>

      <section className="hero">
        <div className="hero-head">
          <div className="hero-copy">
            <p className="hero-eyebrow"><span aria-hidden /> AN EDITOR FOR WHAT YOU SHIPPED</p>
            <h1>{tr("만든 건 많은데,{br}{explain} {hard}", { br: <br />, explain: <span className="outline-word">{t("설명하기가")}</span>, hard: <em>{t("어렵다면.")}</em> })}</h1>
          </div>
          <div className="hero-aside">
            <span className="hand-note" aria-hidden>{t("직접 넘겨 보세요")} ↙</span>
            <p className="sub">{t("소문은 릴리스·PR·커밋을 읽고, 사용자가 알아듣는 말로 홍보 글 초안을 씁니다. 근거는 실제 작업물에서만 가져오고, 올리는 건 직접 합니다.")}</p>
            <div className="toolbar">
              {auth.enabled ? (
                // 소문은 GitHub 저장소를 읽는 도구라 로그인도 GitHub 하나뿐이다. 다른 제공자로 들어오면 계정이 갈라져 설치 기록이 안 보인다.
                <GithubButton size="lg" onClick={() => auth.signIn("github")} label={t("GitHub로 시작하기")} />
              ) : (
                <button className="primary" onClick={onToken}>{t("토큰으로 들어가기")}</button>
              )}
              <a className="btn ghost" href="#how">{t("어떻게 생각하는가 ↓")}</a>
            </div>
          </div>
        </div>
        <HeroFilm />
      </section>

      <div className="marquee" aria-hidden>
        <div className="marquee-track">{[0, 1].map((k) => <span key={k}>OBSERVE <i>↗</i> DISTILL <i>✳</i> JUDGE <i>↗</i> DRAFT <i>✳</i> OBSERVE <i>↗</i> DISTILL <i>✳</i> JUDGE <i>↗</i> DRAFT <i>✳</i> </span>)}</div>
      </div>

      <section className="section" id="how" data-reveal>
        <h2>{t("어떻게 생각하는가")}</h2>
        <p className="lede">{t("커밋을 트윗으로 바꾸는 도구가 아닙니다. 원자료는 다이제스트만 보고, 판단과 초안은 추려진 사실과 숫자만 봅니다.")}</p>
        <div className="flow">
          <div className="st" style={{ "--i": 0 } as React.CSSProperties}><b>{t("1 관찰")}</b><span>{t("GitHub 릴리스·PR·커밋, npm, 코딩 에이전트 세션 요약")}</span></div>
          <div className="st" style={{ "--i": 1 } as React.CSSProperties}><b>{t("2 다이제스트")}</b><span>{t("바깥 독자가 관심 가질 변화·숫자·되돌린 결정만 남김")}</span></div>
          <div className="st" style={{ "--i": 2 } as React.CSSProperties}><b>{t("3 판단")}</b><span>{t("실행 가능·숫자·배움·새로움·청중, 각 0~2점과 반박 가능한 이유")}</span></div>
          <div className="st" style={{ "--i": 3 } as React.CSSProperties}><b>{t("4 초안")}</b><span>{t("채널마다 그 형식과 언어로. 슬롭 린트를 통과해야 보임")}</span></div>
          <div className="st" style={{ "--i": 4 } as React.CSSProperties}><b>{t("5 검수")}</b><span>{t("복사 · 수정 후 복사 · 버리기(사유) · 올린 URL 등록")}</span></div>
          <div className="st" style={{ "--i": 5 } as React.CSSProperties}><b>{t("6 학습")}</b><span>{t("수정은 문체 예시로, 버림은 판단 보정으로, URL은 지표로")}</span></div>
        </div>
      </section>

      <section className="section" id="shots" data-reveal>
        <h2>{t("실제 화면")}</h2>
        <p className="lede">{t("왼쪽은 오늘 검수할 글감 목록, 오른쪽은 한 글감의 사실·판단 이유·채널별 초안입니다. 초안 옆의 숫자는 근거에 있는 값만 씁니다.")}</p>
        <div className="shots">
          <figure><img src={shotInbox} alt={t("글감 목록: 검수할 초안 2개와 보류 5개, 각 행에 점수와 판단 요약")} loading="lazy" width={1600} height={1025} /><figcaption>{t("글감 · 점수순으로 검수할 것과 보류를 나눕니다")}</figcaption></figure>
          <figure><img src={shotCandidate} alt={t("글감 상세: 무엇이 달라졌나, 사실 칩, 판단 이유, 채널·언어별 초안 탭과 X 미리보기")} loading="lazy" width={1600} height={1025} /><figcaption>{t("글감 상세 · 사실과 판단 이유 옆에서 초안을 복사하거나 고칩니다")}</figcaption></figure>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>{t("세 가지 원칙")}</h2>
        <div className="three">
          <div className="principle"><h3>{t("사실은 시스템이, 목소리는 사람이")}</h3><p>{t("초안은 근거에 있는 숫자만 씁니다. 없으면 지어내는 대신 빈칸으로 남깁니다. 문체는 사용자가 고친 문장에서만 배웁니다.")}</p></div>
          <div className="principle"><h3>{t("글감이 아닐 수 있다")}</h3><p>{t("\"이번 주는 알릴 게 없다\"가 정상 답입니다. 리팩터링과 잡일은 다이제스트에서 버려지고, 4점 미만은 묻기만 합니다.")}</p></div>
          <div className="principle"><h3>{t("대신 올리지 않는다")}</h3><p>{t("예약 발행이 없습니다. 복사 버튼과 각 채널의 작성 화면으로 가는 링크뿐입니다. 올린 뒤 URL을 붙여 넣으면 그때부터 잽니다.")}</p></div>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>{t("채널")}</h2>
        <div className="channels">
          <div><span>X</span><span>{t("세 줄: 문제 · 무엇 · 숫자 하나 + 링크")}</span></div>
          <div><span>Show HN</span><span>{t("제목 + 작성자 첫 댓글, 한계와 질문 포함")}</span></div>
          <div><span>Show GN</span><span>{t("무엇 / 왜 / 다른 점 / 한계 / 피드백")}</span></div>
          <div><span>LinkedIn</span><span>{t("접힘선 위 훅, 3~5문단")}</span></div>
          <div><span>Threads</span><span>{t("한두 문장, 입장이나 질문으로 끝")}</span></div>
          <div><span>{t("블로그")}</span><span>{t("개요만: 제목 후보와 절 구조")}</span></div>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>{t("무엇을 읽는가")}</h2>
        <p className="lede">{t("세 가지 커넥터. 프롬프트 원문은 사용자의 컴퓨터를 떠나지 않습니다.")}</p>
        <div className="three">
          <div className="principle"><h3>GitHub</h3><p>{t("릴리스, 머지된 PR, 마지막 릴리스 이후 커밋, 스타와 다운로드 임계, README의 한계 문구.")}</p></div>
          <div className="principle"><h3>{t("세션 업로더")}</h3><p>{tr("{cmd}가 Claude Code, Codex, oh-my-prompt 세션을 로컬에서 요약해 요약만 올립니다.", { cmd: <code>npm run push</code> })}</p></div>
          <div className="principle"><h3>{t("npm · 블로그")}</h3><p>{t("월 다운로드 추이와 발행한 글. 마일스톤을 넘으면 글감 후보가 됩니다.")}</p></div>
        </div>
      </section>

      <footer className="landing-foot">
        <span className="row" style={{ gap: 8 }}><Mark size={18} /> {t("소문 · Open330 · Apache-2.0")}</span>
        <span><a href="https://github.com/Open330/somun">{t("소스")}</a> · <a href="https://github.com/Open330/somun/blob/main/docs/spec.md">{t("기획")}</a></span>
      </footer>
    </div>
  );
}
