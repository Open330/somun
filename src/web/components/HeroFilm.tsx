import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { t } from "../i18n";
import "./hero-film.css";

/**
 * 랜딩 히어로의 "검토 책상". 영상 파일 대신 시간 t 하나로 모든 장면을 계산해 그린다.
 * 그래서 재생·일시정지·타임라인 끌기·장 건너뛰기가 어느 지점에서든 같은 화면을 낸다.
 * 관찰 → 추리기 → 판단 → 초안, 소문이 실제로 하는 순서 그대로. 숫자와 글은 Open330/muxa의 실제 값이다.
 * 가운데는 장면, 왼쪽은 편집 노트, 오른쪽은 지금 장의 큰 이름과 실측값, 아래는 편집기처럼 원자료 트랙과 장 트랙.
 * 화면 밖이거나 탭이 가려지면 멈추고, reduced-motion이면 자동 재생 없이 마지막 장면에서 시작한다.
 */

const TOTAL = 17000;
const FPS = 30;
const CHAPTERS = [{ start: 0, end: 3600, word: "OBSERVE." }, { start: 3600, end: 7600, word: "DISTILL." }, { start: 7600, end: 11200, word: "JUDGE." }, { start: 11200, end: TOTAL, word: "DRAFT." }];
/** 장 이름·편집 노트·자막. 화면 언어가 바뀔 수 있어 그릴 때마다 번역한다. */
const chapterText = () => [
  { label: t("관찰"), note: [t("많이 들어와도"), t("다 쓰진 않는다.")], caption: t("릴리스·PR·커밋을 읽습니다") },
  { label: t("추리기"), note: [t("잡일은 지우고"), t("숫자는 남긴다.")], caption: t("잡일은 버리고 바깥 독자가 볼 변화와 숫자만 남깁니다") },
  { label: t("판단"), note: [t("알릴 만한가,"), t("이유와 함께.")], caption: t("다섯 기준으로 점수를 매기고 이유를 남깁니다") },
  { label: t("초안"), note: [t("쓰는 건 소문,"), t("올리는 건 당신.")], caption: t("채널 형식에 맞춰 쓰고, 올리는 건 직접 합니다") },
];

