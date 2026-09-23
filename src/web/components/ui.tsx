import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Candidate, Judgment } from "@shared/types";

export const CHANNEL_LABEL: Record<string, string> = { x: "X", threads: "Threads", linkedin: "LinkedIn", show_hn: "Show HN", show_gn: "Show GN", blog: "블로그 개요" };

/** 채널 아이콘. 단색 SVG. HN·GN은 사이트 색 사각형 안에 글자. */
export function ChannelIcon({ channel, size = 16 }: { channel: string; size?: number }) {
  const s = { width: size, height: size, flex: "none" as const };
  switch (channel) {
    case "x": return <svg style={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.2 22H3l7.3-8.3L2.5 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.3 3.9H5.5L17.8 20z" /></svg>;
    case "threads": return <svg style={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12.2 22c-2.9 0-5.1-1-6.6-2.9C4.3 17.4 3.6 15.1 3.6 12c0-3.1.7-5.4 2-7.1C7.1 3 9.3 2 12.2 2c2.2 0 4.1.6 5.5 1.8 1.2 1 2 2.3 2.4 3.9l-2 .5c-.6-2.5-2.6-4.1-5.9-4.1-2.2 0-3.9.7-5 2.1-1 1.3-1.5 3.3-1.5 5.8s.5 4.5 1.5 5.8c1.1 1.4 2.8 2.1 5 2.1 2 0 3.4-.5 4.4-1.5.7-.7 1-1.5 1-2.4 0-.8-.3-1.5-.9-2-.5-.4-1.2-.7-2-.9-.1 1.3-.5 2.4-1.2 3.1-.8.9-1.9 1.3-3.2 1.3-1.1 0-2-.3-2.7-.9-.8-.7-1.2-1.6-1.2-2.6 0-1.1.5-2 1.4-2.7.9-.6 2.1-1 3.6-1 .6 0 1.2 0 1.8.1-.1-.7-.3-1.2-.7-1.6-.4-.4-1-.6-1.8-.6-1.1 0-2 .4-2.6 1.1l-1.6-1.1c1-1.3 2.4-2 4.2-2 1.4 0 2.5.4 3.3 1.2.8.8 1.2 1.9 1.3 3.3 1.4.3 2.5.8 3.3 1.6 1 .9 1.5 2.1 1.5 3.6 0 1.5-.6 2.9-1.7 4-1.3 1.3-3.3 2-5.7 2zm-.3-8.6c-1 0-1.8.2-2.3.6-.4.3-.6.6-.6 1 0 .4.2.7.5 1 .4.3.9.4 1.5.4.8 0 1.4-.2 1.8-.7.4-.5.7-1.2.7-2.2-.5-.1-1-.1-1.6-.1z" /></svg>;
    case "linkedin": return <svg style={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.4 2H3.6C2.7 2 2 2.7 2 3.6v16.8c0 .9.7 1.6 1.6 1.6h16.8c.9 0 1.6-.7 1.6-1.6V3.6c0-.9-.7-1.6-1.6-1.6zM8 19H5V9.5h3V19zM6.5 8.2a1.7 1.7 0 1 1 0-3.5 1.7 1.7 0 0 1 0 3.5zM19 19h-3v-4.6c0-1.1 0-2.5-1.5-2.5S12.7 13 12.7 14.3V19h-3V9.5h2.9v1.3c.4-.8 1.4-1.5 2.8-1.5 3 0 3.6 2 3.6 4.6V19z" /></svg>;
    case "show_hn": return <svg style={s} viewBox="0 0 24 24" aria-hidden><rect width="24" height="24" rx="4" fill="#ff6600" /><path d="M7 5h2.3l2.7 5.6L14.7 5H17l-4 7.5V19h-2v-6.5L7 5z" fill="#fff" /></svg>;
    case "show_gn": return <svg style={s} viewBox="0 0 24 24" aria-hidden><rect width="24" height="24" rx="4" fill="#2e8b57" /><path d="M12.5 5C8.9 5 6.5 7.9 6.5 12s2.4 7 6 7c2 0 3.6-.8 4.7-2.2v-5.3h-5v2.2h2.6v2.1c-.5.5-1.3.8-2.3.8-2.2 0-3.6-1.9-3.6-4.6s1.4-4.6 3.6-4.6c1.2 0 2.1.5 2.8 1.4l1.7-1.5C15.9 5.8 14.4 5 12.5 5z" fill="#fff" /></svg>;
    default: return <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12h7M9 16h7" /></svg>;
  }
}
/** "X · EN" 처럼 채널과 언어를 함께. 고정 언어 채널은 채널 이름만. */
export function targetLabel(channel: string, lang?: string, fixed?: boolean): string {
  const base = CHANNEL_LABEL[channel] ?? channel;
  return lang && !fixed ? `${base} · ${lang.toUpperCase()}` : base;
}
export const TYPE_LABEL: Record<string, string> = { release: "릴리스", "new-repo": "새 저장소", milestone: "마일스톤", blog: "블로그", "in-progress": "진행 중" };
export const CRITERIA: [keyof Judgment["scores"], string, string][] = [
  ["runnable", "실행 가능", "링크 눌러 1분 안에 써볼 수 있는가"],
  ["numbers", "숫자", "측정치, 전후 비교가 있는가"],
  ["lesson", "배움", "실패, 되돌린 결정, 의외의 사실이 있는가"],
  ["novelty", "새로움", "최근 30일 발행물과 겹치지 않는가"],
  ["audience", "청중", "누가 어느 채널에서 관심 가질지 말할 수 있는가"],
];
export const REASONS = [["wrong_facts", "사실이 틀림"], ["voice", "문체가 아님"], ["wrong_channel", "채널이 안 맞음"], ["not_yet", "아직 이름"], ["not_worth", "글감 아님"], ["other", "기타"]] as const;

export function fmtDate(ts: number): string {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}
export function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** 후보의 한 가지 상태. 배지 하나로 끝낸다. */
export type Stage = { key: "review" | "fresh" | "working" | "deferred" | "ask" | "published" | "dropped"; label: string; tone: "ok" | "warn" | "" | "bad"; busy?: boolean };
export function stageOf(c: Pick<Candidate, "status" | "evidence" | "latestJudgmentId"> & { judgment?: Judgment | null }): Stage {
  if (c.status === "dropped") return { key: "dropped", label: "버림", tone: "bad" };
  if (c.status === "published") return { key: "published", label: "발행됨", tone: "ok" };
  if (c.status === "drafted") return { key: "review", label: "검수 대기", tone: "ok" };
  if (c.status === "deferred") return { key: "deferred", label: "보류", tone: "warn" };
  // 수동 모드에서는 새 후보가 판단 없이 쌓인다. 판단이 시작되면 highlights가 생기며 "처리 중"으로 넘어간다.
  if (!c.evidence.highlightsAt) return { key: "fresh", label: "새 글감", tone: "" };
  if (!c.latestJudgmentId) return { key: "working", label: "판단 결과 없음", tone: "warn" };
  const d = c.judgment?.overriddenDecision ?? c.judgment?.decision;
  if (d === "ask") return { key: "ask", label: "추가 근거 필요", tone: "" };
  return { key: "working", label: "초안 없음", tone: "warn" };
}
export function StageChip({ stage }: { stage: Stage }) {
  return <span className={`badge ${stage.tone}`}>{stage.busy && <i className="dot" />}{stage.label}</span>;
}

/** 5항목 미터. 각 항목 0~2. */
export function Meter({ scores, compact }: { scores: Judgment["scores"]; compact?: boolean }) {
  return (
    <div className={`meter ${compact ? "compact" : ""}`}>
      {CRITERIA.map(([k, label, hint]) => (
        <div key={k} className="meter-item" title={hint}>
          <span className="meter-label">{label}</span>
          <span className="meter-bar"><i className={scores[k] >= 1 ? "on" : ""} /><i className={scores[k] >= 2 ? "on" : ""} /></span>
        </div>
      ))}
    </div>
  );
}

export function LintBadges({ lint }: { lint: { rule: string; ok: boolean; detail?: string }[] }) {
  if (!lint.length) return <span className="badge outline">문장 점검 전</span>;
  const bad = lint.filter((l) => !l.ok);
  if (bad.length === 0) return <span className="badge ok" title="길이·금지 표현 등 자동 규칙을 통과했습니다. 사실 확인은 별도로 필요합니다.">형식 점검 통과</span>;
  const label: Record<string, string> = { banned_phrases: "금지 표현", no_emoji_bullets: "이모지 목록", has_number: "숫자 없음", has_limitation: "한계 없음", has_number_or_limit: "숫자·한계 없음", has_link: "링크 없음", no_exclamation: "감탄부호", length: "길이 초과", title_length: "제목 길이", no_vote_request: "투표 요청", no_placeholder: "빈 숫자", repo_name: "이름 왜곡", no_invented_limit: "한계 확인", numbers_need_review: "수치 확인" };
  return <>{bad.map((l) => <span key={l.rule} className="badge bad" title={l.detail}>{label[l.rule] ?? l.rule}{l.detail && l.rule === "length" ? ` ${l.detail}` : ""}</span>)}</>;
}

export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values), span = Math.max(1, max - min);
  return <div className="spark">{values.map((v, i) => <i key={i} style={{ height: `${6 + ((v - min) / span) * 30}px` }} title={String(v)} />)}</div>;
}

/** 발행 전후 스타 추이. 한 축, 발행 시점 세로선, 기준선(발행 전 마지막 값) 점선. */
export function MetricChart({ series, publishedAt, baseline }: { series: { at: number; stars: number }[]; publishedAt: number; baseline?: number }) {
  if (series.length < 2) return <div className="chart empty-chart tiny muted">지표 2개 이상 쌓이면 그래프가 보입니다</div>;
  const W = 260, H = 72, px = 6, py = 8;
  const xs = series.map((s) => s.at), ys = series.map((s) => s.stars);
  const x0 = Math.min(...xs, publishedAt), x1 = Math.max(...xs, publishedAt);
  const y0 = Math.min(...ys, baseline ?? Infinity), y1 = Math.max(...ys, baseline ?? -Infinity);
  const sx = (x: number) => px + ((x - x0) / Math.max(1, x1 - x0)) * (W - px * 2);
  const sy = (y: number) => H - py - ((y - y0) / Math.max(1, y1 - y0)) * (H - py * 2);
  const d = series.map((s, i) => `${i ? "L" : "M"}${sx(s.at).toFixed(1)},${sy(s.stars).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`스타 ${ys[0]}에서 ${last.stars}`}>
      {baseline !== undefined && <line x1={px} x2={W - px} y1={sy(baseline)} y2={sy(baseline)} className="base" />}
      <line x1={sx(publishedAt)} x2={sx(publishedAt)} y1={py / 2} y2={H - py / 2} className="pub-line" />
      <path d={d} className="line" />
      <circle cx={sx(last.at)} cy={sy(last.stars)} r={3} className="dot" />
      <text x={W - px} y={sy(last.stars) - 6} textAnchor="end" className="lbl">{last.stars}</text>
      {baseline !== undefined && baseline !== last.stars && <text x={px} y={sy(baseline) + (sy(baseline) < H / 2 ? 12 : -5)} className="lbl muted">{baseline}</text>}
    </svg>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="stack" role="status" aria-label="불러오는 중">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" />)}</div>;
}

/** 간단한 오버플로 메뉴 (⋯). */
/** 더 보기 메뉴. 열면 첫 항목에 초점, 위·아래 화살표로 이동, Esc로 닫고 버튼으로 초점을 돌린다. */
export function Menu({ items }: { items: { label: string; onClick: () => unknown; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); trigger.current?.focus(); } };
    window.addEventListener("click", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  const move = (event: ReactKeyboardEvent) => {
    // Tab은 메뉴를 닫고 초점을 원래 흐름으로 보낸다. 화살표·Home·End는 항목 사이를 옮긴다.
    if (event.key === "Tab") { setOpen(false); return; }
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % buttons.length : event.key === "ArrowUp" ? (at - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button ref={trigger} disabled={busy} aria-haspopup="menu" aria-expanded={open} className="ghost sm" aria-label="더 보기" onClick={() => setOpen((o) => !o)}>⋯</button>
      {error && <span className="menu-error" role="alert">{error}</span>}
      {open && <div className="menu" role="menu" ref={list} onKeyDown={move}>{items.map((it) => <button key={it.label} role="menuitem" className={`menu-item ${it.danger ? "danger" : ""}`} onClick={async () => { setOpen(false); setError(null); setBusy(true); try { await it.onClick(); } catch (err) { setError(`작업을 완료하지 못했습니다. ${(err as Error).message}`); } finally { setBusy(false); } }}>{it.label}</button>)}</div>}
    </span>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((message: string) => {
    clearTimeout(timer.current);
    setMsg(message);
    timer.current = setTimeout(() => setMsg(null), 4500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [msg, show];
}

export function ErrorState({ title = "화면을 불러오지 못했습니다", message, onRetry }: { title?: string; message: string; onRetry: () => void }) {
  return <div className="state-panel error-state" role="alert"><span className="state-symbol" aria-hidden>!</span><h2>{title}</h2><p>연결 상태를 확인하고 다시 시도해 주세요. 계속되면 잠시 후 다시 접속해 주세요.</p><details><summary>오류 내용</summary><p>{message}</p></details><button onClick={onRetry}>다시 시도</button></div>;
}

export function Section({ title, count, children, hint }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="tri">
      <div className="tri-head"><h2>{title}{count !== undefined && <span className="tri-count">{count}</span>}</h2>{hint && <span className="tiny muted">{hint}</span>}</div>
      {children}
    </section>
  );
}
