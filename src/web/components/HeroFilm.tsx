import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { t, useLocale } from "../i18n";
import "./hero-film.css";

/**
 * 랜딩 히어로 영상: "직접 쓰면"과 "소문이 쓰면"을 이어서 보여준다. 영상 파일 대신 시간 하나로 장면을 계산해 그린다.
 * 1 직접 쓴 글 — 흔한 릴리스 홍보 글과 무엇이 빠졌는지
 * 2 소문이 읽은 것 — 실제 작업물에서 가져온 근거
 * 3 소문이 쓴 초안 — 한 부분씩 쓰이며 왜 좋은지 녹색 펜으로 표시
 * 4 근거 확인 — 원자료 링크와 함께 검토
 * 조작은 보는 데 필요한 만큼만: 재생·일시정지, 단계 고르기, 채널 고르기. 설명용 글은 Open330/muxa의 공개 PR·커밋·README에 근거한 편집 예시다.
 * 완성된 예시부터 보여주고 재생은 사용자가 고른다. 화면 밖이거나 탭이 가려지면 멈춘다.
 */

const STEPS = [
  { start: 0, end: 4800 },
  { start: 4800, end: 8000 },
  { start: 8000, end: 15200 },
  { start: 15200, end: 18000 },
];
const TOTAL = 18000;
const stepText = () => [t("말만 그럴듯하면"), t("소문이 읽은 것"), t("핵심을 남기면"), t("근거를 나란히")];
/** 직접 쓴 글에 빠진 것. 세 채널 모두 같은 문제다. */
const missingText = () => [t("무엇을 하는지 흐림"), t("추상적인 찬사 반복"), t("사용 조건 없음")];

