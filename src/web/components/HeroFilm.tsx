import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { t } from "../i18n";
import "./hero-film.css";

/**
 * 랜딩 히어로 영상: "직접 쓰면"과 "소문이 쓰면"을 이어서 보여준다. 영상 파일 대신 시간 하나로 장면을 계산해 그린다.
 * 1 직접 쓴 글 — 흔한 릴리스 홍보 글과 무엇이 빠졌는지
 * 2 소문이 읽은 것 — 실제 작업물에서 가져온 근거
 * 3 소문이 쓴 초안 — 한 부분씩 쓰이며 왜 좋은지 녹색 펜으로 표시
 * 4 복사 — 점검을 통과하면 복사하고, 게시는 직접
 * 조작은 보는 데 필요한 만큼만: 재생·일시정지, 단계 고르기, 채널 고르기. 숫자와 글은 Open330/muxa의 실제 값이다.
 * 화면 밖이거나 탭이 가려지면 멈추고, reduced-motion이면 자동 재생 없이 완성된 초안에서 시작한다.
 */

const STEPS = [
  { start: 0, end: 4800 },
  { start: 4800, end: 8000 },
  { start: 8000, end: 15200 },
  { start: 15200, end: 18000 },
];
const TOTAL = 18000;
const stepText = () => [t("직접 쓰면"), t("소문이 읽은 것"), t("소문이 쓰면"), t("올리는 건 직접")];
/** 직접 쓴 글에 빠진 것. 세 채널 모두 같은 문제다. */
const missingText = () => [t("무엇이 바뀌었는지 없음"), t("읽는 사람이 얻는 것 없음"), t("근거 있는 숫자 없음")];

/** 채널 예시 글은 그 채널의 언어 그대로 둔다(화면 언어와 무관). mark는 초안 옆 녹색 메모 번호. */
const CHANNELS = [
  {
    tab: "X · EN",
    limit: 280,
    before: [
      { post: "Muxa v0.8.47 is out! 🎉\n" },
      { post: "Bug fixes and performance improvements.\n" },
      { post: "Check it out 👉 github.com/Open330/muxa" },
    ],
    after: [
      { post: "I ran agents in tmux and lost track of their sessions.", mark: 0 },
      { post: "\n\n" },
      { post: "Muxa adds keyboard navigation and natural language automation rules to orchestrate agent sessions.", mark: 1 },
      { post: "\n\n" },
      { post: "61 releases, still 0.x", mark: 2 },
      { post: ": https://github.com/Open330/muxa" },
    ],
    notes: () => [t("겪은 문제로 시작"), t("무엇을 하는지 한 문장"), t("근거 있는 숫자와 한계")],
  },
  {
    tab: "LinkedIn · KO",
    limit: 0,
    before: [
      { post: "muxa v0.8.47을 출시했습니다! 🎉\n" },
      { post: "여러 버그를 수정하고 성능을 개선했습니다.\n" },
      { post: "많은 관심 부탁드립니다 🙏" },
    ],
    after: [
      { post: "에이전트가 멈춘 걸 30분 뒤에 알았습니다.", mark: 0 },
      { post: "\n\n" },
      { post: "코딩 에이전트를 tmux 창마다 하나씩 띄워 놓고 일한 지 반년쯤 됐습니다. 문제는 늘 같았습니다.", mark: 1 },
      { post: "\n\n" },
      { post: "그래서 muxa를 만들었습니다. 4월에 시작해 릴리스 61회를 냈습니다.", mark: 2 },
      { post: " 아직 Windows는 없습니다." },
    ],
    notes: () => [t("접힘선 위에서 멈추게 하는 첫 문장"), t("겪은 문제를 구체적으로"), t("근거 있는 숫자와 한계")],
  },
  {
    tab: "Show HN",
    limit: 0,
    before: [
      { post: "Show HN: Muxa v0.8.47\n\n" },
      { post: "New release with bug fixes and improvements.\n" },
      { post: "Feedback welcome!" },
    ],
    after: [
      { post: "Show HN: Muxa – keep track of coding agents running in tmux", mark: 0 },
      { post: "\n\n" },
      {
        post: "Author here. I run several agents side by side and kept missing the one waiting on a permission prompt. Muxa reads each pane's state and jumps to the one that has waited longest.",
        mark: 1,
      },
      { post: "\n\n" },
      { post: "Still 0.x: the API may change before 1.0. No Windows support.", mark: 2 },
    ],
    notes: () => [t("제목에 무엇인지"), t("작성자가 겪은 문제와 해결"), t("한계를 먼저 말함")],
  },
];
const EVIDENCE = [
  { kind: "release", title: "v0.8.47 · attend --cycle" },
  { kind: "pr #214", title: "Jump to the pane that waited longest" },
  { kind: "readme", title: "Limitations: API may change before 1.0" },
];
const FACTS = ["releases=61", "commits=707", "stars=28"];

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
      aria-label={t("직접 쓴 글과 소문이 쓴 초안 비교, 18초")}
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
        <span className="film-repo">Open330/muxa v0.8.47</span>
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
            {t("잡일 커밋과 리팩터링은 버리고, 바깥 독자가 볼 변화와 숫자만 남겼습니다.")}
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
              {t("린트 통과")}
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
    </div>
  );
}