const EVENTS = [
  { kind: "release", title: "v0.8.47", note: "attend --cycle", keep: true },
  { kind: "pr #214", title: "Jump to the pane that waited longest", note: "merged", keep: true },
  { kind: "refactor", title: "split registry module", note: "", keep: false },
  { kind: "chore", title: "bump tokio to 1.47", note: "deps", keep: false },
  { kind: "commits", title: "38 commits since v0.8.46", note: "", keep: true },
  { kind: "docs", title: "fix typo in README", note: "", keep: false },
];
const enterAt = (i: number) => 250 + i * 380;
const FACTS = ["releases=61", "commits=707", "stars=28", "limit: API may change before 1.0"];
const SCORES = [2, 2, 1, 1, 0];
const scoreLabels = () => [t("실행 가능"), t("숫자"), t("배움"), t("새로움"), t("청중")];
/** 채널 예시 글은 그 채널의 언어 그대로 둔다(화면 언어와 무관). */
const POSTS = [
  { tab: "X · EN", chars: 280, post: "I ran agents in tmux and lost track of their sessions.\n\nMuxa adds keyboard navigation and natural language automation rules to orchestrate agent sessions.\n\n61 releases, still 0.x: https://github.com/Open330/muxa" },
  { tab: "Show HN", chars: 0, post: "Show HN: Muxa – keep track of coding agents running in tmux\n\nAuthor here. I run several agents side by side and kept missing the one waiting on a permission prompt. Muxa reads each pane's state and jumps to the one that has waited longest.\n\nStill 0.x: the API may change before 1.0. No Windows support." },
  { tab: "LinkedIn · KO", chars: 0, post: "에이전트가 멈춘 걸 30분 뒤에 알았습니다.\n\n코딩 에이전트를 tmux 창마다 하나씩 띄워 놓고 일한 지 반년쯤 됐습니다. 문제는 늘 같았습니다.\n\n그래서 muxa를 만들었습니다. 4월에 시작해 릴리스 61회를 냈습니다. 아직 Windows는 없습니다." },
];

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** a~b 구간에서의 진행도(0~1), 끝을 부드럽게. */
const seg = (t: number, a: number, b: number) => { const p = clamp((t - a) / (b - a)); return 1 - Math.pow(1 - p, 3); };
/** 장면 전환: 들어올 때와 나갈 때 250ms씩 겹쳐 흐린다. */
const layer = (t: number, a: number, b: number) => (a <= 0 ? 1 : seg(t, a, a + 250)) * (b >= TOTAL ? 1 : 1 - seg(t, b - 250, b));
const clock = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;
const timecode = (ms: number) => `00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`;
const pct = (ms: number) => `${(ms / TOTAL) * 100}%`;
const chapterAt = (ms: number) => Math.max(0, CHAPTERS.findIndex((c) => ms >= c.start && ms < c.end));
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function HeroFilm() {
  const still = reducedMotion();
  const [time, setTime] = useState(still ? TOTAL - 1 : 0);
  const [playing, setPlaying] = useState(!still);
  const [visible, setVisible] = useState(true);
  /** 초안 장면에서 사용자가 고른 채널. 고르면 멈추고 그 글 전체를 보여준다. */
  const [picked, setPicked] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ resume: boolean } | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    const onHidden = () => setVisible(!document.hidden && el.getBoundingClientRect().bottom > 0);
    document.addEventListener("visibilitychange", onHidden);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", onHidden); };
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last); last = now;
      setTime((x) => (x + dt) % TOTAL);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible]);

  const seek = useCallback((ms: number) => { setTime(clamp(ms, 0, TOTAL - 1)); setPicked(null); }, []);
  const toggle = useCallback(() => { setPicked(null); setPlaying((p) => !p); }, []);
  const fromPointer = (ev: React.PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    seek(((ev.clientX - r.left) / r.width) * TOTAL);
  };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.target instanceof HTMLElement && ev.target.closest(".film-tabs")) return;
    if (ev.key === " " || ev.key === "k") { ev.preventDefault(); toggle(); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); seek(time + 2000); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); seek(time - 2000); }
    else if (/^[1-4]$/.test(ev.key)) seek(CHAPTERS[Number(ev.key) - 1].start);
  };

  const T = time;
  const ch = chapterAt(T);
  const text = chapterText();
  const labels = scoreLabels();

  // 1·2장: 들어온 사건 목록. 추리기에서 잡일이 지워지고 남은 것에서 사실이 나온다.
  const rows = EVENTS.map((e, i) => {
    const enter = seg(T, enterAt(i), enterAt(i) + 420);
    const strike = e.keep ? 0 : seg(T, 3900 + i * 60, 4400 + i * 60);
    const collapse = e.keep ? 0 : seg(T, 4600, 5200);
    const mark = e.keep ? seg(T, 4400, 4900) : 0;
    return { ...e, enter, strike, collapse, mark };
  });
  const factsShown = FACTS.filter((_, i) => T >= 5500 + i * 260).length;
  // 3장: 기준마다 두 칸. 채워진 칸을 세어 총점을 올린다.
  let total = 0;
  const scores = SCORES.map((score, i) => {
    const dots = [0, 1].map((j) => { const on = j < score ? seg(T, 7950 + i * 380 + j * 140, 8200 + i * 380 + j * 140) : 0; if (on > 0.5) total += 1; return on; });
    return { label: labels[i], dots, enter: seg(T, 7750 + i * 120, 8150 + i * 120) };
  });
  const reason = t("릴리스 61회라는 숫자가 있고, 바로 설치해 볼 수 있습니다. 청중은 아직 좁습니다.");
  const reasonShown = [...reason].slice(0, Math.round(seg(T, 9800, 10800) * [...reason].length)).join("");
  // 4장: X 글을 한 글자씩 쓰고, 점검을 통과하면 복사한다.
  const tab = picked ?? 0;
  const post = POSTS[tab].post;
  const typed = picked !== null ? post : [...post].slice(0, Math.round(clamp((T - 11500) / 2800) * [...post].length)).join("");
  const count = [...typed].length;
  const lint = picked !== null ? 1 : seg(T, 14400, 14700);
  const press = T >= 14900 && T < 15150 && picked === null;
  const toast = picked === null ? seg(T, 15100, 15400) * (1 - seg(T, 16500, 16900)) : 0;

  // 오른쪽 실측값: 지금 장에서 무엇이 얼마나 남았는지.
  const kept = EVENTS.filter((e, i) => T >= enterAt(i) && (e.keep || T < 4600)).length;
  const metric = [
    [t("들어온 것"), `${EVENTS.filter((_, i) => T >= enterAt(i)).length}`],
    [t("남긴 것"), `${kept} / ${EVENTS.length}`],
    [t("사실"), `${factsShown}`],
    [t("점수"), `${total}/10`],
    [t("글자"), POSTS[tab].chars ? `${count}/${POSTS[tab].chars}` : `${count}`],
  ];
  const shownMetrics = [[0, 1], [1, 2], [3], [4]][ch].map((k) => metric[k]);

  return (
    <div className="film" ref={root} role="region" aria-roledescription={t("영상")} aria-label={t("소문이 일하는 방식, 17초")} tabIndex={0} onKeyDown={onKey}>
      <div className="film-bar-top">
        <span><i className="film-dot" aria-hidden /> SOMUN / REVIEW DESK</span>
        <span className="film-wide">{t("실제 값 — Open330/muxa의 릴리스와 커밋")}</span>
        <span className="film-frame" aria-hidden>FRAME <b>{String(Math.floor((T / 1000) * FPS)).padStart(4, "0")}</b></span>
      </div>

      <div className="film-desk">
        <aside className="film-notes" aria-hidden>
          <span className="film-tiny">EDITOR'S NOTE</span>
          <p className="film-note-big" key={ch}>{text[ch].note[0]}<br /><em>{text[ch].note[1]}</em></p>
          <span className="film-rule" />
          <span className="film-note-small">{text[ch].caption}</span>
          <span className="film-annot">{t("↳ 아래 타임라인을 끌어 보세요")}</span>
        </aside>

        <div className="film-rig">
          <span className="film-rig-label"><span>LIVE DRAFT</span><span>Open330/muxa · v0.8.47</span></span>
          <div className="film-stage" aria-live="off">
            <div className="film-layer" style={{ opacity: layer(T, 0, 7600) }} aria-hidden={ch > 1}>
              <ul className="film-events">
                {rows.map((r) => (
                  <li key={r.title} className={r.mark > 0 ? "kept" : ""} style={{ opacity: r.enter * (1 - r.collapse), transform: `translateY(${(1 - r.enter) * 10}px)`, maxHeight: `${44 * (1 - r.collapse)}px`, marginBottom: `${6 * (1 - r.collapse)}px`, "--mark": r.mark } as React.CSSProperties}>
                    <span className="film-kind">{r.kind}</span>
                    <span className="film-title"><span>{r.title}</span><i style={{ transform: `scaleX(${r.strike})` }} /></span>
                    {r.note && <span className="film-note">{r.note}</span>}
                  </li>
                ))}
              </ul>
              <div className="film-facts">
                {FACTS.map((f, i) => { const p = seg(T, 5300 + i * 260, 5700 + i * 260); return <span key={f} style={{ opacity: p, transform: `translateY(${(1 - p) * 6}px)` }}>{f}</span>; })}
              </div>
            </div>

            <div className="film-layer" style={{ opacity: layer(T, 7600, 11200) }} aria-hidden={ch !== 2}>
              <div className="film-judge">
                <div className="film-scores">
                  {scores.map((s) => (
                    <div key={s.label} className="film-score" style={{ opacity: s.enter }}>
                      <span>{s.label}</span>
                      <span className="film-dots">{s.dots.map((d, j) => <i key={j} style={{ "--on": d } as React.CSSProperties} />)}</span>
                    </div>
                  ))}
                </div>
                <div className="film-total"><b>{total}</b><span>/10</span></div>
              </div>
              <p className="film-reason">{reasonShown}<span className="film-caret" style={{ opacity: T > 9800 && T < 10900 ? 1 : 0 }} /></p>
              <span className="film-verdict" style={{ opacity: seg(T, 10700, 11000) }}>{t("초안 쓸 만함 · 4점 이상")}</span>
            </div>

            <div className="film-layer" style={{ opacity: layer(T, 11200, TOTAL) }} aria-hidden={ch !== 3}>
              <div className="film-tabs" role="tablist" aria-label={t("채널")}>
                {POSTS.map((p, i) => <button key={p.tab} role="tab" aria-selected={i === tab} tabIndex={ch === 3 ? 0 : -1} className={i === tab ? "on" : ""} onClick={() => { setPicked(i); setPlaying(false); }}>{p.tab}</button>)}
              </div>
              <div className="film-post">{typed}{picked === null && T < 14300 && <span className="film-caret" />}</div>
              <div className="film-foot">
                <span className="film-lint" style={{ opacity: lint }}>{t("린트 통과")}{POSTS[tab].chars ? ` · ${count}/${POSTS[tab].chars}` : ""}</span>
                <span className={`film-copy ${press ? "pressed" : ""}`}>{t("복사")}</span>
              </div>
              <span className="film-toast" style={{ opacity: toast, transform: `translate(-50%, ${(1 - toast) * 8}px)` }}>{t("복사했습니다. 게시는 직접 합니다.")}</span>
            </div>
          </div>
          <p className="film-caption">{text[ch].caption}</p>
        </div>

        <aside className="film-index" aria-hidden>
          <span className="film-tiny">CUT / <b>{String(ch + 1).padStart(2, "0")}</b></span>
          <strong className="film-word" key={ch}>{CHAPTERS[ch].word}</strong>
          <span className="film-word-ko">{text[ch].label}</span>
          <dl className="film-metrics">{shownMetrics.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </aside>
      </div>

      <div className="film-transport">
        <button className="film-play" onClick={toggle} aria-label={playing ? t("일시정지") : t("재생")}>
          {playing ? <svg viewBox="0 0 16 16" aria-hidden><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg> : <svg viewBox="0 0 16 16" aria-hidden><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" /></svg>}
        </button>
        <output className="film-tc">{timecode(T)}</output>
        <span className="film-tc-total">/ {timecode(TOTAL)}</span>
        <span className="film-hint">{t("타임라인을 끌어 보세요")} <span aria-hidden>↔</span></span>
        <span className="film-wide film-muted">NO AUDIO · REAL DATA</span>
      </div>

      <div className="film-timeline">
      <div
        className="film-lanes" ref={track} role="slider" tabIndex={-1} aria-label={t("재생 위치")} aria-valuemin={0} aria-valuemax={Math.round(TOTAL / 1000)} aria-valuenow={Math.floor(T / 1000)} aria-valuetext={`${clock(T)} · ${text[ch].label}`}
        onPointerDown={(ev) => { if ((ev.target as HTMLElement).closest("button")) return; ev.currentTarget.setPointerCapture(ev.pointerId); dragging.current = { resume: playing }; setPlaying(false); fromPointer(ev); }}
        onPointerMove={(ev) => { if (dragging.current) fromPointer(ev); }}
        onPointerUp={() => { if (dragging.current?.resume) setPlaying(true); dragging.current = null; }}
        onPointerCancel={() => { dragging.current = null; }}
      >
        <div className="film-ruler" aria-hidden>{[0, 2, 4, 6, 8, 10, 12, 14, 16].map((s) => <span key={s} style={{ left: pct(s * 1000) }}>{`00:${String(s).padStart(2, "0")}`}</span>)}</div>
        <div className="film-track film-track-src" aria-hidden>
          <span className="film-track-name">SOURCE</span>
          {EVENTS.map((e, i) => <span key={e.title} className={`film-clip ${e.keep ? "" : "noise"} ${!e.keep && T >= 4400 ? "cut" : ""}`} style={{ left: pct(enterAt(i)), width: pct(e.keep ? 7600 - enterAt(i) : 4400 - enterAt(i)), top: `${i * 7 + 4}px` }}>{e.kind}</span>)}
        </div>
        <div className="film-track film-track-cut">
          <span className="film-track-name" aria-hidden>CUT</span>
          {CHAPTERS.map((c, i) => (
            <button key={c.start} className={`film-chapter ${i === ch ? "on" : ""}`} style={{ left: pct(c.start), width: `calc(${pct(c.end - c.start)} - 3px)` }} aria-current={i === ch ? "step" : undefined} onClick={() => seek(c.start)} aria-label={t("{n}장: {label}", { n: i + 1, label: text[i].label })}>
              <b>{String(i + 1).padStart(2, "0")}</b> {text[i].label}
            </button>
          ))}
        </div>
        <div className="film-playhead" style={{ left: pct(T) }} aria-hidden><i /></div>
      </div>
      </div>
    </div>
  );
}