/** 같은 근거를 채널별 길이·문단·제목 구조로 다듬은 예시. */
type ExamplePart = { post: string; mark?: number; kind?: "title" | "heading" | "command" };
const channels = (
  locale: "ko" | "en",
): {
  tab: string;
  layout: "x" | "linkedin" | "community";
  summary: string;
  limit: number;
  before: ExamplePart[];
  after: ExamplePart[];
  notes: () => string[];
}[] => [
  {
    tab: `X · ${locale.toUpperCase()}`,
    layout: "x",
    summary: t("X는 핵심과 달라지는 일을 짧게, 링크는 마지막에."),
    limit: 280,
    before: [
      { post: t("Muxa는 개발 생산성을 혁신합니다.") + "\n" },
      { post: t("원활한 작업 흐름, 강력한 자동화, 무한한 가능성.") + "\n" },
      { post: "https://github.com/Open330/muxa" },
    ],
    after: [
      { post: t("Muxa: tmux 에이전트의 입력 대기 상태 확인."), mark: 0 },
      { post: "\n\n" },
      { post: t("muxa attend로 가장 오래 기다린 패널로 이동."), mark: 1 },
      { post: "\n\n" },
      { post: t("tmux·Unix 계열 운영체제 필요."), mark: 2 },
      { post: " https://github.com/Open330/muxa" },
    ],
    notes: () => [t("핵심부터 짧게"), t("달라지는 일을 한 문장으로"), t("사용 조건과 링크로 마무리")],
  },
  {
    tab: `LinkedIn · ${locale.toUpperCase()}`,
    layout: "linkedin",
    summary: t("LinkedIn은 첫 줄에 주제를, 짧은 문단에 작업 맥락과 쓰임을."),
    limit: 0,
    before: [
      { post: t("개발 생산성의 새로운 시대를 여는 혁신적인 도구입니다.") + "\n" },
      { post: t("강력한 자동화와 원활한 워크플로로 개발 경험을 한 단계 높입니다.") + "\n" },
      { post: t("무한한 가능성을 지금 경험해 보세요.") },
    ],
    after: [
      { post: t("tmux 안의 에이전트, 지금 입력을 기다릴까요?"), mark: 0, kind: "title" },
      { post: "\n\n" },
      {
        post: t(
          "Muxa는 이미 실행 중인 tmux 세션에서 코딩 에이전트의 상태를 읽습니다. 새 터미널로 옮기지 않고 기존 작업 환경에서 확인할 수 있습니다.",
        ),
      },
      { post: "\n\n" },
      {
        post: t(
          "상태를 살펴보고, muxa attend로 가장 오래 기다린 패널에 이동합니다. 여러 에이전트를 함께 쓰는 작업에서 다음에 확인할 대상을 찾는 데 쓰입니다.",
        ),
        mark: 1,
      },
      { post: "\n\n" },
      { post: t("tmux와 Unix 계열 운영체제가 필요합니다."), mark: 2 },
      { post: "\n\nhttps://github.com/Open330/muxa" },
    ],
    notes: () => [t("접히기 전 첫 줄에 주제"), t("짧은 문단으로 작업 맥락 설명"), t("사용 조건 뒤에 링크")],
  },
  {
    tab: locale === "ko" ? "Show GN" : "Show HN",
    layout: "community",
    summary:
      locale === "ko"
        ? t("Show GN은 설명형 제목과 기능·사용 방법·조건을 나눠서.")
        : t("Show HN은 제목과 첫 댓글을 나누고, 기술 설명 뒤에 질문을."),
    limit: 0,
    before: [
      { post: `${locale === "ko" ? "Show GN" : "Show HN"}: ${t("Muxa — 개발 생산성의 새로운 시대")}\n\n` },
      { post: t("개발자를 위한 원활하고 획기적인 경험입니다.") + "\n" },
      { post: t("잠재력을 마음껏 펼쳐보세요.") },
    ],
    after:
      locale === "ko"
        ? [
            { post: t("Show GN: Muxa - tmux 코딩 에이전트의 대기 상태 확인"), mark: 0, kind: "title" },
            { post: "\n\n" },
            { post: t("기능") + "\n", kind: "heading" },
            { post: t("• 기존 tmux 세션에서 에이전트 상태 읽기") + "\n" },
            { post: t("• 입력을 기다리는 에이전트 확인"), mark: 1 },
            { post: "\n\n" },
            { post: t("사용 방법") + "\n", kind: "heading" },
            { post: "muxa attend\n", kind: "command" },
            { post: t("가장 오래 기다린 패널로 이동합니다.") },
            { post: "\n\n" },
            { post: t("사용 조건") + "\n", kind: "heading" },
            { post: t("tmux와 Unix 계열 운영체제가 필요합니다."), mark: 2 },
            { post: "\n\nhttps://github.com/Open330/muxa" },
          ]
        : [
            { post: "Show HN: Muxa - see which tmux coding agent needs input", mark: 0, kind: "title" },
            { post: "\n\n" },
            { post: t("첫 댓글") + "\n", kind: "heading" },
            { post: t("Muxa는 기존 tmux 패널의 에이전트 상태를 읽습니다. muxa attend로 가장 오래 기다린 패널에 이동합니다."), mark: 1 },
            { post: "\n\n" },
            { post: "Limitations: " + t("tmux와 Unix 계열 운영체제가 필요합니다."), mark: 2 },
            { post: "\n\n" },
            { post: t("어떤 에이전트 상태가 보이면 좋을까요?") },
          ],
    notes: () =>
      locale === "ko"
        ? [t("설명형 제목"), t("기능과 명령을 나눠 제시"), t("사용 조건을 별도 항목으로")]
        : [t("설명형 제목"), t("첫 댓글에 동작 원리"), t("한계와 열린 질문으로 마무리")],
  },
];
const evidence = () => [
  { kind: "PR #36", title: t("muxa attend — 가장 오래 기다린 에이전트로 이동"), href: "https://github.com/Open330/muxa/pull/36" },
  {
    kind: t("커밋"),
    title: t("기존 tmux 세션에서 실행 중인 에이전트 상태 읽기"),
    href: "https://github.com/Open330/muxa/commit/9c493a1320ed753dc4347398de6d4d60f466a82d",
  },
  { kind: "README", title: t("tmux와 Unix 계열 운영체제가 필요합니다."), href: "https://github.com/Open330/muxa#readme" },
];
const facts = () => ["tmux", "muxa attend", t("Unix 계열 운영체제")];

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** a~b 구간에서의 진행도(0~1), 끝을 부드럽게. */
const seg = (t: number, a: number, b: number) => {
  const p = clamp((t - a) / (b - a));
  return 1 - Math.pow(1 - p, 3);
};
/** 장면 전환: 들어올 때와 나갈 때 250ms씩 겹쳐 흐린다. */
const layer = (t: number, a: number, b: number) => (a <= 0 ? 1 : seg(t, a, a + 250)) * (b >= TOTAL ? 1 : 1 - seg(t, b - 250, b));
const stepAt = (ms: number) =>
  Math.max(
    0,
    STEPS.findIndex((s) => ms >= s.start && ms < s.end),
  );
const chars = (s: string) => [...s].length;

