import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { t } from "../i18n";
import "./hero-film.css";

/**
 * 랜딩 히어로 영상: "직접 쓰면"과 "소문이 쓰면"을 이어서 보여준다. 영상 파일 대신 시간 하나로 장면을 계산해 그린다.
 * 1 직접 쓴 글 — 흔한 릴리스 홍보 글과 무엇이 빠졌는지
 * 2 소문이 읽은 것 — 실제 작업물에서 가져온 근거
 * 3 소문이 쓴 초안 — 한 부분씩 쓰이며 왜 좋은지 녹색 펜으로 표시
 * 4 복사 — 점검 위치를 보여주고, 게시는 직접
 * 조작은 보는 데 필요한 만큼만: 재생·일시정지, 단계 고르기, 채널 고르기. 설명용 글은 Open330/muxa README의 기능과 사용 조건에 근거한 편집 예시다.
 * 화면 밖이거나 탭이 가려지면 멈추고, reduced-motion이면 자동 재생 없이 완성된 초안에서 시작한다.
 */

const STEPS = [
  { start: 0, end: 4800 },
  { start: 4800, end: 8000 },
  { start: 8000, end: 15200 },
  { start: 15200, end: 18000 },
];
const TOTAL = 18000;
const stepText = () => [t("말만 그럴듯하면"), t("소문이 읽은 것"), t("핵심을 남기면"), t("올리는 건 직접")];
/** 직접 쓴 글에 빠진 것. 세 채널 모두 같은 문제다. */
const missingText = () => [t("무엇을 하는지 흐림"), t("추상적인 찬사 반복"), t("사용 조건 없음")];

