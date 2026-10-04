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

/** 로그아웃 상태의 첫 화면. 약속 한 문장, 실제 초안 예시, 글이 되기 전에 먼저 추립니다, 로그인. */
export default function Landing({ onToken }: { onToken?: () => void }) {
  const auth = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  useReveal(ref);
  return (
    <div className="landing" ref={ref}>
      <nav>
        <div className="brand">
          <Lockup size={30} />
        </div>
        <div className="toolbar">
          <LocaleSwitch compact />
          <a className="btn ghost" href="https://github.com/Open330/somun" target="_blank" rel="noreferrer">
            GitHub
          </a>
          {auth.enabled ? (
            <GithubButton onClick={() => auth.signIn("github")} label={t("GitHub로 로그인")} />
          ) : (
            <button className="primary" onClick={onToken}>
              {t("들어가기")}
            </button>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <h1>{tr("알릴 내용만,{br}{explain}.", { br: <br />, explain: <em>{t("읽기 쉽게")}</em> })}</h1>
          <p className="sub">
            {t(
              "소문은 릴리스·PR·커밋에서 알릴 변화를 추려 채널별 초안을 만듭니다. 막연한 찬사보다 무엇이 달라졌는지 먼저 씁니다. 마지막 말투와 사실 확인은 당신이 맡습니다.",
            )}
          </p>
          <div className="toolbar">
            {auth.enabled ? (
              // 소문은 GitHub 저장소를 읽는 도구라 로그인도 GitHub 하나뿐이다. 다른 제공자로 들어오면 계정이 갈라져 설치 기록이 안 보인다.
              <GithubButton size="lg" onClick={() => auth.signIn("github")} label={t("GitHub로 시작하기")} />
            ) : (
              <button className="primary" onClick={onToken}>
                {t("토큰으로 들어가기")}
              </button>
            )}
            <a className="btn ghost" href="#how">
              {t("어떻게 줄이는가 ↓")}
            </a>
          </div>
        </div>
        <HeroFilm />
      </section>

      <section className="section" id="why" data-reveal>
        <h2>{t("읽는 사람이 내용을 찾느라 애쓰지 않도록")}</h2>
        <p className="lede">
          {t(
            "AI slop은 그럴듯한 말은 많은데 정작 할 말이 흐린 글입니다. 소문은 초안을 쓰기 전의 선택과 쓴 뒤의 검토를 기본 흐름으로 둡니다.",
          )}
        </p>
        <div className="three">
          <div className="principle">
            <h3>{t("알릴 가치부터 따집니다")}</h3>
            <p>
              {t(
                "모든 커밋을 게시글로 늘리지 않습니다. 알릴 만한 변화인지 먼저 판단하고, 가치가 낮은 글감은 보류하도록 기준을 정할 수 있습니다.",
              )}
            </p>
          </div>
          <div className="principle">
            <h3>{t("찬사보다 바뀐 점을 씁니다")}</h3>
            <p>
              {t(
                "‘혁신적’ 같은 과장 표현과 근거에서 찾지 못한 숫자를 점검합니다. 문장을 채우기 위한 수치나 배경 이야기를 만들지 않도록 지시합니다.",
              )}
            </p>
          </div>
          <div className="principle">
            <h3>{t("쓴 사람의 말투를 남깁니다")}</h3>
            <p>
              {t(
                "사용자가 고쳐 복사한 글을 다음 초안의 문체 예시로 씁니다. 지침 제안도 검토해 적용합니다. 다듬지 않은 AI 말투를 계속 반복할 필요가 없습니다.",
              )}
            </p>
          </div>
        </div>
        <p className="landing-review-note">
          {t(
            "소문도 AI로 초안을 씁니다. 자동 점검이 재미나 모든 사실을 보증하지는 않습니다. 원자료와 나란히 읽고 고쳐서, 최종 글은 당신이 정합니다.",
          )}
        </p>
      </section>

      <section className="section" id="how" data-reveal>
        <h2>{t("글이 되기 전에 먼저 추립니다")}</h2>
        <p className="lede">
          {t("작업 기록을 요약하고, 알릴 가치와 독자를 판단한 뒤 초안을 씁니다. 바뀐 점과 근거를 초안 옆에서 확인할 수 있습니다.")}
        </p>
        <div className="flow">
          <div className="st" style={{ "--i": 0 } as React.CSSProperties}>
            <b>{t("1 기록 읽기")}</b>
            <span>{t("GitHub와 블로그 등 연결한 소스에서 작업 기록을 모읍니다.")}</span>
          </div>
          <div className="st" style={{ "--i": 1 } as React.CSSProperties}>
            <b>{t("2 변화 추리기")}</b>
            <span>{t("독자가 볼 변화와 근거를 요약합니다.")}</span>
          </div>
          <div className="st" style={{ "--i": 2 } as React.CSSProperties}>
            <b>{t("3 알릴지 판단하기")}</b>
            <span>{t("게시 가치의 점수와 이유를 보여줍니다. 기준은 조정할 수 있습니다.")}</span>
          </div>
          <div className="st" style={{ "--i": 3 } as React.CSSProperties}>
            <b>{t("4 초안과 점검")}</b>
            <span>{t("채널 형식에 맞춰 쓰고 표현·수치·길이 등의 경고를 표시합니다.")}</span>
          </div>
          <div className="st" style={{ "--i": 4 } as React.CSSProperties}>
            <b>{t("5 직접 검토하기")}</b>
            <span>{t("근거를 확인하고 고쳐 복사합니다. 게시는 직접 합니다.")}</span>
          </div>
          <div className="st" style={{ "--i": 5 } as React.CSSProperties}>
            <b>{t("6 다음 글에 반영하기")}</b>
            <span>{t("복사한 글은 문체 예시로, 검토한 지침은 다음 초안에 사용합니다.")}</span>
          </div>
        </div>
      </section>

      <section className="section" id="shots" data-reveal>
        <h2>{t("실제 화면")}</h2>
        <p className="lede">
          {t("왼쪽에서 검토할 글감을 고르고, 오른쪽에서 근거와 초안을 함께 봅니다. 경고가 남은 초안도 직접 확인하고 고칠 수 있습니다.")}
        </p>
        <div className="shots">
          <figure>
            <img
              src={shotInbox}
              alt={t("글감 목록: 검토할 초안 3개, 각 행에 저장소·종류·판단 요약과 추천점수")}
              loading="lazy"
              width={1600}
              height={1025}
            />
            <figcaption>{t("글감 · 점수순으로 검수할 것과 보류를 나눕니다")}</figcaption>
          </figure>
          <figure>
            <img
              src={shotCandidate}
              alt={t("글감 상세: 채널·언어별 초안과 X 미리보기, 게시 링크 기록, 옆에 무엇이 달라졌나·사실·한계")}
              loading="lazy"
              width={1600}
              height={1025}
            />
            <figcaption>{t("글감 상세 · 사실과 판단 이유 옆에서 초안을 복사하거나 고칩니다")}</figcaption>
          </figure>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>{t("채널")}</h2>
        <div className="channels">
          <div>
            <span>X</span>
            <span>{t("짧은 핵심 문장과 링크. 근거가 있는 숫자만.")}</span>
          </div>
          <div>
            <span>Show HN</span>
            <span>{t("제목과 첫 댓글. 확인된 사용 조건과 질문.")}</span>
          </div>
          <div>
            <span>Show GN</span>
            <span>{t("무엇을 하는지 먼저. 이유와 한계는 근거가 있을 때만.")}</span>
          </div>
          <div>
            <span>LinkedIn</span>
            <span>{t("첫 문장에 핵심을 두고 짧은 문단으로.")}</span>
          </div>
          <div>
            <span>Threads</span>
            <span>{t("짧은 본문. 채널에 맞는 말투와 길이.")}</span>
          </div>
          <div>
            <span>{t("블로그")}</span>
            <span>{t("개요만: 제목 후보와 절 구조")}</span>
          </div>
        </div>
      </section>

      <section className="section" data-reveal>
        <h2>{t("무엇을 읽는가")}</h2>
        <p className="lede">{t("프로젝트 기록과 발행한 글을 연결합니다. 세션 업로더는 로컬에서 만든 요약만 올립니다.")}</p>
        <div className="three">
          <div className="principle">
            <h3>GitHub</h3>
            <p>{t("릴리스, 머지된 PR, 마지막 릴리스 이후 커밋, 스타와 다운로드 임계, README의 한계 문구.")}</p>
          </div>
          <div className="principle">
            <h3>{t("세션 업로더")}</h3>
            <p>
              {tr("{cmd}가 Claude Code, Codex, oh-my-prompt 세션을 로컬에서 요약해 요약만 올립니다.", { cmd: <code>npm run push</code> })}
            </p>
          </div>
          <div className="principle">
            <h3>{t("npm · 블로그")}</h3>
            <p>{t("월 다운로드 추이와 발행한 글. 마일스톤을 넘으면 글감 후보가 됩니다.")}</p>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <span className="row gap-8">
          <Mark size={18} /> {t("소문 · Open330 · Apache-2.0")}
        </span>
        <span>
          <a href="https://github.com/Open330/somun">{t("소스")}</a> ·{" "}
          <a href="https://github.com/Open330/somun/blob/main/docs/spec.md">{t("기획")}</a>
        </span>
      </footer>
    </div>
  );
}