/** 조각들을 앞에서부터 n글자만큼 보여준다. 조각마다 다 쓰였는지도 함께 돌려준다. */
function typeOut<T extends { post: string }>(parts: T[], n: number) {
  let left = n;
  return parts.map((p) => {
    const len = chars(p.post);
    const shown = [...p.post].slice(0, Math.max(0, Math.min(len, left))).join("");
    left -= len;
    return { ...p, shown, done: len > 0 && chars(shown) === len };
  });
}

export default function HeroFilm() {
  const locale = useLocale();
  const examples = channels(locale);
  const [time, setTime] = useState(STEPS[3].start + 400);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(true);
  const [channel, setChannel] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    const onHidden = () => setVisible(!document.hidden && el.getBoundingClientRect().bottom > 0);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      setTime((x) => (x + dt) % TOTAL);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible]);

  const go = useCallback((ms: number) => {
    const selected = STEPS.find((s) => s.start === ms);
    // 단계를 고르면 그 장면의 내용을 바로 읽을 수 있게 완성된 위치에서 멈춘다.
    setPlaying(false);
    setTime(clamp(selected ? (selected === STEPS[3] ? selected.start + 400 : selected.end - 400) : ms, 0, TOTAL - 1));
  }, []);
  const toggle = useCallback(() => {
    if (!playing && time >= STEPS[3].start) setTime(0);
    setPlaying(!playing);
  }, [playing, time]);
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.target instanceof HTMLElement && ev.target.closest("button, a")) return;
    if (ev.key === " " || ev.key === "k") {
      ev.preventDefault();
      toggle();
    } else if (/^[1-4]$/.test(ev.key)) go(STEPS[Number(ev.key) - 1].start);
  };

  const T = time;
  const step = stepAt(T);
  const steps = stepText();
  const missing = missingText();
  const c = examples[channel];
  const notes = c.notes();

  // 1: 직접 쓴 글이 쓰이고, 빠진 것이 하나씩 표시된다.
  const beforeText = c.before.map((p) => p.post).join("");
  const before = typeOut(c.before, Math.round(seg(T, 200, 1900) * chars(beforeText)));
  const flagged = missing.map((_, i) => seg(T, 2300 + i * 450, 2650 + i * 450));
  // 3: 소문의 초안이 조각별로 쓰이고, 조각이 끝날 때마다 그 이유가 붙는다.
  const afterText = c.after.map((p) => p.post).join("");
  const typedN = Math.round(clamp((T - 8300) / 5200) * chars(afterText));
  const after = typeOut(c.after, typedN);
  const doneMarks = new Set(after.filter((p) => p.mark !== undefined && p.done).map((p) => p.mark));
  const lint = seg(T, 13800, 14200);
  const toast = seg(T, 15900, 16200) * (1 - seg(T, 17400, 17800));

  return (
    <div
      className="film"
      ref={root}
      role="region"
      aria-roledescription={t("영상")}
      aria-label={t("추상적인 홍보글과 핵심을 남긴 초안 비교, 18초")}
      tabIndex={0}
      onKeyDown={onKey}
    >
      <div className="film-head">
        <div className="film-tabs" role="tablist" aria-label={t("채널")}>
          {examples.map((x, i) => (
            <button
              key={x.tab}
              role="tab"
              aria-selected={i === channel}
              className={i === channel ? "on" : ""}
              onClick={() => setChannel(i)}
            >
              {x.tab}
            </button>
          ))}
        </div>
        <span className="film-repo">Muxa · GitHub</span>
      </div>

      <p className="film-channel-hint">{c.summary}</p>
      <div className={`film-stage film-stage-${c.layout}`} aria-live="off">
        <div className="film-layer" style={{ opacity: layer(T, 0, 4800) }} aria-hidden={step !== 0}>
          <span className="film-label">{steps[0]}</span>
          <div className="film-post film-before">
            {before.map((p, i) => (
              <span key={i} className={i === 1 && flagged[0] > 0.5 ? "vague" : ""}>
                {p.shown}
              </span>
            ))}
            {T < 1900 && <span className="film-caret" />}
          </div>
          <ul className="film-missing">
            {missing.map((m, i) => (
              <li key={m} style={{ "--p": flagged[i] } as React.CSSProperties}>
                <i aria-hidden>✕</i>
                {m}
              </li>
            ))}
          </ul>
        </div>

        <div className="film-layer" style={{ opacity: layer(T, 4800, 8000) }} aria-hidden={step !== 1} inert={step !== 1}>
          <span className="film-label">{steps[1]}</span>
          <p className="film-source-summary">{t("연결한 소스와 업로드한 요약에서 글감을 모읍니다.")}</p>
          <div className="film-source-types" aria-label={t("수집 소스")}>
            <span>{t("GitHub · 릴리스·PR·커밋")}</span>
            <span>{t("블로그 · RSS/Atom")}</span>
            <span>{t("npm · 다운로드 지표")}</span>
            <span>{t("개발 세션 · 요약 업로드")}</span>
          </div>
          <span className="film-evidence-label">{t("이 예시에 쓴 근거")}</span>
          <ul className="film-evidence">
            {evidence().map((e, i) => {
              const p = seg(T, 5000 + i * 320, 5400 + i * 320);
              return (
                <li key={e.title} style={{ "--p": p } as React.CSSProperties}>
                  <span>{e.kind}</span>
                  <a href={e.href} target="_blank" rel="noreferrer">
                    {e.title}
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="film-facts">
            {facts().map((f, i) => {
              const p = seg(T, 6200 + i * 220, 6550 + i * 220);
              return (
                <span key={f} style={{ opacity: p }}>
                  {f}
                </span>
              );
            })}
          </div>
          <p className="film-aside" style={{ opacity: seg(T, 6900, 7300) }}>
            {t("공개 PR·커밋·README에서 확인한 기능과 사용 조건을 골랐습니다.")}
          </p>
        </div>

        <div className="film-layer" style={{ opacity: layer(T, 8000, TOTAL) }} aria-hidden={step < 2} inert={step < 2}>
          <div className="film-was" style={{ opacity: seg(T, 8100, 8500) }}>
            <span>{steps[0]}</span>
            <s>{beforeText.replace(/\s+/g, " ")}</s>
          </div>
          <span className="film-label is-good">{steps[2]}</span>
          <div className={`film-post film-after film-${c.layout}`}>
            {after.map((p, i) => (
              <span
                key={i}
                className={`${p.mark !== undefined && doneMarks.has(p.mark) ? "good" : ""} ${p.kind ? `film-part-${p.kind}` : ""}`}
              >
                {p.shown}
              </span>
            ))}
            {T >= 8300 && typedN < chars(afterText) && <span className="film-caret" />}
          </div>
          <ol className="film-notes">
            {notes.map((n, i) => (
              <li key={n} className={doneMarks.has(i) ? "on" : ""}>
                <b>{i + 1}</b>
                {n}
              </li>
            ))}
          </ol>
          <div className="film-foot">
            <span className="film-lint" style={{ opacity: lint }}>
              {t("점검 예시")}
              {c.limit ? ` · ${chars(afterText)}/${c.limit}` : ""}
            </span>
            <a
              className="film-source"
              href="https://github.com/Open330/muxa"
              target="_blank"
              rel="noreferrer"
              style={{ opacity: seg(T, 14000, 14300) }}
            >
              {t("원자료 보기")}
            </a>
          </div>
          <span className="film-toast" style={{ "--p": toast } as React.CSSProperties}>
            {t("원자료를 보며 초안을 다듬습니다.")}
          </span>
        </div>
      </div>

      <div className="film-controls">
        <button className="film-play" onClick={toggle} aria-label={playing ? t("일시정지") : t("재생")}>
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden>
              <rect x="4" y="3" width="3" height="10" rx="1" />
              <rect x="9" y="3" width="3" height="10" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" />
            </svg>
          )}
        </button>
        <ol className="film-steps">
          {STEPS.map((s, i) => (
            <li key={s.start}>
              <button
                className={i === step ? "on" : i < step ? "past" : ""}
                aria-current={i === step ? "step" : undefined}
                onClick={() => go(s.start)}
                aria-label={t("{n}단계: {label}", { n: i + 1, label: steps[i] })}
              >
                <span className="film-step-bar">
                  <i style={{ "--p": clamp((T - s.start) / (s.end - s.start)) } as React.CSSProperties} />
                </span>
                <span className="film-step-name">{steps[i]}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <p className="film-caption">
        {t("공개 PR·커밋·README를 바탕으로 구성한 편집 예시입니다. 실제 초안은 연결한 소스와 모델에 따라 달라집니다.")}{" "}
        <a href="https://github.com/Open330/muxa" target="_blank" rel="noreferrer">
          {t("원자료 보기")}
        </a>
      </p>
    </div>
  );
}