/** 채널 예시 글은 그 채널의 언어 그대로 둔다(화면 언어와 무관). mark는 초안 옆 녹색 메모 번호. */
const CHANNELS = [
  {
    tab: "X · EN",
    limit: 280,
    before: [
      { post: "Muxa revolutionizes developer productivity.\n" },
      { post: "Seamless workflows, powerful automation, endless possibilities.\n" },
      { post: "https://github.com/Open330/muxa" },
    ],
    after: [
      { post: "Muxa shows which tmux coding agent is waiting for input.", mark: 0 },
      { post: "\n\n" },
      { post: "muxa attend jumps to the pane that has waited longest.", mark: 1 },
      { post: "\n\n" },
      { post: "Requires tmux and a Unix-like OS.", mark: 2 },
      { post: "\nhttps://github.com/Open330/muxa" },
    ],
    notes: () => [t("무엇을 하는지 먼저"), t("실제 동작을 구체적으로"), t("사용 조건도 함께")],
  },
  {
    tab: "LinkedIn · KO",
    limit: 0,
    before: [
      { post: "개발 생산성의 새로운 시대를 여는 혁신적인 도구입니다.\n" },
      { post: "강력한 자동화와 원활한 워크플로로 개발 경험을 한 단계 높입니다.\n" },
      { post: "무한한 가능성을 지금 경험해 보세요." },
    ],
    after: [
      { post: "Muxa는 tmux의 코딩 에이전트가 입력을 기다리는지 보여줍니다.", mark: 0 },
      { post: "\n\n" },
      { post: "muxa attend 명령으로 가장 오래 기다린 패널에 이동합니다.", mark: 1 },
      { post: "\n\n" },
      { post: "기존 tmux 세션에서 사용합니다. tmux와 Unix 계열 운영체제가 필요합니다.", mark: 2 },
      { post: "\n\nhttps://github.com/Open330/muxa" },
    ],
    notes: () => [t("첫 문장에서 하는 일을"), t("실제 동작을 짧은 문장으로"), t("사용 조건과 링크를 함께")],
  },
  {
    tab: "Show HN",
    limit: 0,
    before: [
      { post: "Show HN: Muxa — the next generation of developer productivity\n\n" },
      { post: "A seamless, game-changing experience for modern developers.\n" },
      { post: "Unlock your full potential." },
    ],
    after: [
      { post: "Show HN: Muxa — see which tmux coding agent needs input", mark: 0 },
      { post: "\n\n" },
      { post: "Muxa reads agent states in existing tmux panes. muxa attend jumps to the pane that has waited longest.", mark: 1 },
      { post: "\n\n" },
      { post: "Requires tmux and a Unix-like OS.", mark: 2 },
      { post: " Which agent states would you want to see?" },
    ],
    notes: () => [t("제목에서 용도를"), t("할 수 있는 동작을"), t("사용 조건을 함께")],
  },
];
const EVIDENCE = [
  { kind: "readme", title: "muxa attend — jump to the agent that waited longest" },
  { kind: "readme", title: "Reads the agent sessions already running in tmux" },
  { kind: "readme", title: "Requires tmux and a Unix-like OS" },
];
const FACTS = ["tmux", "muxa attend", "Unix-like OS"];

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
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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
  const still = reducedMotion();
  const [time, setTime] = useState(still ? STEPS[3].start + 400 : 0);
  const [playing, setPlaying] = useState(!still);
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

  const go = useCallback((ms: number) => setTime(clamp(ms, 0, TOTAL - 1)), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.target instanceof HTMLElement && ev.target.closest("button")) return;
    if (ev.key === " " || ev.key === "k") {
      ev.preventDefault();
      toggle();
    } else if (/^[1-4]$/.test(ev.key)) go(STEPS[Number(ev.key) - 1].start);
  };

  const T = time;
  const step = stepAt(T);
  const steps = stepText();
  const missing = missingText();
  const c = CHANNELS[channel];
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
  const press = T >= 15700 && T < 15950;
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
          {CHANNELS.map((x, i) => (
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
        <span className="film-repo">Muxa · README</span>
      </div>

      <div className="film-stage" aria-live="off">
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

        <div className="film-layer" style={{ opacity: layer(T, 4800, 8000) }} aria-hidden={step !== 1}>
          <span className="film-label">{steps[1]}</span>
          <ul className="film-evidence">
            {EVIDENCE.map((e, i) => {
              const p = seg(T, 5000 + i * 320, 5400 + i * 320);
              return (
                <li key={e.kind} style={{ "--p": p } as React.CSSProperties}>
                  <span>{e.kind}</span>
                  {e.title}
                </li>
              );
            })}
          </ul>
          <div className="film-facts">
            {FACTS.map((f, i) => {
              const p = seg(T, 6200 + i * 220, 6550 + i * 220);
              return (
                <span key={f} style={{ opacity: p }}>
                  {f}
                </span>
              );
            })}
          </div>
          <p className="film-aside" style={{ opacity: seg(T, 6900, 7300) }}>
            {t("README에서 확인할 수 있는 동작과 사용 조건을 골랐습니다.")}
          </p>
        </div>

        <div className="film-layer" style={{ opacity: layer(T, 8000, TOTAL) }} aria-hidden={step < 2}>
          <div className="film-was" style={{ opacity: seg(T, 8100, 8500) }}>
            <span>{steps[0]}</span>
            <s>{beforeText.replace(/\s+/g, " ")}</s>
          </div>
          <span className="film-label is-good">{steps[2]}</span>
          <div className="film-post film-after">
            {after.map((p, i) => (
              <span key={i} className={p.mark !== undefined && doneMarks.has(p.mark) ? "good" : ""}>
                {p.mark !== undefined && doneMarks.has(p.mark) && <sup aria-hidden>{p.mark + 1}</sup>}
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
            <span className={`film-copy ${press ? "pressed" : ""}`} style={{ opacity: seg(T, 14000, 14300) }}>
              {t("복사")}
            </span>
          </div>
          <span className="film-toast" style={{ "--p": toast } as React.CSSProperties}>
            {t("복사했습니다. 게시는 직접 합니다.")}
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
        {t("README를 바탕으로 구성한 편집 예시입니다. 실제 초안은 모델과 입력에 따라 달라집니다.")}{" "}
        <a href="https://github.com/Open330/muxa#readme" target="_blank" rel="noreferrer">
          {t("원자료 보기")}
        </a>
      </p>
    </div>
  );
}
